import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentCompletionReceipt,
  AgentMessage,
  AgentRecoveryReceipt,
  JsonValue,
  RunState,
  TimelineEvent,
  WorkflowDefinition,
} from "../src/contracts";

const execute = promisify(execFile);
const processes: ChildProcess[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a port"));
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function connectable(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = new (require("node:net").Socket)();
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("timeout", () => { socket.destroy(); done(false); });
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 75_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 120));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function launch(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "ignore" });
  processes.push(child);
  return child;
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await new Promise<void>((done) => child.once("exit", () => done()));
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readEvents(runtime: string, runId: string): Promise<TimelineEvent[]> {
  const source = await readFile(join(runtime, "runs", runId, "events.jsonl"), "utf8");
  return source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TimelineEvent);
}

async function startRun(environment: NodeJS.ProcessEnv, delayMs = 60, workflowPath = "workflows/product-launch.yaml"): Promise<string> {
  const { stdout } = await execute(process.execPath, [
    "--import", "tsx", "src/start.ts",
    "--workflow", workflowPath,
    "--input", "examples/product-input.json",
    "--mode", "simulated",
    "--delay-ms", String(delayMs),
  ], { cwd: process.cwd(), env: environment, maxBuffer: 1024 * 1024 });
  const resultLine = stdout.trim().split("\n").reverse().find((line) => line.startsWith("{"));
  if (!resultLine) throw new Error(`Start command did not return JSON: ${stdout}`);
  return (JSON.parse(resultLine) as { runId: string }).runId;
}

async function main(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "yamlflow-recovery-"));
  const port = await freePort();
  const dashboardPort = await freePort();
  const address = `127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    TEMPORAL_ADDRESS: address,
    YAMLFLOW_RUNTIME_DIR: temporary,
    YAMLFLOW_PORT: String(dashboardPort),
  };
  try {
    launch("temporal", [
      "server", "start-dev",
      "--headless",
      "--ip", "127.0.0.1",
      "--port", String(port),
      "--db-filename", join(temporary, "temporal.db"),
    ], environment);
    await waitFor(async () => (await connectable(port)) ? true : undefined, "Temporal test server");
    launch(process.execPath, ["--import", "tsx", "src/server.ts"], environment);
    await waitFor(async () => (await connectable(dashboardPort)) ? true : undefined, "recovery API server");

    // Snapshot a file prompt, then delete it before any worker can execute the run.
    const fileWorkflow = YAML.parse(await readFile("workflows/product-launch.yaml", "utf8"));
    const originalPrompt: string = fileWorkflow.nodes.intake.prompt;
    const promptPath = join(temporary, "intake.md");
    const workflowPath = join(temporary, "file-prompt.yaml");
    delete fileWorkflow.nodes.intake.prompt;
    fileWorkflow.nodes.intake.prompt_file = "./intake.md";
    await writeFile(promptPath, originalPrompt);
    await writeFile(workflowPath, YAML.stringify(fileWorkflow));
    const receiptRunId = await startRun(environment, 60, workflowPath);
    await rm(promptPath);

    // Catastrophic worker loss after provider completion but before Activity acknowledgement.
    let worker = launch(process.execPath, ["--import", "tsx", "src/worker.ts"], {
      ...environment,
      YAMLFLOW_TEST_PAUSE_AFTER_RECEIPT_NODE: "intake",
      YAMLFLOW_TEST_PAUSE_AFTER_RECEIPT_MS: "30000",
    });
    const receiptRun = join(temporary, "runs", receiptRunId);
    const primaryReceiptPath = join(receiptRun, "nodes", "intake", "completion-receipt.json");
    const mirrorReceiptPath = join(receiptRun, "receipts", "intake-iteration-01.json");
    const outputPath = join(receiptRun, "nodes", "intake", "output.json");
    const primaryReceipt = await waitFor(
      () => readJson<AgentCompletionReceipt>(primaryReceiptPath),
      "primary completion receipt before worker loss",
    );

    await stop(worker, "SIGKILL");
    await Promise.all([
      rm(mirrorReceiptPath, { force: true }),
      rm(outputPath, { force: true }),
    ]);
    worker = launch(process.execPath, ["--import", "tsx", "src/worker.ts"], environment);
    const recoveredReceiptRun = await waitFor(async () => {
      const state = await readJson<RunState>(join(receiptRun, "state.json"));
      return state?.status === "completed" ? state : undefined;
    }, "receipt-recovered workflow completion");
    assert.equal(recoveredReceiptRun.completedCount, recoveredReceiptRun.totalCount);
    const savedDefinition = await readJson<WorkflowDefinition>(join(receiptRun, "definition.json"));
    const savedIntake = savedDefinition?.nodes.find((node) => node.id === "intake");
    assert.equal(savedIntake?.prompt, originalPrompt);
    assert.deepEqual(savedIntake?.promptSource, {
      path: "./intake.md",
      sha256: createHash("sha256").update(originalPrompt).digest("hex"),
    });
    const persistedPrompt = await readFile(join(receiptRun, "nodes", "intake", "prompt.txt"), "utf8");
    assert(persistedPrompt.includes(originalPrompt.trim()), "the restarted Activity must use the saved file prompt");
    assert.equal(primaryReceipt.promptSha256, createHash("sha256").update(persistedPrompt.slice(0, -1)).digest("hex"));
    await assert.rejects(readFile(promptPath), { code: "ENOENT" });

    const [restoredMirror, restoredOutput, receiptEvents, intakeMessages] = await Promise.all([
      readJson<AgentCompletionReceipt>(mirrorReceiptPath),
      readJson<JsonValue>(outputPath),
      readEvents(temporary, receiptRunId),
      readJsonLines<AgentMessage>(join(receiptRun, "nodes", "intake", "messages.jsonl")),
    ]);
    assert.deepEqual(restoredMirror, primaryReceipt, "the missing receipt copy must be reconstructed");
    assert.deepEqual(restoredOutput, primaryReceipt.output, "the missing output projection must be reconstructed");
    assert(receiptEvents.some((event) => event.type === "node.receipt_recovered" && event.nodeId === "intake"));
    assert.equal(new Set(intakeMessages.map((message) => message.attempt)).size, 1, "receipt recovery must not rerun the provider");

    // Exhaust automatic network retries, wait durably, then resume the exact provider session.
    await stop(worker);
    worker = launch(process.execPath, ["--import", "tsx", "src/worker.ts"], {
      ...environment,
      YAMLFLOW_TEST_NETWORK_FAILURE_NODE: "feasibility",
      YAMLFLOW_TEST_NETWORK_FAILURE_ATTEMPTS: "2",
    });
    const networkRunId = await startRun(environment);
    const networkRun = join(temporary, "runs", networkRunId);
    const waiting = await waitFor(async () => {
      const state = await readJson<RunState>(join(networkRun, "state.json"));
      return state?.status === "waiting_for_recovery" ? state : undefined;
    }, "operator recovery request");
    const settledSiblings = await waitFor(async () => {
      const state = await readJson<RunState>(join(networkRun, "state.json"));
      return state?.nodes.audience_research.status === "completed"
        && state.nodes.narrative.status === "completed"
        ? state
        : undefined;
    }, "completed parallel siblings");
    const request = settledSiblings.nodes.feasibility.recovery!;
    assert.equal(request.failure.kind, "network");
    assert.equal(request.canResumeSession, true);
    assert(request.failure.providerSessionId, "the failed Activity must expose its heartbeated provider session");

    const recoveryResponse = await fetch(`http://127.0.0.1:${dashboardPort}/api/runs/${encodeURIComponent(networkRunId)}/recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: request.requestId, action: "retry_same_session" }),
    });
    const recoveryReceipt = await recoveryResponse.json() as AgentRecoveryReceipt & { error?: string };
    if (!recoveryResponse.ok) throw new Error(recoveryReceipt.error ?? "Recovery API rejected the command");
    assert.equal(recoveryReceipt.accepted, true);
    assert.equal(recoveryReceipt.action, "retry_same_session");

    const recoveredNetworkRun = await waitFor(async () => {
      const state = await readJson<RunState>(join(networkRun, "state.json"));
      return state?.status === "completed" ? state : undefined;
    }, "same-session recovery completion");
    assert.equal(recoveredNetworkRun.completedCount, recoveredNetworkRun.totalCount);

    const networkEvents = await readEvents(temporary, networkRunId);
    assert.equal(new Set(networkEvents.map((event) => event.id)).size, networkEvents.length, "transition IDs must remain unique");
    assert(networkEvents.some((event) => event.type === "recovery.required" && event.nodeId === "feasibility"));
    assert(networkEvents.some((event) => event.type === "recovery.accepted" && event.nodeId === "feasibility"));
    assert(networkEvents.some((event) =>
      event.type === "node.started"
      && event.nodeId === "feasibility"
      && Number((event.data as { attempt?: number } | undefined)?.attempt) === 2
      && (event.data as { recoveredFromHeartbeat?: boolean } | undefined)?.recoveredFromHeartbeat === true,
    ), "the automatic retry must restore its session from heartbeat details");
    assert(networkEvents.some((event) =>
      event.type === "node.started"
      && event.nodeId === "feasibility"
      && Number((event.data as { recoveryCycle?: number } | undefined)?.recoveryCycle) === 1
      && (event.data as { resumedProviderSession?: boolean } | undefined)?.resumedProviderSession === true,
    ), "the operator retry must use the recorded provider session");
    for (const sibling of ["audience_research", "narrative"]) {
      assert.equal(
        networkEvents.filter((event) => event.type === "node.completed" && event.nodeId === sibling).length,
        1,
        `${sibling} must not rerun while its failed sibling waits for recovery`,
      );
    }

    console.log(JSON.stringify({
      ok: true,
      receiptRecovery: {
        runId: receiptRunId,
        workerKilledAfterProviderCompletion: true,
        deletedReceiptRecovered: true,
        deletedOutputRecovered: true,
        providerReruns: 0,
        deletedPromptFileSnapshotRecovered: true,
        promptSourceSha256: savedIntake!.promptSource!.sha256,
      },
      networkRecovery: {
        runId: networkRunId,
        automaticAttemptsExhausted: 2,
        operatorAction: recoveryReceipt.action,
        providerSessionId: request.failure.providerSessionId,
        completedSiblingsRerun: 0,
      },
    }, null, 2));
  } finally {
    processes.reverse().forEach((process) => {
      if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
    });
    await new Promise((done) => setTimeout(done, 500));
    await rm(temporary, { recursive: true, force: true });
  }
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const source = await readFile(path, "utf8");
  return source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
