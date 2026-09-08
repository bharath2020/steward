import { listWorkflows, prepareRun, startPreparedRun, PreparationError } from "../run-preparation";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readUiAsset, renderDashboard } from "./templates";
import { startWorkflow, submitAgentRecovery, submitHumanAnswer } from "../client";
import { DASHBOARD_PORT } from "../config";
import type { AgentProvider, AgentRecoveryAction, JsonValue, RunState, WorkflowDefinition } from "../contracts";
import { loadInitialInput, loadWorkflow } from "../definition";
import { readAgentMessages, readEvents, runDirectory, runtimeRoot } from "../store";
import { createWorkflowDraft, type AuthoringRunner } from "../authoring";

const workflowPath = process.env.YAMLFLOW_WORKFLOW ?? "workflows/product-launch.yaml";
const inputPath = process.env.YAMLFLOW_INPUT ?? "examples/product-input.json";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function listRunStates(): Promise<RunState[]> {
  try {
    const entries = await readdir(join(runtimeRoot, "runs"), { withFileTypes: true });
    const states = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await readJson<RunState>(join(runtimeRoot, "runs", entry.name, "state.json"));
          } catch {
            return undefined;
          }
        }),
    );
    return states
      .filter((state): state is RunState => Boolean(state))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function snapshot(runId?: string): Promise<Record<string, unknown>> {
  const runs = await listRunStates();
  const selected = runId ? runs.find((run) => run.runId === runId) : runs[0];
  if (!selected) return { runs: [], run: null };
  const directory = runDirectory(selected.runId);
  const [definition, initialInput, events] = await Promise.all([
    readJson<WorkflowDefinition>(join(directory, "definition.json")),
    readJson<JsonValue>(join(directory, "input.json")),
    readEvents(selected.runId),
  ]);
  const agentMessages = Object.fromEntries(await Promise.all(
    Object.keys(selected.nodes).map(async (nodeId) => [nodeId, await readAgentMessages(selected.runId, nodeId)] as const),
  ));
  return {
    runs: runs.map((run) => ({
      runId: run.runId,
      status: run.status,
      mode: run.mode,
      updatedAt: run.updatedAt,
      completedCount: run.completedCount,
      totalCount: run.totalCount,
    })),
    run: selected,
    definition,
    initialInput,
    events,
    agentMessages,
    durablePath: directory,
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage, maximumBytes = 1_000_000): Promise<Record<string, unknown>> {
  let source = "";
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maximumBytes) throw new Error(`request body exceeds ${maximumBytes} bytes`);
    source += chunk.toString();
  }
  const value: unknown = source ? JSON.parse(source) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value as Record<string, unknown>;
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  if (pathname === "/" || pathname === "/index.html") {
    const page = await renderDashboard();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
    return;
  }
  const asset = await readUiAsset(pathname);
  if (!asset) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": asset.contentType, "cache-control": "no-store" });
  response.end(asset.body);
}

function isLocalAuthoringRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const value = new URL(origin);
    return (value.hostname === "127.0.0.1" || value.hostname === "localhost")
      && Number(value.port || (value.protocol === "https:" ? 443 : 80)) === DASHBOARD_PORT;
  } catch {
    return false;
  }
}

/** Browser start requests must come from this loopback Console. Local JSON CLI
 * clients may omit Origin; a prompt or cross-site form cannot grant writes. */
function isLocalRunStart(request: IncomingMessage): boolean {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return false;
  try {
    const host = new URL(`http://${request.headers.host}`);
    if (!["127.0.0.1", "localhost"].includes(host.hostname)
      || host.username || host.password || host.pathname !== "/"
      || Number(host.port || 80) !== request.socket.localPort) return false;
    return !request.headers.origin || new URL(request.headers.origin).origin === host.origin;
  } catch {
    return false;
  }
}

async function handler(request: IncomingMessage, response: ServerResponse, authoringRunner?: AuthoringRunner): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    let durableStore = false;
    try {
      await stat(runtimeRoot);
      durableStore = true;
    } catch {}
    json(response, 200, { ok: true, durableStore, transport: "sse", temporalAddress: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/snapshot") {
    json(response, 200, await snapshot(url.searchParams.get("runId") ?? undefined));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/stream") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let last = "";
    const push = async () => {
      try {
        const value = JSON.stringify(await snapshot(url.searchParams.get("runId") ?? undefined));
        if (value !== last) {
          response.write(`event: snapshot\ndata: ${value}\n\n`);
          last = value;
        } else response.write(": heartbeat\n\n");
      } catch (error) {
        response.write(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`);
      }
    };
    await push();
    const timer = setInterval(push, 700);
    request.on("close", () => clearInterval(timer));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/authoring/providers") {
    json(response, 200, { providers: ["codex", "claude"], policy: "read-only", persistence: "browser-session" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/authoring/chat") {
    if (!isLocalAuthoringRequest(request)) {
      json(response, 403, { error: "Workflow authoring is restricted to this local Steward Console" });
      return;
    }
    const draft = await createWorkflowDraft(await body(request, 150_000), authoringRunner);
    json(response, 200, draft);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workflows") {
    json(response, 200, await listWorkflows()); return;
  }
  if (request.method === "POST" && ["/api/runs", "/api/runs/prepare"].includes(url.pathname)) {
    if (!isLocalRunStart(request)) {
      json(response, 403, { error: "Run starts require a local JSON request from this Console or a local client." });
      return;
    }
    const requestBody = await body(request);
    if (url.pathname === "/api/runs/prepare") { json(response, 200, await prepareRun(requestBody)); return; }
    if (Object.hasOwn(requestBody, "preparedId")) { json(response, 202, await startPreparedRun(requestBody)); return; }
    const mode = (requestBody.mode ?? "simulated") as AgentProvider;
    if (mode !== "simulated" && mode !== "codex") {
      json(response, 400, { error: "mode must be simulated or codex" });
      return;
    }
    const delayMs = typeof requestBody.delayMs === "number" ? requestBody.delayMs : undefined;
    const result = await startWorkflow({
      workingDirectory: requestBody.workingDirectory as string,
      definition: await loadWorkflow(workflowPath),
      initialInput: await loadInitialInput(inputPath),
      mode,
      delayMs,
    });
    json(response, 202, result);
    return;
  }
  const recoveryMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/recovery$/);
  if (request.method === "POST" && recoveryMatch) {
    const runId = decodeURIComponent(recoveryMatch[1]);
    const requestBody = await body(request);
    const requestId = typeof requestBody.requestId === "string" ? requestBody.requestId : "";
    const action = requestBody.action as AgentRecoveryAction | undefined;
    if (!requestId || !action || !["retry_same_session", "retry_fresh_session", "abort_workflow"].includes(action)) {
      json(response, 400, { error: "requestId and a valid recovery action are required" });
      return;
    }
    const state = (await listRunStates()).find((candidate) => candidate.runId === runId);
    const pending = state && Object.values(state.nodes)
      .flatMap((node) => node.recoveryRequests ?? [])
      .find((recovery) => recovery.requestId === requestId && recovery.status === "waiting");
    if (!state || !pending) {
      json(response, 409, { error: "The recovery request is not pending for this run" });
      return;
    }
    if (action === "retry_same_session" && !pending.canResumeSession) {
      json(response, 409, { error: "This recovery request has no safe provider session to resume" });
      return;
    }
    json(response, 200, await submitAgentRecovery(runId, { requestId, action }));
    return;
  }
  const inputMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/input$/);
  if (request.method === "POST" && inputMatch) {
    const runId = decodeURIComponent(inputMatch[1]);
    const requestBody = await body(request);
    const requestId = typeof requestBody.requestId === "string" ? requestBody.requestId : "";
    const answer = typeof requestBody.answer === "string" ? requestBody.answer.trim() : "";
    if (!requestId || !answer) {
      json(response, 400, { error: "requestId and a non-empty answer are required" });
      return;
    }
    const state = (await listRunStates()).find((candidate) => candidate.runId === runId);
    const pending = state && Object.values(state.nodes).find(
      (node) => node.humanRequest?.requestId === requestId && node.humanRequest.status === "waiting",
    );
    if (!state || !pending) {
      json(response, 409, { error: "The human input request is not pending for this run" });
      return;
    }
    json(response, 200, await submitHumanAnswer(runId, { requestId, answer }));
    return;
  }
  await serveStatic(url.pathname, response);
}

export function createDashboardServer(options: { authoringRunner?: AuthoringRunner } = {}) {
  return createServer((request, response) => {
    handler(request, response, options.authoringRunner).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof PreparationError || error instanceof SyntaxError || message.startsWith("request body")
        || message.startsWith("A repository working directory")
        || message.startsWith("Working directory must")
        || message.startsWith("provider must")
        || message.startsWith("message must")
        || message.startsWith("message exceeds")
        || message.startsWith("history")
        || message.startsWith("currentYaml")
        || message.startsWith("Invalid workflow:") ? 400 : 500;
      json(response, status, { error: message });
    });
  });
}

export function main() {
  const server = createDashboardServer();
  server.listen(DASHBOARD_PORT, "127.0.0.1", () => {
    console.log(`Steward Server ready at http://127.0.0.1:${DASHBOARD_PORT}`);
  });
  return server;
}
