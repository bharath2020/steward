import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AgentMessage,
  AgentMessageInput,
  AgentRecoveryRequest,
  HumanInputRequest,
  JsonValue,
  RunState,
  TimelineEvent,
  TransitionInput,
  WorkflowDefinition,
} from "./contracts";

export const runtimeRoot = resolve(process.env.YAMLFLOW_RUNTIME_DIR ?? "runtime");
const locks = new Map<string, Promise<void>>();
const messageLocks = new Map<string, Promise<void>>();

export function runDirectory(runId: string): string {
  return join(runtimeRoot, "runs", runId);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await atomicJson(path, value);
}

export async function writeTextArtifact(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

export async function readEvents(runId: string): Promise<TimelineEvent[]> {
  try {
    const source = await readFile(join(runDirectory(runId), "events.jsonl"), "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TimelineEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function readAgentMessages(runId: string, nodeId: string): Promise<AgentMessage[]> {
  try {
    const source = await readFile(join(runDirectory(runId), "nodes", nodeId, "messages.jsonl"), "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentMessage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function recordAgentMessage(input: AgentMessageInput): Promise<AgentMessage> {
  const lockId = `${input.runId}:${input.nodeId}`;
  const prior = messageLocks.get(lockId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const chain = prior.then(() => current);
  messageLocks.set(lockId, chain);
  await prior;

  try {
    const path = join(runDirectory(input.runId), "nodes", input.nodeId, "messages.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const messages = await readAgentMessages(input.runId, input.nodeId);
    const existing = messages.find((message) => message.id === input.id);
    if (existing) return existing;
    const message: AgentMessage = {
      ...input,
      seq: messages.length + 1,
      at: new Date().toISOString(),
    };
    await appendFile(path, `${JSON.stringify(message)}\n`, "utf8");
    return message;
  } finally {
    release();
    if (messageLocks.get(lockId) === chain) messageLocks.delete(lockId);
  }
}

function dataObject(event: TimelineEvent): Record<string, JsonValue> {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data
    : {};
}

export function rebuildState(
  transition: Pick<TransitionInput, "runId" | "temporalRunId" | "definition" | "mode" | "execution">,
  events: TimelineEvent[],
): RunState {
  const first = events[0];
  const mode = events.some(event => event.type === "run.started" && dataObject(event).mode === "workflow") ? "workflow" : transition.mode;
  const state: RunState = {
    runId: transition.runId,
    temporalRunId: transition.temporalRunId,
    workflowName: transition.definition.name,
    definitionHash: transition.definition.definitionHash,
    sourcePath: transition.definition.sourcePath,
    mode,
    ...(transition.execution ? { execution: transition.execution } : {}),
    status: "running",
    startedAt: first?.at ?? new Date(0).toISOString(),
    updatedAt: first?.at ?? new Date(0).toISOString(),
    currentWave: 0,
    completedCount: 0,
    totalCount: transition.definition.nodes.length,
    nodes: Object.fromEntries(
      transition.definition.nodes.map((node) => [
        node.id,
        {
          id: node.id,
          title: node.title,
          agent: node.kind === "scope" ? "scope" : node.kind === "human" ? "human" : mode === "workflow" ? node.agent : mode,
          group: node.group,
          status: "pending",
          phase: "Waiting for dependencies",
          needs: node.needs,
        },
      ]),
    ),
  };
  const completedQueueItems = new Map<string, Set<number>>();
  const waitingRecoveries = (node: RunState["nodes"][string]): AgentRecoveryRequest[] =>
    (node.recoveryRequests ?? []).filter((request) => request.status === "waiting");
  const restoreRecoveryWait = (node: RunState["nodes"][string]): boolean => {
    const waiting = waitingRecoveries(node);
    if (waiting.length === 0) return false;
    node.status = "awaiting_recovery";
    node.phase = waiting.length === 1
      ? "Recovery decision required"
      : `${waiting.length} recovery decisions required`;
    node.error = waiting[0].failure.message;
    return true;
  };

  for (const event of events) {
    state.updatedAt = event.at;
    if (event.wave !== undefined) state.currentWave = Math.max(state.currentWave, event.wave);
    const data = dataObject(event);
    if (event.type === "node.registered" && event.nodeId && !state.nodes[event.nodeId]) {
      state.nodes[event.nodeId] = {
        id: event.nodeId, title: String(data.title), definitionId: String(data.definitionId), parentId: String(data.parentId),
        agent: data.kind === "scope" ? "scope" : data.kind === "human" ? "human" : mode === "workflow" ? (data.agent === "codex" ? "codex" : "simulated") : mode,
        needs: data.needs as string[], status: "pending", phase: "Waiting for dependencies",
      };
      state.totalCount += 1;
    }
    const node = event.nodeId ? state.nodes[event.nodeId] : undefined;
    if (node && ["condition_met", "exhausted_accepted", "exhausted_failed"].includes(String(data.loopOutcome))) node.loopOutcome = data.loopOutcome as NonNullable<typeof node.loopOutcome>;
    switch (event.type) {
      case "run.started":
        if (data.execution && typeof data.execution === "object" && !Array.isArray(data.execution)
          && typeof data.execution.workingDirectory === "string" && data.execution.sandbox === "workspace-write") {
          state.execution = { workingDirectory: data.execution.workingDirectory, sandbox: "workspace-write" };
        }
        break;
      case "node.started":
        if (node) {
          node.status = "running";
          node.phase = "Reading inputs";
          node.startedAt = event.at;
          node.attempt = typeof data.attempt === "number" ? data.attempt : 1;
          node.iteration = typeof data.iteration === "number" ? data.iteration : 1;
          node.iterationCount = Math.max(node.iterationCount ?? 0, node.iteration);
          if (data.queueItem && typeof data.queueItem === "object" && !Array.isArray(data.queueItem)) {
            const queueItem = data.queueItem as Record<string, JsonValue>;
            node.totalItems = typeof queueItem.count === "number" ? queueItem.count : node.totalItems;
          }
          node.input = data.input;
          delete node.error;
          delete node.completedAt;
          restoreRecoveryWait(node);
        }
        break;
      case "node.phase":
        if (node) node.phase = event.message;
        break;
      case "node.completed":
        if (node) {
          node.status = "completed";
          node.phase = "Output committed";
          node.completedAt = event.at;
          node.output = data.output;
          node.durationMs = typeof data.durationMs === "number" ? data.durationMs : undefined;
          node.completedItems = typeof data.completedItems === "number" ? data.completedItems : node.completedItems;
          node.totalItems = typeof data.totalItems === "number" ? data.totalItems : node.totalItems;
        }
        break;
      case "node.item_completed":
        if (node) {
          const queueItem = data.queueItem && typeof data.queueItem === "object" && !Array.isArray(data.queueItem)
            ? data.queueItem as Record<string, JsonValue>
            : {};
          const itemIndex = typeof queueItem.index === "number"
            ? queueItem.index
            : typeof data.iteration === "number"
              ? data.iteration - 1
              : undefined;
          const committed = completedQueueItems.get(node.id) ?? new Set<number>();
          if (itemIndex !== undefined) committed.add(itemIndex);
          completedQueueItems.set(node.id, committed);
          node.status = "running";
          node.completedItems = committed.size;
          node.totalItems = typeof queueItem.count === "number" ? queueItem.count : node.totalItems;
          node.phase = node.totalItems === undefined
            ? `${node.completedItems} queued items committed`
            : `${node.completedItems} / ${node.totalItems} queued items committed`;
          restoreRecoveryWait(node);
        }
        break;
      case "node.receipt_recovered":
        if (node) {
          node.status = "running";
          node.phase = "Recovered committed output from receipt";
          restoreRecoveryWait(node);
        }
        break;
      case "recovery.required":
        if (node && data.request && typeof data.request === "object" && !Array.isArray(data.request)) {
          const request = data.request as unknown as AgentRecoveryRequest;
          node.recoveryRequests ??= [];
          const existing = node.recoveryRequests.findIndex((candidate) => candidate.requestId === request.requestId);
          if (existing === -1) node.recoveryRequests.push(request);
          else node.recoveryRequests[existing] = request;
          restoreRecoveryWait(node);
        }
        break;
      case "human.required":
        if (node && data.request && typeof data.request === "object" && !Array.isArray(data.request)) {
          node.status = "awaiting_input";
          node.phase = "Waiting for your answer";
          node.humanRequest = data.request as unknown as HumanInputRequest;
        }
        break;
      case "human.accepted":
        if (node) {
          if (node.humanRequest) {
            node.humanRequest.status = "received";
            node.humanRequest.receivedAt = typeof data.receivedAt === "string" ? data.receivedAt : event.at;
            node.humanRequest.answer = typeof data.answer === "string" ? data.answer : undefined;
          }
          node.status = "running";
          node.phase = "Answer accepted; committing output";
        }
        break;
      case "recovery.accepted":
        if (node) {
          const action = typeof data.action === "string" ? data.action : undefined;
          const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
          const recovery = node.recoveryRequests?.find((request) => request.requestId === requestId);
          if (recovery) {
            recovery.status = "received";
            recovery.receivedAt = typeof data.receivedAt === "string" ? data.receivedAt : event.at;
            if (action === "retry_same_session" || action === "retry_fresh_session" || action === "abort_workflow") {
              recovery.command = { requestId: recovery.requestId, action };
            }
          }
          if (action === "abort_workflow") {
            node.status = "failed";
            node.phase = event.message;
          } else if (!restoreRecoveryWait(node)) {
            node.status = "running";
            node.phase = event.message;
            delete node.error;
          }
        }
        break;
      case "loop.continued":
        if (node) {
          node.status = "running";
          node.phase = event.message;
        }
        break;
      case "loop.satisfied":
        if (node) node.phase = "Loop condition met";
        break;
      case "loop.exhausted":
        if (node && data.accepted !== true) {
          node.status = "failed";
          node.phase = "Loop exhausted";
        }
        break;
      case "node.failed":
        if (node) {
          node.status = "failed";
          node.phase = "Attempt failed";
          node.error = typeof data.error === "string" ? data.error : event.message;
          restoreRecoveryWait(node);
        }
        break;
      case "run.completed":
        state.status = "completed";
        state.completedAt = event.at;
        state.finalOutputs = data.outputs as Record<string, JsonValue> | undefined;
        break;
      case "run.failed":
        state.status = "failed";
        state.completedAt = event.at;
        state.failure = typeof data.error === "string" ? data.error : event.message;
        break;
    }
  }
  state.completedCount = Object.values(state.nodes).filter((node) => node.status === "completed").length;
  if (state.status !== "completed" && state.status !== "failed") {
    state.status = Object.values(state.nodes).some((node) => node.status === "awaiting_recovery")
      ? "waiting_for_recovery"
      : Object.values(state.nodes).some((node) => node.status === "awaiting_input")
        ? "waiting_for_human"
        : "running";
  }
  return state;
}

export async function recordTransition(input: TransitionInput): Promise<TimelineEvent> {
  const prior = locks.get(input.runId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const chain = prior.then(() => current);
  locks.set(input.runId, chain);
  await prior;

  try {
    const directory = runDirectory(input.runId);
    await mkdir(directory, { recursive: true });
    const events = await readEvents(input.runId);
    const existing = events.find((event) => event.id === input.id);
    if (existing) {
      await atomicJson(join(directory, "state.json"), rebuildState(input, events));
      return existing;
    }
    const event: TimelineEvent = {
      id: input.id,
      seq: events.length + 1,
      at: new Date().toISOString(),
      type: input.type,
      runId: input.runId,
      nodeId: input.nodeId,
      wave: input.wave,
      message: input.message,
      data: input.data,
    };
    await appendFile(join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    const allEvents = [...events, event];
    await atomicJson(join(directory, "state.json"), rebuildState(input, allEvents));
    return event;
  } finally {
    release();
    if (locks.get(input.runId) === chain) locks.delete(input.runId);
  }
}

export async function initializeRun(
  input: TransitionInput,
  definition: WorkflowDefinition,
  initialInput: JsonValue,
): Promise<TimelineEvent> {
  const directory = runDirectory(input.runId);
  await mkdir(join(directory, "nodes"), { recursive: true });
  await atomicJson(join(directory, "definition.json"), definition);
  await atomicJson(join(directory, "input.json"), initialInput);
  if (input.execution) await atomicJson(join(directory, "execution.json"), input.execution);
  return recordTransition(input);
}
