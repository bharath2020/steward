import { ApplicationFailure, Context } from "@temporalio/activity";
import Ajv from "ajv";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { extractHumanAgentMessage, summarizeOutput } from "./agent-stream";
import {
  commitCompletionReceipt,
  completionPaths,
  recoverCompletionReceipt,
  sha256Json,
} from "./completion-receipt";
import type {
  AgentExecutionInput,
  AgentExecutionResult,
  AgentHeartbeatCheckpoint,
  JsonValue,
  ProviderSessionAffinity,
  OutputType,
  TimelineEvent,
  TransitionInput,
} from "./contracts";
import {
  AGENT_HEARTBEAT_INTERVAL_MS,
  classifyAgentFailure,
  codexExecutionArgs,
  matchingHeartbeatCheckpoint,
  MAX_PROVIDER_OUTPUT_BYTES,
  MAX_STDERR_TAIL_BYTES,
  providerFailureMessage,
  PUBLIC_AGENT_FAILURE,
} from "./execution-policy";
import {
  initializeRun as initializeRunStore,
  recordAgentMessage,
  recordTransition as recordTransitionStore,
  runDirectory,
  writeJsonArtifact,
  writeTextArtifact,
} from "./store";

const ajv = new Ajv({ allErrors: true, strict: false });

interface ActivityRuntime {
  startedAt: string;
  lastProviderEventAt?: string;
  providerFailureMessage?: string;
  providerSessionId?: string;
  sessionWorkspace?: string;
  processId?: number;
}

export async function initializeRun(input: TransitionInput): Promise<TimelineEvent> {
  return initializeRunStore(input, input.definition, input.initialInput);
}

export async function recordTransition(input: TransitionInput): Promise<TimelineEvent> {
  return recordTransitionStore(input);
}

function cyclePrefix(execution: AgentExecutionInput): string {
  return `iteration:${execution.iteration}:recovery:${execution.recoveryCycle}`;
}

function transition(
  execution: AgentExecutionInput,
  suffix: string,
  type: string,
  message: string,
  data?: JsonValue,
): TransitionInput {
  return {
    id: `${execution.runId}:${execution.node.id}:${cyclePrefix(execution)}:${suffix}`,
    runId: execution.runId,
    temporalRunId: execution.temporalRunId,
    definition: execution.definition,
    mode: execution.mode,
    initialInput: {},
    type,
    nodeId: execution.node.id,
    wave: execution.wave,
    message,
    data,
  };
}

function completionTransition(execution: AgentExecutionInput): {
  type: "node.completed" | "node.item_completed";
  message: string;
} {
  if (!execution.queueItem) {
    return {
      type: "node.completed",
      message: `${execution.node.title} committed iteration ${execution.iteration}`,
    };
  }
  return {
    type: "node.item_completed",
    message: `${execution.node.title} committed queued item ${execution.queueItem.index + 1} of ${execution.queueItem.count}`,
  };
}

function simulatedValue(type: OutputType, nodeTitle: string, input: Record<string, JsonValue>): JsonValue {
  switch (type) {
    case "string":
      return `${nodeTitle} produced a validated result from ${Object.keys(input).length} inputs.`;
    case "number":
      return Object.keys(input).length;
    case "boolean":
      return true;
    case "object":
      return input;
    case "string[]":
      return [`${nodeTitle} signal A`, `${nodeTitle} signal B`];
    case "number[]":
      return [1, 2];
    case "boolean[]":
      return [true, false];
    case "object[]":
      return [input];
  }
}

function simulatedOutput(execution: AgentExecutionInput): JsonValue {
  if (execution.node.demo_outputs?.length) {
    return execution.node.demo_outputs[Math.min((execution.simulationIteration ?? execution.iteration) - 1, execution.node.demo_outputs.length - 1)];
  }
  if (execution.node.demo_output !== undefined) return execution.node.demo_output;
  return Object.fromEntries(
    Object.entries(execution.node.outputs).map(([key, type]) => [
      key,
      simulatedValue(type, execution.node.title, execution.input),
    ]),
  );
}

async function pause(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function boundedTail(existing: string, chunk: string, maximumBytes: number): string {
  const combined = `${existing}${chunk}`;
  const buffer = Buffer.from(combined, "utf8");
  return buffer.byteLength <= maximumBytes
    ? combined
    : buffer.subarray(buffer.byteLength - maximumBytes).toString("utf8");
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5_000);
  force.unref();
}

async function runCodex(input: {
  execution: AgentExecutionInput;
  prompt: string;
  schemaPath: string;
  outputPath: string;
  priorSessionId?: string;
  runtime: ActivityRuntime;
  checkpoint: () => void;
  onMessage: (message: { id: string; text: string }) => Promise<void>;
}): Promise<{ output: JsonValue; messageCount: number; providerSessionId?: string }> {
  await rm(input.outputPath, { force: true });
  const args = codexExecutionArgs({
    prompt: input.prompt,
    schemaPath: input.schemaPath,
    outputPath: input.outputPath,
    cwd: input.execution.execution?.workingDirectory ?? process.cwd(),
    ...(input.execution.execution ? { sandbox: input.execution.execution.sandbox } : {}),
    ...(input.priorSessionId ? { priorSessionId: input.priorSessionId } : {}),
  });

  let messageCount = 0;
  const context = Context.current();
  const result = await Promise.race([
    new Promise<{ code: number | null; stderr: string }>((resolveProcess, rejectProcess) => {
      const child = spawn("codex", args, {
        cwd: input.execution.execution?.workingDirectory ?? process.cwd(),
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      input.runtime.processId = child.pid;
      let stderr = "";
      let stdoutBuffer = "";
      let stdoutBytes = 0;
      let messageWrites = Promise.resolve();
      let settled = false;

      const cleanup = (): void => {
        clearInterval(interval);
        context.cancellationSignal.removeEventListener("abort", cancel);
      };
      const reject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectProcess(error);
      };
      const resolve = (value: { code: number | null; stderr: string }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        messageWrites.then(() => resolveProcess(value), rejectProcess);
      };
      const consume = (line: string): void => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const providerError = providerFailureMessage(event);
          if (providerError) input.runtime.providerFailureMessage = providerError;
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            input.runtime.providerSessionId = event.thread_id;
            input.runtime.lastProviderEventAt = new Date().toISOString();
            input.checkpoint();
          }
        } catch {
          // The human-message parser below ignores malformed provider protocol lines.
        }
        const message = extractHumanAgentMessage(line);
        if (!message) return;
        messageCount += 1;
        messageWrites = messageWrites.then(() => input.onMessage(message));
      };
      const interval = setInterval(input.checkpoint, AGENT_HEARTBEAT_INTERVAL_MS);
      interval.unref();
      const cancel = (): void => terminateChild(child);
      context.cancellationSignal.addEventListener("abort", cancel, { once: true });
      input.checkpoint();
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = boundedTail(stderr, chunk.toString("utf8"), MAX_STDERR_TAIL_BYTES);
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        input.runtime.lastProviderEventAt = new Date().toISOString();
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_PROVIDER_OUTPUT_BYTES) {
          terminateChild(child);
          reject(new Error("Provider output exceeded the structured-response safety limit."));
          return;
        }
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        lines.filter(Boolean).forEach(consume);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (stdoutBuffer.trim()) consume(stdoutBuffer);
        if (code !== 0) {
          reject(new Error(input.runtime.providerFailureMessage || stderr.trim() || `codex exec exited ${String(code)}`));
          return;
        }
        resolve({ code, stderr });
      });
    }),
    context.cancelled,
  ]);
  if (result.code !== 0) throw new Error(`codex exec exited ${String(result.code)}: ${result.stderr}`);
  return {
    output: JSON.parse(await readFile(input.outputPath, "utf8")) as JsonValue,
    messageCount,
    ...(input.runtime.providerSessionId ? { providerSessionId: input.runtime.providerSessionId } : {}),
  };
}

function readableKeys(values: Record<string, unknown>): string {
  const keys = Object.keys(values)
    .filter((key) => !key.startsWith("__"))
    .map((key) => key.replaceAll("_", " "));
  if (keys.length === 0) return "the assignment";
  if (keys.length === 1) return keys[0];
  return `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
}

function promptFor(execution: AgentExecutionInput): string {
  return [
    `You are the bounded worker for workflow node ${execution.node.id} (${execution.node.title}).`,
    execution.queueItem
      ? `This is queue item ${execution.queueItem.index + 1} of ${execution.queueItem.count}.`
      : `This is iteration ${execution.iteration}${execution.node.loop ? ` of at most ${execution.node.loop.max_iterations}` : ""}.`,
    execution.execution
      ? `Do not orchestrate other agents. Complete only this node's assignment. You may modify files in the assigned repository: ${execution.execution.workingDirectory}. Before repeating an interrupted operation, inspect existing files and processes; retries do not undo earlier edits.`
      : "Do not orchestrate other agents. Do not modify files. Complete only this node's assignment.",
    "Return only JSON matching the provided output schema.",
    ...(execution.recovery
      ? [
          "",
          "RECOVERY CONTEXT",
          `The previous provider turn ended as ${execution.recovery.failureKind}.`,
          execution.recovery.message,
          execution.recovery.action === "retry_same_session"
            ? "Continue this same provider session and finish the structured handoff."
            : "This is a fresh provider session; reconstruct the handoff from the declared inputs.",
        ]
      : []),
    "",
    "ASSIGNMENT",
    execution.node.prompt.trim(),
    "",
    "RESOLVED INPUTS",
    JSON.stringify(execution.input, null, 2),
  ].join("\n");
}

function heartbeatCheckpoint(
  execution: AgentExecutionInput,
  attempt: number,
  runtime: ActivityRuntime,
): AgentHeartbeatCheckpoint {
  return {
    schema: "agent-heartbeat.v1",
    runId: execution.runId,
    temporalRunId: execution.temporalRunId,
    nodeId: execution.node.id,
    provider: execution.mode,
    iteration: execution.iteration,
    recoveryCycle: execution.recoveryCycle,
    attempt,
    phase: runtime.providerSessionId ? "working" : "starting",
    startedAt: runtime.startedAt,
    ...(runtime.lastProviderEventAt ? { lastProviderEventAt: runtime.lastProviderEventAt } : {}),
    ...(runtime.providerSessionId ? { providerSessionId: runtime.providerSessionId } : {}),
    ...(execution.captureSessionAffinity && runtime.providerSessionId && runtime.sessionWorkspace ? {
      sessionAffinity: { provider: execution.mode, canonicalWorkspace: runtime.sessionWorkspace, sessionId: runtime.providerSessionId },
    } : {}),
    ...(runtime.processId ? { processId: runtime.processId } : {}),
  };
}

async function injectedNetworkFailure(
  execution: AgentExecutionInput,
  attempt: number,
  runtime: ActivityRuntime,
  checkpoint: () => void,
): Promise<void> {
  if (
    execution.mode !== "simulated"
    || process.env.YAMLFLOW_TEST_NETWORK_FAILURE_NODE !== execution.node.id
    || execution.recoveryCycle !== 0
  ) return;
  const failedAttempts = Number(process.env.YAMLFLOW_TEST_NETWORK_FAILURE_ATTEMPTS ?? "999");
  if (attempt > failedAttempts) return;
  runtime.providerSessionId ??= `sim-${execution.runId}-${execution.node.id}`;
  runtime.lastProviderEventAt = new Date().toISOString();
  checkpoint();
  throw new Error("Injected network connection lost while the provider turn was active.");
}

async function pauseAfterPrimaryReceipt(execution: AgentExecutionInput, attempt: number): Promise<void> {
  if (
    process.env.YAMLFLOW_TEST_PAUSE_AFTER_RECEIPT_NODE !== execution.node.id
    || execution.recoveryCycle !== 0
    || attempt !== 1
  ) return;
  await pause(Number(process.env.YAMLFLOW_TEST_PAUSE_AFTER_RECEIPT_MS ?? "30000"));
}

async function executeAgentInternal(execution: AgentExecutionInput): Promise<AgentExecutionResult> {
  const context = Context.current();
  const attempt = context.info.attempt;
  const started = Date.now();
  const paths = completionPaths(execution);
  await mkdir(paths.directory, { recursive: true });
  const prompt = promptFor(execution);
  const schemaPath = join(paths.directory, "schema.json");
  const promptSha256 = createHash("sha256").update(prompt).digest("hex");
  const outputSchemaSha256 = sha256Json(execution.node.outputSchema);
  const matchingCheckpoint = matchingHeartbeatCheckpoint(context.info.heartbeatDetails, {
    runId: execution.runId,
    temporalRunId: execution.temporalRunId,
    nodeId: execution.node.id,
    provider: execution.mode,
    iteration: execution.iteration,
    recoveryCycle: execution.recoveryCycle,
  });
  const canonicalWorkspace = execution.captureSessionAffinity ? await realpath(execution.execution?.workingDirectory ?? process.cwd()) : undefined;
  const priorProviderSessionId = execution.captureSessionAffinity
    ? matchingCheckpoint?.providerSessionId ?? execution.providerSessionId
    : execution.providerSessionId ?? matchingCheckpoint?.providerSessionId;
  const priorAffinity = execution.captureSessionAffinity && matchingCheckpoint?.providerSessionId
    ? matchingCheckpoint.sessionAffinity
    : execution.sessionAffinity;
  const runtime: ActivityRuntime = {
    startedAt: new Date().toISOString(),
    providerSessionId: priorProviderSessionId,
    ...(canonicalWorkspace ? { sessionWorkspace: priorAffinity?.canonicalWorkspace ?? canonicalWorkspace } : {}),
  };
  if (execution.mode === "simulated") {
    runtime.providerSessionId ??= execution.queueItem
      ? `sim-${execution.runId}-${execution.node.id}-${execution.iteration}`
      : `sim-${execution.runId}-${execution.node.id}`;
  }
  const sessionAffinity = (): ProviderSessionAffinity | undefined => execution.captureSessionAffinity && runtime.providerSessionId && runtime.sessionWorkspace
    ? { provider: execution.mode, canonicalWorkspace: runtime.sessionWorkspace, sessionId: runtime.providerSessionId }
    : undefined;
  const checkpoint = (): void => context.heartbeat(heartbeatCheckpoint(execution, attempt, runtime));

  await writeJsonArtifact(join(paths.directory, "input.json"), execution.input);
  await writeJsonArtifact(schemaPath, execution.node.outputSchema);
  await writeTextArtifact(join(paths.directory, "prompt.txt"), `${prompt}\n`);
  await recordTransitionStore(
    transition(
      execution,
      `attempt:${attempt}:started`,
      "node.started",
      attempt > 1
        ? `${execution.node.title} resumed after an interrupted attempt`
        : execution.recoveryCycle > 0
          ? `${execution.node.title} started recovery cycle ${execution.recoveryCycle}`
          : `${execution.node.title} started iteration ${execution.iteration}`,
      {
        attempt,
        iteration: execution.iteration,
        recoveryCycle: execution.recoveryCycle,
        ...(execution.queueItem ? { queueItem: execution.queueItem } : {}),
        input: execution.input,
        resumedProviderSession: Boolean(priorProviderSessionId),
        recoveredFromHeartbeat: Boolean(matchingCheckpoint?.providerSessionId),
      },
    ),
  );
  if (!execution.captureSessionAffinity) checkpoint();

  const writeMessage = (suffix: string, message: string) => recordAgentMessage({
    id: `${execution.runId}:${execution.node.id}:${cyclePrefix(execution)}:attempt:${attempt}:${suffix}`,
    runId: execution.runId,
    nodeId: execution.node.id,
    iteration: execution.iteration,
    attempt,
    provider: execution.mode,
    text: message,
  });

  try {
    const recovered = await recoverCompletionReceipt({ execution, promptSha256, outputSchemaSha256 });
    if (recovered) {
      const validateRecovered = ajv.compile(execution.node.outputSchema);
      if (!validateRecovered(recovered.output)) {
        throw new Error(`Completion receipt output schema validation failed: ${ajv.errorsText(validateRecovered.errors)}`);
      }
      await recordTransitionStore(
        transition(
          execution,
          `attempt:${attempt}:receipt:recovered`,
          "node.receipt_recovered",
          `${execution.node.title} recovered a committed provider result from its hash-bound receipt`,
          {
            attempt,
            iteration: execution.iteration,
            recoveryCycle: execution.recoveryCycle,
            receiptSha256: recovered.receiptSha256,
          },
        ),
      );
      const completed = completionTransition(execution);
      await recordTransitionStore(
        transition(
          execution,
          `attempt:${attempt}:completed`,
          completed.type,
          execution.queueItem
            ? `${completed.message} from its hash-bound receipt`
            : `${execution.node.title} recommitted iteration ${execution.iteration} without rerunning the provider`,
          {
            attempt,
            iteration: execution.iteration,
            recoveryCycle: execution.recoveryCycle,
            ...(execution.queueItem ? { queueItem: execution.queueItem } : {}),
            output: recovered.output,
            outputHash: sha256Json(recovered.output),
            receiptSha256: recovered.receiptSha256,
            recoveredFromReceipt: true,
            durationMs: Date.now() - started,
            artifact: paths.acceptedOutputPath.slice(runDirectory(execution.runId).length + 1),
          },
        ),
      );
      return recovered;
    }

    if (execution.execution) {
      const actual = await realpath(execution.execution.workingDirectory);
      if (actual !== execution.execution.workingDirectory || execution.execution.sandbox !== "workspace-write") {
        throw new Error("Recorded repository execution binding is invalid or changed");
      }
    }
    if (execution.captureSessionAffinity) {
      if (priorProviderSessionId && (!priorAffinity || priorAffinity.provider !== execution.mode || priorAffinity.canonicalWorkspace !== canonicalWorkspace || priorAffinity.sessionId !== priorProviderSessionId)) {
        throw new Error("Provider session identity does not match provider or canonical workspace");
      }
      checkpoint();
      await recordTransitionStore(transition(execution, `attempt:${attempt}:session`, "node.session", priorProviderSessionId ? "Resuming the recorded provider session" : "No recorded provider session; starting fresh", {
        policy: "resume", action: priorProviderSessionId ? "resume" : "fresh", reason: priorProviderSessionId ? "recorded_session" : "no_recorded_session",
        ...(priorProviderSessionId ? { providerSessionId: priorProviderSessionId } : {}),
      }));
    }
    await injectedNetworkFailure(execution, attempt, runtime, checkpoint);

    let output: JsonValue;
    let agentMessageCount = 0;
    if (execution.mode === "codex") {
      await recordTransitionStore(
        transition(execution, `attempt:${attempt}:phase:dispatch`, "node.phase", runtime.providerSessionId
          ? "Resuming the recorded Codex session"
          : "Running isolated Codex worker"),
      );
      const result = await runCodex({
        execution,
        prompt,
        schemaPath,
        outputPath: paths.outputPath,
        ...(runtime.providerSessionId ? { priorSessionId: runtime.providerSessionId } : {}),
        runtime,
        checkpoint,
        onMessage: async (message) => {
          await writeMessage(`codex:${message.id}`, message.text);
        },
      });
      output = result.output;
      agentMessageCount = result.messageCount;
      runtime.providerSessionId = result.providerSessionId;
    } else {
      const delay = execution.delayMs ?? execution.node.delay_ms ?? execution.definition.defaults.delay_ms;
      await writeMessage(
        "message:reviewing",
        `I’m reviewing ${readableKeys(execution.input)} for ${execution.node.title.toLowerCase()}.`,
      );
      await pause(Math.round(delay * 0.28));
      checkpoint();
      await recordTransitionStore(
        transition(execution, `attempt:${attempt}:phase:read`, "node.phase", "Reading resolved inputs"),
      );
      await pause(Math.round(delay * 0.42));
      checkpoint();
      await recordTransitionStore(
        transition(execution, `attempt:${attempt}:phase:work`, "node.phase", "Drafting structured output"),
      );
      await writeMessage(
        "message:shaping",
        `I’m turning that material into ${readableKeys(execution.node.outputs)}.`,
      );
      await pause(Math.round(delay * 0.3));
      output = simulatedOutput(execution);
    }

    const validate = ajv.compile(execution.node.outputSchema);
    if (!validate(output)) {
      throw new Error(`Output schema rejected ${execution.node.id}: ${ajv.errorsText(validate.errors)}`);
    }
    if (execution.mode === "simulated" || agentMessageCount === 0) {
      await writeMessage("message:result", summarizeOutput(output));
    }
    const receipt = await commitCompletionReceipt({
      execution,
      promptSha256,
      outputSchemaSha256,
      output,
      ...(runtime.providerSessionId ? { providerSessionId: runtime.providerSessionId } : {}),
      ...(sessionAffinity() ? { sessionAffinity: sessionAffinity() } : {}),
      afterPrimary: () => pauseAfterPrimaryReceipt(execution, attempt),
    });
    const completed = completionTransition(execution);
    await recordTransitionStore(
      transition(
        execution,
        `attempt:${attempt}:completed`,
        completed.type,
        completed.message,
        {
          attempt,
          iteration: execution.iteration,
          recoveryCycle: execution.recoveryCycle,
          ...(execution.queueItem ? { queueItem: execution.queueItem } : {}),
          output,
          outputHash: receipt.outputSha256,
          receiptSha256: receipt.receiptSha256,
          ...(runtime.providerSessionId ? { providerSessionId: runtime.providerSessionId } : {}),
          durationMs: Date.now() - started,
          artifact: paths.acceptedOutputPath.slice(runDirectory(execution.runId).length + 1),
        },
      ),
    );
    return {
      output,
      ...(runtime.providerSessionId ? { providerSessionId: runtime.providerSessionId } : {}),
      ...(sessionAffinity() ? { sessionAffinity: sessionAffinity() } : {}),
      recoveredFromReceipt: false,
      receiptSha256: receipt.receiptSha256,
    };
  } catch (error) {
    if (context.cancellationSignal.aborted) throw error;
    const failure = { ...classifyAgentFailure(error, runtime.providerSessionId), ...(sessionAffinity() ? { sessionAffinity: sessionAffinity() } : {}) };
    await recordTransitionStore(
      transition(
        execution,
        `attempt:${attempt}:failed`,
        "node.failed",
        `${execution.node.title} attempt failed`,
        {
          attempt,
          iteration: execution.iteration,
          recoveryCycle: execution.recoveryCycle,
          error: failure.message,
          failureKind: failure.kind,
          ...(failure.providerSessionId ? { providerSessionId: failure.providerSessionId } : {}),
        },
      ),
    );
    throw ApplicationFailure.create({
      message: PUBLIC_AGENT_FAILURE,
      type: "AgentProviderFailure",
      nonRetryable: ["context_exhausted", "output_limit", "invalid_output", "integrity_error"].includes(failure.kind),
      details: [failure],
    });
  }
}

export async function executeAgent(execution: AgentExecutionInput): Promise<AgentExecutionResult> {
  return executeAgentInternal(execution);
}

export { commitScopeIteration, commitHumanAnswer } from "./scope-artifacts";
