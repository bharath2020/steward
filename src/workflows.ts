import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  condition,
  defineUpdate,
  proxyActivities,
  setHandler,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  AgentFailureSummary,
  AgentRecoveryCommand,
  AgentRecoveryReceipt,
  AgentRecoveryRequest,
  HumanAnswerCommand,
  HumanAnswerReceipt,
  HumanInputRequest,
  JsonValue,
  TransitionInput,
  WorkflowRunInput,
} from "./contracts";
import { resolveNodeInputs } from "./resolver";
import { loopSatisfied } from "./loop";
import { AGENT_HEARTBEAT_TIMEOUT } from "./execution-policy";

export const submitAgentRecoveryUpdate = defineUpdate<AgentRecoveryReceipt, [AgentRecoveryCommand]>("submitAgentRecovery");
export const submitHumanInputUpdate = defineUpdate<HumanAnswerReceipt, [HumanAnswerCommand]>("submitHumanInput");

const administrative = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

const executors = [1, 2, 3, 4, 5].map((maximumAttempts) =>
  proxyActivities<typeof activities>({
    startToCloseTimeout: "30 minutes",
    heartbeatTimeout: "10 seconds",
    retry: {
      maximumAttempts,
      initialInterval: "1 second",
      backoffCoefficient: 2,
      maximumInterval: "15 seconds",
      nonRetryableErrorTypes: ["OutputValidationError"],
    },
  }).executeAgent,
);

const resilientExecutors = [1, 2, 3, 4, 5].map((maximumAttempts) =>
  proxyActivities<typeof activities>({
    startToCloseTimeout: "12 hours",
    heartbeatTimeout: AGENT_HEARTBEAT_TIMEOUT,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      maximumAttempts,
      initialInterval: "1 second",
      backoffCoefficient: 2,
      maximumInterval: "15 seconds",
    },
  }).executeAgentV2,
);

function baseTransition(
  run: WorkflowRunInput,
  temporalRunId: string,
  id: string,
  type: string,
  message: string,
  extras: Partial<TransitionInput> = {},
): TransitionInput {
  return {
    id,
    runId: run.runId,
    temporalRunId,
    definition: run.definition,
    mode: run.mode,
    initialInput: run.initialInput,
    type,
    message,
    ...extras,
  };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function readyBatches(run: WorkflowRunInput, ready: WorkflowRunInput["definition"]["nodes"]): WorkflowRunInput["definition"]["nodes"][] {
  const remaining = [...ready];
  const batches: WorkflowRunInput["definition"]["nodes"][] = [];
  const groups = Object.fromEntries(run.definition.groups.map((group) => [group.id, group]));
  while (remaining.length) {
    const counts: Record<string, number> = {};
    const batch: typeof ready = [];
    for (let index = 0; index < remaining.length && batch.length < run.definition.defaults.max_parallelism;) {
      const node = remaining[index];
      const key = node.group ?? "__ungrouped";
      const limit = node.group ? groups[node.group]?.max_parallelism ?? run.definition.defaults.max_parallelism : run.definition.defaults.max_parallelism;
      if ((counts[key] ?? 0) < limit) {
        counts[key] = (counts[key] ?? 0) + 1;
        batch.push(node);
        remaining.splice(index, 1);
      } else index += 1;
    }
    if (!batch.length) throw new Error("Group concurrency limits blocked every ready node");
    batches.push(batch);
  }
  return batches;
}

async function executeNode(
  run: WorkflowRunInput,
  temporalRunId: string,
  node: WorkflowRunInput["definition"]["nodes"][number],
  baseInput: Record<string, JsonValue>,
  wave: number,
): Promise<JsonValue> {
  const attempts = Math.min(5, Math.max(1, run.definition.defaults.retry.maximum_attempts));
  let previous: JsonValue | undefined;
  const maximum = node.loop?.max_iterations ?? 1;
  for (let iteration = 1; iteration <= maximum; iteration += 1) {
    const input = {
      ...baseInput,
      ...(node.loop && previous !== undefined ? { [node.loop.carry_as]: previous } : {}),
      ...(node.loop ? { __iteration: iteration } : {}),
    };
    const result = await executors[attempts - 1]({
      runId: run.runId,
      temporalRunId,
      definition: run.definition,
      node,
      input,
      mode: run.mode,
      delayMs: run.delayMs,
      wave,
      iteration,
    });
    if (!node.loop || loopSatisfied(node.loop, result)) return result;
    previous = result;
    const exhausted = iteration === maximum;
    await administrative.recordTransition(
      baseTransition(
        run,
        temporalRunId,
        `${run.runId}:${node.id}:iteration:${iteration}:${exhausted ? "exhausted" : "continued"}`,
        exhausted ? "loop.exhausted" : "loop.continued",
        exhausted ? `${node.title} reached its iteration limit` : `${node.title} requested iteration ${iteration + 1}`,
        { nodeId: node.id, wave, data: { iteration, accepted: exhausted && node.loop.on_exhaustion === "accept_last" } },
      ),
    );
    if (exhausted) {
      if (node.loop.on_exhaustion === "accept_last") return result;
      throw ApplicationFailure.create({
        message: `${node.id} did not satisfy its loop condition after ${maximum} iterations`,
        type: "LoopExhaustedError",
        nonRetryable: true,
      });
    }
  }
  throw new Error(`Loop for ${node.id} ended without a result`);
}

export async function yamlAgentWorkflow(run: WorkflowRunInput): Promise<Record<string, JsonValue>> {
  const temporalRunId = workflowInfo().runId;
  const outputs: Record<string, JsonValue> = {};
  const completed = new Set<string>();
  let wave = 0;

  await administrative.initializeRun(
    baseTransition(run, temporalRunId, `${run.runId}:run:started`, "run.started", "Durable workflow started", {
      data: {
        sourcePath: run.definition.sourcePath,
        definitionHash: run.definition.definitionHash,
        mode: run.mode,
      },
    }),
  );

  try {
    while (completed.size < run.definition.nodes.length) {
      const ready = run.definition.nodes.filter(
        (node) => !completed.has(node.id) && node.needs.every((dependency) => completed.has(dependency)),
      );
      if (ready.length === 0) {
        throw ApplicationFailure.create({
          message: "No runnable nodes remain; the graph is blocked",
          type: "BlockedGraphError",
          nonRetryable: true,
        });
      }
      wave += 1;
      await administrative.recordTransition(
        baseTransition(run, temporalRunId, `${run.runId}:wave:${wave}:started`, "wave.started", `Wave ${wave} released ${ready.length} agent${ready.length === 1 ? "" : "s"}`, {
          wave,
          data: { nodes: ready.map((node) => node.id) },
        }),
      );

      const failures: string[] = [];
      for (const chunk of readyBatches(run, ready)) {
        const results = await Promise.allSettled(
          chunk.map((node) => {
            return executeNode(run, temporalRunId, node, resolveNodeInputs(node, run.initialInput, outputs), wave);
          }),
        );
        results.forEach((result, resultIndex) => {
          const node = chunk[resultIndex];
          if (result.status === "fulfilled") outputs[node.id] = result.value;
          else failures.push(`${node.id}: ${errorMessage(result.reason)}`);
        });
      }
      if (failures.length > 0) {
        throw ApplicationFailure.create({
          message: failures.join("; "),
          type: "NodeExecutionError",
          nonRetryable: true,
        });
      }
      ready.forEach((node) => completed.add(node.id));
      await administrative.recordTransition(
        baseTransition(run, temporalRunId, `${run.runId}:wave:${wave}:completed`, "wave.completed", `Wave ${wave} committed; joins re-evaluated`, {
          wave,
          data: { nodes: ready.map((node) => node.id) },
        }),
      );
    }

    await administrative.recordTransition(
      baseTransition(run, temporalRunId, `${run.runId}:run:completed`, "run.completed", "All agent outputs committed", {
        wave,
        data: { outputs },
      }),
    );
    return outputs;
  } catch (error) {
    const message = errorMessage(error);
    await administrative.recordTransition(
      baseTransition(run, temporalRunId, `${run.runId}:run:failed`, "run.failed", "Workflow stopped after a failed node", {
        wave,
        data: { error: message },
      }),
    );
    throw error;
  }
}

function isAgentFailureSummary(value: unknown): value is AgentFailureSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentFailureSummary>;
  return candidate.schema === "agent-failure.v1"
    && ["network", "context_exhausted", "output_limit", "invalid_output", "provider_error", "integrity_error", "unknown"].includes(String(candidate.kind))
    && typeof candidate.message === "string";
}

function recoveryFailure(error: unknown, previousSessionId?: string): AgentFailureSummary {
  const cause = error instanceof ActivityFailure ? error.cause : undefined;
  const detail = cause instanceof ApplicationFailure
    ? cause.details?.find(isAgentFailureSummary)
    : undefined;
  if (detail) return detail.providerSessionId || !previousSessionId
    ? detail
    : { ...detail, providerSessionId: previousSessionId };
  return {
    schema: "agent-failure.v1",
    kind: "unknown",
    message: "The agent turn failed after its automatic recovery attempts.",
    ...(previousSessionId ? { providerSessionId: previousSessionId } : {}),
  };
}

/**
 * V2 adds session-aware retry, durable operator recovery, and hash-bound
 * completion reconciliation. V1 remains above unchanged for open-history replay.
 */
export async function yamlAgentWorkflowV2(run: WorkflowRunInput): Promise<Record<string, JsonValue>> {
  const temporalRunId = workflowInfo().runId;
  const outputs: Record<string, JsonValue> = {};
  const completed = new Set<string>();
  const recoveryRequests: Record<string, AgentRecoveryRequest> = {};
  const recoveryCommands: Record<string, AgentRecoveryCommand> = {};
  const humanRequests: Record<string, HumanInputRequest> = {};
  const humanAnswers: Record<string, HumanAnswerCommand> = {};
  let workflowAbort: { nodeId: string; message: string } | undefined;
  let wave = 0;

  setHandler(
    submitHumanInputUpdate,
    (command): HumanAnswerReceipt => {
      const request = humanRequests[command.requestId];
      if (!request) throw new Error("Human input request does not exist.");
      const acceptedAt = new Date().toISOString();
      const answer = command.answer.trim();
      humanAnswers[command.requestId] = { requestId: command.requestId, answer };
      request.answer = answer;
      request.status = "received";
      request.receivedAt = acceptedAt;
      return { requestId: command.requestId, accepted: true, acceptedAt };
    },
    {
      validator: (command) => {
        const request = humanRequests[command.requestId];
        if (!request) throw new Error("Human input request does not exist.");
        if (request.status !== "waiting") throw new Error("This human input request was already answered.");
        if (typeof command.answer !== "string" || !command.answer.trim()) throw new Error("A non-empty answer is required.");
      },
    },
  );

  setHandler(
    submitAgentRecoveryUpdate,
    (command): AgentRecoveryReceipt => {
      const request = recoveryRequests[command.requestId];
      if (!request) throw new Error("Recovery request does not exist.");
      const acceptedAt = new Date().toISOString();
      recoveryCommands[command.requestId] = { ...command };
      request.command = { ...command };
      request.status = "received";
      request.receivedAt = acceptedAt;
      return { requestId: command.requestId, action: command.action, accepted: true, acceptedAt };
    },
    {
      validator: (command) => {
        const request = recoveryRequests[command.requestId];
        if (!request) throw new Error("Recovery request does not exist.");
        if (request.status !== "waiting") throw new Error("This recovery request was already handled.");
        if (!["retry_same_session", "retry_fresh_session", "abort_workflow"].includes(command.action)) {
          throw new Error("Recovery action is invalid.");
        }
        if (command.action === "retry_same_session" && !request.canResumeSession) {
          throw new Error("This agent has no safe provider session to resume.");
        }
      },
    },
  );

  await administrative.initializeRun(
    baseTransition(run, temporalRunId, `${run.runId}:run:started`, "run.started", "Durable workflow V2 started", {
      data: {
        sourcePath: run.definition.sourcePath,
        definitionHash: run.definition.definitionHash,
        mode: run.mode,
        workflowType: "yamlAgentWorkflowV2",
      },
    }),
  );

  const executeHumanNodeV2 = async (
    node: WorkflowRunInput["definition"]["nodes"][number],
    input: Record<string, JsonValue>,
    nodeWave: number,
  ): Promise<JsonValue> => {
    const question = input.question;
    if (typeof question !== "string" || !question.trim()) {
      throw ApplicationFailure.create({
        message: `${node.id} resolved an empty human question`,
        type: "InvalidHumanQuestionError",
        nonRetryable: true,
      });
    }
    const startedAt = new Date().toISOString();
    const requestId = `${run.runId}:${node.id}:human`;
    const request: HumanInputRequest = {
      requestId,
      nodeId: node.id,
      question: question.trim(),
      status: "waiting",
      requestedAt: startedAt,
    };
    humanRequests[requestId] = request;
    await administrative.recordTransition(
      baseTransition(
        run,
        temporalRunId,
        `${requestId}:started`,
        "node.started",
        `${node.title} opened a human input gate`,
        { nodeId: node.id, wave: nodeWave, data: { attempt: 1, iteration: 1, input } },
      ),
    );
    await administrative.recordTransition(
      baseTransition(
        run,
        temporalRunId,
        `${requestId}:required`,
        "human.required",
        `${node.title} is waiting for your answer`,
        { nodeId: node.id, wave: nodeWave, data: { request: request as unknown as JsonValue } },
      ),
    );
    await condition(() => Boolean(humanAnswers[requestId]) || Boolean(workflowAbort));
    if (workflowAbort && !humanAnswers[requestId]) {
      throw ApplicationFailure.create({
        message: workflowAbort.message,
        type: "OperatorAbortedWorkflow",
        nonRetryable: true,
      });
    }
    const accepted = humanAnswers[requestId]!;
    const receivedAt = request.receivedAt ?? new Date().toISOString();
    await administrative.recordTransition(
      baseTransition(
        run,
        temporalRunId,
        `${requestId}:accepted`,
        "human.accepted",
        `${node.title} accepted the operator answer`,
        { nodeId: node.id, wave: nodeWave, data: { requestId, answer: accepted.answer, receivedAt } },
      ),
    );
    const output: JsonValue = { answer: accepted.answer };
    await administrative.recordTransition(
      baseTransition(
        run,
        temporalRunId,
        `${requestId}:completed`,
        "node.completed",
        `${node.title} committed the human answer`,
        {
          nodeId: node.id,
          wave: nodeWave,
          data: { output, durationMs: Math.max(0, Date.parse(receivedAt) - Date.parse(startedAt)) },
        },
      ),
    );
    return output;
  };

  const executeNodeV2 = async (
    node: WorkflowRunInput["definition"]["nodes"][number],
    baseInput: Record<string, JsonValue>,
    nodeWave: number,
  ): Promise<JsonValue> => {
    const attempts = Math.min(5, Math.max(1, run.definition.defaults.retry.maximum_attempts));
    let previous: JsonValue | undefined;
    let providerSessionId: string | undefined;
    const maximum = node.loop?.max_iterations ?? 1;

    for (let iteration = 1; iteration <= maximum; iteration += 1) {
      const input = {
        ...baseInput,
        ...(node.loop && previous !== undefined ? { [node.loop.carry_as]: previous } : {}),
        ...(node.loop ? { __iteration: iteration } : {}),
      };
      let recoveryCycle = 0;
      let recovery: {
        action: "retry_same_session" | "retry_fresh_session";
        failureKind: AgentFailureSummary["kind"];
        message: string;
      } | undefined;
      let result: Awaited<ReturnType<(typeof resilientExecutors)[number]>>;

      while (true) {
        if (workflowAbort) {
          throw ApplicationFailure.create({
            message: workflowAbort.message,
            type: "OperatorAbortedWorkflow",
            nonRetryable: true,
          });
        }
        const receiptToken = uuid4();
        try {
          result = await resilientExecutors[attempts - 1]({
            runId: run.runId,
            temporalRunId,
            definition: run.definition,
            node,
            input,
            mode: run.mode,
            delayMs: run.delayMs,
            wave: nodeWave,
            iteration,
            recoveryCycle,
            receiptToken,
            ...(providerSessionId ? { providerSessionId } : {}),
            ...(recovery ? { recovery } : {}),
          });
          break;
        } catch (error) {
          const failure = recoveryFailure(error, providerSessionId);
          const requestId = `${run.runId}:${node.id}:iteration:${iteration}:recovery:${recoveryCycle + 1}`;
          const requestedAt = new Date().toISOString();
          const request: AgentRecoveryRequest = {
            requestId,
            nodeId: node.id,
            iteration,
            recoveryCycle: recoveryCycle + 1,
            status: "waiting",
            failure,
            canResumeSession: Boolean(failure.providerSessionId)
              && failure.kind !== "context_exhausted"
              && failure.kind !== "integrity_error",
            requestedAt,
          };
          recoveryRequests[requestId] = request;
          await administrative.recordTransition(
            baseTransition(
              run,
              temporalRunId,
              `${requestId}:required`,
              "recovery.required",
              `${node.title} exhausted its automatic attempts and needs an operator decision`,
              {
                nodeId: node.id,
                wave: nodeWave,
                data: { request: request as unknown as JsonValue },
              },
            ),
          );
          await condition(() => Boolean(recoveryCommands[requestId]) || Boolean(workflowAbort));
          const concurrentAbort = workflowAbort as { nodeId: string; message: string } | undefined;
          if (concurrentAbort && !recoveryCommands[requestId]) {
            throw ApplicationFailure.create({
              message: concurrentAbort.message,
              type: "OperatorAbortedWorkflow",
              nonRetryable: true,
            });
          }
          const command = recoveryCommands[requestId]!;
          await administrative.recordTransition(
            baseTransition(
              run,
              temporalRunId,
              `${requestId}:accepted`,
              "recovery.accepted",
              command.action === "retry_same_session"
                ? `${node.title} will resume its recorded provider session with a fresh attempt budget`
                : command.action === "retry_fresh_session"
                  ? `${node.title} will restart in a fresh provider session with a fresh attempt budget`
                  : `${node.title} was aborted by the operator`,
              {
                nodeId: node.id,
                wave: nodeWave,
                data: {
                  requestId,
                  action: command.action,
                  receivedAt: request.receivedAt ?? new Date().toISOString(),
                },
              },
            ),
          );
          if (command.action === "abort_workflow") {
            workflowAbort = { nodeId: node.id, message: `${node.title} was aborted by the operator.` };
            throw ApplicationFailure.create({
              message: workflowAbort.message,
              type: "OperatorAbortedWorkflow",
              nonRetryable: true,
            });
          }
          providerSessionId = command.action === "retry_same_session" ? failure.providerSessionId : undefined;
          recovery = {
            action: command.action,
            failureKind: failure.kind,
            message: failure.message,
          };
          recoveryCycle += 1;
        }
      }

      providerSessionId = result.providerSessionId;
      if (!node.loop || loopSatisfied(node.loop, result.output)) return result.output;
      previous = result.output;
      const exhausted = iteration === maximum;
      await administrative.recordTransition(
        baseTransition(
          run,
          temporalRunId,
          `${run.runId}:${node.id}:iteration:${iteration}:${exhausted ? "exhausted" : "continued"}`,
          exhausted ? "loop.exhausted" : "loop.continued",
          exhausted ? `${node.title} reached its iteration limit` : `${node.title} requested iteration ${iteration + 1}`,
          { nodeId: node.id, wave: nodeWave, data: { iteration, accepted: exhausted && node.loop.on_exhaustion === "accept_last" } },
        ),
      );
      if (exhausted) {
        if (node.loop.on_exhaustion === "accept_last") return result.output;
        throw ApplicationFailure.create({
          message: `${node.id} did not satisfy its loop condition after ${maximum} iterations`,
          type: "LoopExhaustedError",
          nonRetryable: true,
        });
      }
    }
    throw new Error(`Loop for ${node.id} ended without a result`);
  };

  try {
    while (completed.size < run.definition.nodes.length) {
      const ready = run.definition.nodes.filter(
        (node) => !completed.has(node.id) && node.needs.every((dependency) => completed.has(dependency)),
      );
      if (ready.length === 0) {
        throw ApplicationFailure.create({
          message: "No runnable nodes remain; the graph is blocked",
          type: "BlockedGraphError",
          nonRetryable: true,
        });
      }
      wave += 1;
      await administrative.recordTransition(
        baseTransition(run, temporalRunId, `${run.runId}:wave:${wave}:started`, "wave.started", `Wave ${wave} released ${ready.length} agent${ready.length === 1 ? "" : "s"}`, {
          wave,
          data: { nodes: ready.map((node) => node.id) },
        }),
      );

      const failures: string[] = [];
      for (const chunk of readyBatches(run, ready)) {
        const results = await Promise.allSettled(
          chunk.map((node) => {
            const resolved = resolveNodeInputs(node, run.initialInput, outputs);
            return node.kind === "human"
              ? executeHumanNodeV2(node, resolved, wave)
              : executeNodeV2(node, resolved, wave);
          }),
        );
        results.forEach((result, resultIndex) => {
          const node = chunk[resultIndex];
          if (result.status === "fulfilled") outputs[node.id] = result.value;
          else failures.push(`${node.id}: ${errorMessage(result.reason)}`);
        });
      }
      if (failures.length > 0) {
        throw ApplicationFailure.create({
          message: failures.join("; "),
          type: workflowAbort ? "OperatorAbortedWorkflow" : "NodeExecutionError",
          nonRetryable: true,
        });
      }
      ready.forEach((node) => completed.add(node.id));
      await administrative.recordTransition(
        baseTransition(run, temporalRunId, `${run.runId}:wave:${wave}:completed`, "wave.completed", `Wave ${wave} committed; joins re-evaluated`, {
          wave,
          data: { nodes: ready.map((node) => node.id) },
        }),
      );
    }

    await administrative.recordTransition(
      baseTransition(run, temporalRunId, `${run.runId}:run:completed`, "run.completed", "All agent outputs committed", {
        wave,
        data: { outputs },
      }),
    );
    return outputs;
  } catch (error) {
    const message = errorMessage(error);
    await administrative.recordTransition(
      baseTransition(run, temporalRunId, `${run.runId}:run:failed`, "run.failed", "Workflow stopped after a failed node", {
        wave,
        data: { error: message },
      }),
    );
    throw error;
  }
}
