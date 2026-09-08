import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  condition,
  defineUpdate,
  proxyActivities,
  patched,
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
  ProviderSessionAffinity,
  TransitionInput,
  WorkflowRunInput,
} from "./contracts";
import { resolveForEachItems, resolveNodeInputs, resolveValue } from "./resolver";
import { loopSatisfied } from "./loop";
import { AGENT_HEARTBEAT_TIMEOUT } from "./execution-policy";
import { takeQueueWork, type QueueWorkItem } from "./queue";

export const submitAgentRecoveryUpdate = defineUpdate<AgentRecoveryReceipt, [AgentRecoveryCommand]>("submitAgentRecovery");
export const submitHumanInputUpdate = defineUpdate<HumanAnswerReceipt, [HumanAnswerCommand]>("submitHumanInput");

const administrative = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

const executors = [1, 2, 3, 4, 5].map((maximumAttempts) =>
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
  }).executeAgent,
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
    ...(run.execution ? { execution: run.execution } : {}),
    type,
    message,
    ...extras,
  };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
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

export async function stewardWorkflow(run: WorkflowRunInput): Promise<Record<string, JsonValue>> {
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
    baseTransition(run, temporalRunId, `${run.runId}:run:started`, "run.started", "Durable Steward workflow started", {
      data: {
        sourcePath: run.definition.sourcePath,
        definitionHash: run.definition.definitionHash,
        mode: run.mode,
        workflowType: "stewardWorkflow",
        ...(run.execution ? { execution: { ...run.execution } } : {}),
      },
    }),
  );

  const usesScopes = run.definition.nodes.some(node => node.kind === "scope");
  let expandedInstances = 0;
  const reserveInstances = (count: number): void => {
    if (!usesScopes) return;
    if (expandedInstances + count > 1000) throw new Error("Scope expansion exceeds 1000 step instances");
    expandedInstances += count;
  };

  const executeHumanNode = async (
    node: WorkflowRunInput["definition"]["nodes"][number],
    input: Record<string, JsonValue>,
    nodeWave: number,
  ): Promise<JsonValue> => {
    reserveInstances(1);
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
    await (node.id.includes("~") ? administrative.commitHumanAnswer : administrative.recordTransition)(
      baseTransition(
        run,
        temporalRunId,
        `${requestId}:completed`,
        "node.completed",
        `${node.title} committed the human answer`,
        {
          nodeId: node.id,
          wave: nodeWave,
          data: { output, ...(node.id.includes("~") ? { requestId } : {}), durationMs: Math.max(0, Date.parse(receivedAt) - Date.parse(startedAt)) },
        },
      ),
    );
    return output;
  };

  type PermitWaiter = QueueWorkItem & {
    token: number;
    resolve: (release: () => void) => void;
  };
  const groupLimits = Object.fromEntries(
    run.definition.groups.map((group) => [
      group.id,
      group.max_parallelism ?? run.definition.defaults.max_parallelism,
    ]),
  );
  const activeGroups: Record<string, number> = Object.create(null) as Record<string, number>;
  const activeNodes: Record<string, number> = Object.create(null) as Record<string, number>;
  let activePermitCount = 0;
  let permitToken = 0;
  let permitWaiters: PermitWaiter[] = [];

  const grantPermits = (): void => {
    const next = takeQueueWork(
      permitWaiters,
      run.definition.defaults.max_parallelism - activePermitCount,
      groupLimits,
      activeGroups,
      activeNodes,
    );
    permitWaiters = next.remaining;
    for (const waiter of next.selected) {
      const groupKey = waiter.group ?? "__ungrouped";
      activePermitCount += 1;
      activeGroups[groupKey] = (activeGroups[groupKey] ?? 0) + 1;
      activeNodes[waiter.nodeId] = (activeNodes[waiter.nodeId] ?? 0) + 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        activePermitCount -= 1;
        activeGroups[groupKey] -= 1;
        activeNodes[waiter.nodeId] -= 1;
        grantPermits();
      });
    }
  };

  const acquireExecutionPermit = (
    node: WorkflowRunInput["definition"]["nodes"][number],
  ): Promise<() => void> => new Promise((resolve) => {
    permitWaiters.push({
      token: permitToken++,
      nodeId: node.id,
      group: node.group,
      nodeMaxParallelism: node.for_each?.max_parallelism,
      resolve,
    });
    grantPermits();
  });

  type SessionOwner = { sessions: Map<string, ProviderSessionAffinity>; rootId: string };
  const executeNode = async (
    node: WorkflowRunInput["definition"]["nodes"][number],
    baseInput: Record<string, JsonValue>,
    nodeWave: number,
    queueItem?: { index: number; count: number },
    enclosingIteration?: number,
    sessionOwner?: SessionOwner,
  ): Promise<JsonValue> => {
    const attempts = Math.min(5, Math.max(1, run.definition.defaults.retry.maximum_attempts));
    let previous: JsonValue | undefined;
    const sessionKey = sessionOwner ? `${node.id.slice(sessionOwner.rootId.length).replace(/~[0-9]+/g, "")}${queueItem ? `[${queueItem.index}]` : ""}` : undefined;
    let sessionAffinity = sessionKey ? sessionOwner!.sessions.get(sessionKey) : undefined;
    let providerSessionId: string | undefined = sessionAffinity?.sessionId;
    const maximum = node.loop?.max_iterations ?? 1;

    for (let iteration = 1; iteration <= maximum; iteration += 1) {
      reserveInstances(1);
      const executionIteration = queueItem ? queueItem.index + 1 : iteration;
      const input = {
        ...baseInput,
        ...(node.loop && previous !== undefined ? { [node.loop.carry_as]: previous } : {}),
        ...(node.loop ? { __iteration: iteration } : {}),
        ...(queueItem ? { __queue_index: queueItem.index, __queue_count: queueItem.count } : {}),
      };
      let recoveryCycle = 0;
      let recovery: {
        action: "retry_same_session" | "retry_fresh_session";
        failureKind: AgentFailureSummary["kind"];
        message: string;
      } | undefined;
      let result: Awaited<ReturnType<(typeof executors)[number]>> | undefined;

      while (true) {
        if (workflowAbort) {
          throw ApplicationFailure.create({
            message: workflowAbort.message,
            type: "OperatorAbortedWorkflow",
            nonRetryable: true,
          });
        }
        const receiptToken = uuid4();
        const releasePermit = await acquireExecutionPermit(node);
        const abortAfterPermit = workflowAbort as { nodeId: string; message: string } | undefined;
        if (abortAfterPermit) {
          releasePermit();
          throw ApplicationFailure.create({
            message: abortAfterPermit.message,
            type: "OperatorAbortedWorkflow",
            nonRetryable: true,
          });
        }
        let activityError: unknown;
        try {
          result = await executors[attempts - 1]({
            runId: run.runId,
            temporalRunId,
            definition: run.definition,
            ...(run.execution ? { execution: run.execution } : {}),
            node,
            input,
            mode: run.mode === "workflow" ? node.agent : run.mode,
            delayMs: run.delayMs,
            wave: nodeWave,
            iteration: executionIteration,
            ...(enclosingIteration && !node.loop && !queueItem ? { simulationIteration: enclosingIteration } : {}),
            ...(queueItem ? { queueItem } : {}),
            recoveryCycle,
            receiptToken,
            ...(providerSessionId ? { providerSessionId } : {}),
            ...(sessionOwner ? { captureSessionAffinity: true as const, ...(sessionAffinity ? { sessionAffinity } : {}) } : {}),
            ...(recovery ? { recovery } : {}),
          });
        } catch (error) {
          activityError = error;
        } finally {
          releasePermit();
        }
        if (activityError === undefined) break;

        const failure = recoveryFailure(activityError, providerSessionId);
        const requestId = `${run.runId}:${node.id}:iteration:${executionIteration}:recovery:${recoveryCycle + 1}`;
        const requestedAt = new Date().toISOString();
        const request: AgentRecoveryRequest = {
          requestId,
          nodeId: node.id,
          iteration: executionIteration,
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
        if (sessionOwner) {
          sessionAffinity = command.action === "retry_same_session" ? failure.sessionAffinity : undefined;
          sessionOwner.sessions.delete(sessionKey!);
        }
        recovery = {
          action: command.action,
          failureKind: failure.kind,
          message: failure.message,
        };
        recoveryCycle += 1;
      }

      if (!result) {
        throw ApplicationFailure.create({
          message: `${node.id} ended without an Activity result`,
          type: "MissingActivityResultError",
          nonRetryable: true,
        });
      }
      providerSessionId = result.providerSessionId;
      if (sessionOwner) {
        sessionAffinity = result.sessionAffinity;
        if (sessionAffinity) sessionOwner.sessions.set(sessionKey!, sessionAffinity);
        else sessionOwner.sessions.delete(sessionKey!);
      }
      if (!node.loop) return result.output;
      const publishOutcome = patched("steward-loop-outcomes-v1");
      if (loopSatisfied(node.loop, result.output)) {
        if (publishOutcome) await administrative.recordTransition(baseTransition(run, temporalRunId, `${run.runId}:${node.id}:iteration:${iteration}:satisfied`, "loop.satisfied", `${node.title} met its loop condition`, {
          nodeId: node.id, wave: nodeWave, data: { iteration, loopOutcome: "condition_met" },
        }));
        return result.output;
      }
      previous = result.output;
      const exhausted = iteration === maximum;
      await administrative.recordTransition(
        baseTransition(
          run,
          temporalRunId,
          `${run.runId}:${node.id}:iteration:${iteration}:${exhausted ? "exhausted" : "continued"}`,
          exhausted ? "loop.exhausted" : "loop.continued",
          exhausted ? `${node.title} reached its iteration limit` : `${node.title} requested iteration ${iteration + 1}`,
          { nodeId: node.id, wave: nodeWave, data: { iteration, accepted: exhausted && node.loop.on_exhaustion === "accept_last", ...(publishOutcome && exhausted ? { loopOutcome: node.loop.on_exhaustion === "accept_last" ? "exhausted_accepted" : "exhausted_failed" } : {}) } },
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

  const executeScope = async (
    node: WorkflowRunInput["definition"]["nodes"][number],
    input: Record<string, JsonValue>,
    nodeWave: number,
    enclosingIteration?: number,
    inheritedState?: JsonValue,
    inheritedSessionOwner?: SessionOwner,
  ): Promise<JsonValue> => {
    const sessionOwner = node.loop
      ? node.loop.agent_sessions === "resume" ? { rootId: node.id, sessions: new Map<string, ProviderSessionAffinity>() } : undefined
      : inheritedSessionOwner;
    let state = node.loop ? resolveValue(node.loop.initial ?? {}, input, {}) : inheritedState;
    const maximum = node.loop?.max_iterations ?? 1;
    for (let iteration = 1; iteration <= maximum; iteration++) {
      reserveInstances(1);
      const prefix = `${node.id}~${iteration}`;
      await administrative.recordTransition(baseTransition(run, temporalRunId, `${run.runId}:${prefix}:started`, "node.started", `${node.title} started scope iteration ${iteration}`, {
        nodeId: node.id, wave: nodeWave, data: { iteration, input },
      }));
      const children = node.nodes!;
      const localOutputs: Record<string, JsonValue> = {};
      const localCompleted = new Set<string>();
      const instances = Object.fromEntries(children.map(child => [child.id, {
        ...child, id: `${prefix}.${child.id}`, needs: child.needs.map(id => `${prefix}.${id}`),
      }]));
      for (const child of children) {
        const instance = instances[child.id];
        await administrative.recordTransition(baseTransition(run, temporalRunId, `${run.runId}:${instance.id}:registered`, "node.registered", `${child.title} entered scope ${node.title}`, {
          nodeId: instance.id, wave: nodeWave,
          data: { ...(run.mode === "workflow" ? { agent: child.agent } : {}), title: child.title, kind: child.kind, definitionId: child.id, parentId: node.id, needs: instance.needs },
        }));
      }
      while (localCompleted.size < children.length) {
        const ready = children.filter(child => !localCompleted.has(child.id) && child.needs.every(id => localCompleted.has(id)));
        if (!ready.length) throw new Error(`Scope ${node.id} has no runnable nodes`);
        const results = await Promise.allSettled(ready.map(async child => {
          const instance = instances[child.id];
          const resolved = resolveNodeInputs(child, input, localOutputs, state);
          const simulationIteration = node.loop ? iteration : enclosingIteration;
          let output: JsonValue;
          if (child.kind === "scope") output = await executeScope(instance, resolved, nodeWave, simulationIteration, state, sessionOwner);
          else if (child.kind === "human") output = await executeHumanNode(instance, resolved, nodeWave);
          else if (child.for_each) {
            const items = resolveForEachItems(child, input, localOutputs);
            if (expandedInstances + items.length > 1000) throw new Error("Scope expansion exceeds 1000 step instances");
            const mapped = await Promise.allSettled(items.map((item, index) => executeNode(instance, { ...resolved, [child.for_each!.as]: item }, nodeWave, { index, count: items.length }, simulationIteration, sessionOwner)));
            const failed = mapped.find(result => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
            output = mapped.map(result => (result as PromiseFulfilledResult<JsonValue>).value);
            await administrative.recordTransition(baseTransition(run, temporalRunId, `${run.runId}:${instance.id}:queue:completed`, "node.completed", `${child.title} committed queued outputs`, {
              nodeId: instance.id, wave: nodeWave, data: { output, completedItems: items.length, totalItems: items.length },
            }));
          } else output = await executeNode(instance, resolved, nodeWave, undefined, simulationIteration, sessionOwner);
          return { id: child.id, output };
        }));
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") {
            localOutputs[result.value.id] = result.value.output;
            localCompleted.add(result.value.id);
          } else {
            const failedNode = instances[ready[index].id];
            await administrative.recordTransition(baseTransition(run, temporalRunId, `${run.runId}:${failedNode.id}:scope-child:failed`, "node.failed", `${failedNode.title} failed`, {
              nodeId: failedNode.id, wave: nodeWave, data: { error: errorMessage(result.reason) },
            }));
          }
        }
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      const output = resolveValue(node.exports!, input, localOutputs, state);
      await administrative.commitScopeIteration(baseTransition(run, temporalRunId, `${run.runId}:${prefix}:committed`, "scope.iteration_committed", `${node.title} committed scope iteration ${iteration}`, {
        nodeId: node.id, wave: nodeWave, data: { iteration, output, scopeInput: input, ...(state === undefined ? {} : { state }), children: Object.values(instances).map(child => child.id) },
      }));
      const satisfied = !node.loop || loopSatisfied({ ...node.loop, predicate_version: 2 }, output);
      const exhausted = !satisfied && iteration === maximum;
      if (satisfied || exhausted) {
        const loopOutcome = satisfied ? "condition_met" : node.loop!.on_exhaustion === "accept_last" ? "exhausted_accepted" : "exhausted_failed";
        if (node.loop) await administrative.recordTransition(baseTransition(run, temporalRunId, `${run.runId}:${prefix}:outcome`, exhausted ? "loop.exhausted" : "loop.satisfied", `${node.title}: ${loopOutcome}`, {
          nodeId: node.id, wave: nodeWave, data: { iteration, loopOutcome, accepted: loopOutcome !== "exhausted_failed" },
        }));
        if (loopOutcome === "exhausted_failed") throw new Error(`${node.id} did not satisfy its loop condition after ${maximum} iterations`);
        await administrative.recordTransition(baseTransition(run, temporalRunId, `${run.runId}:${node.id}:scope:completed`, "node.completed", `${node.title} committed its exported output`, {
          nodeId: node.id, wave: nodeWave, data: { output, iteration, ...(node.loop ? { loopOutcome } : {}) },
        }));
        return output;
      }
      state = resolveValue(node.loop!.next ?? {}, input, {}, state, output);
      await administrative.recordTransition(baseTransition(run, temporalRunId, `${run.runId}:${prefix}:continued`, "loop.continued", `${node.title} requested iteration ${iteration + 1}`, {
        nodeId: node.id, wave: nodeWave, data: { iteration },
      }));
    }
    throw new Error(`Scope ${node.id} ended without a result`);
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
      const mappedResults: Record<string, JsonValue[]> = {};
      const mappedFailures: Record<string, string[]> = {};

      type WorkUnit = {
        node: WorkflowRunInput["definition"]["nodes"][number];
        input: Record<string, JsonValue>;
        itemIndex?: number;
        itemCount?: number;
      };
      const work: WorkUnit[] = [];
      for (const node of ready) {
        const resolved = resolveNodeInputs(node, run.initialInput, outputs);
        if (!node.for_each) {
          work.push({ node, input: resolved });
          continue;
        }
        const items = resolveForEachItems(node, run.initialInput, outputs);
        if (usesScopes && expandedInstances + work.length + items.length > 1000) throw new Error("Scope expansion exceeds 1000 step instances");
        mappedResults[node.id] = new Array<JsonValue>(items.length);
        items.forEach((item, itemIndex) => {
          work.push({
            node,
            input: { ...resolved, [node.for_each!.as]: item },
            itemIndex,
            itemCount: items.length,
          });
        });
      }

      const results = await Promise.allSettled(
        work.map((unit) => unit.node.kind === "scope"
          ? executeScope(unit.node, unit.input, wave)
          : unit.node.kind === "human"
          ? executeHumanNode(unit.node, unit.input, wave)
          : executeNode(
              unit.node,
              unit.input,
              wave,
              unit.itemIndex === undefined
                ? undefined
                : { index: unit.itemIndex, count: unit.itemCount! },
            )),
      );
      results.forEach((result, resultIndex) => {
        const unit = work[resultIndex];
        if (result.status === "fulfilled") {
          if (unit.itemIndex === undefined) outputs[unit.node.id] = result.value;
          else mappedResults[unit.node.id][unit.itemIndex] = result.value;
        } else {
          const label = unit.itemIndex === undefined ? unit.node.id : `${unit.node.id}[${unit.itemIndex}]`;
          const message = `${label}: ${errorMessage(result.reason)}`;
          failures.push(message);
          if (unit.itemIndex !== undefined) {
            (mappedFailures[unit.node.id] ??= []).push(message);
          }
        }
      });
      if (failures.length > 0) {
        for (const [nodeId, errors] of Object.entries(mappedFailures)) {
          const node = ready.find((candidate) => candidate.id === nodeId)!;
          await administrative.recordTransition(
            baseTransition(
              run,
              temporalRunId,
              `${run.runId}:${nodeId}:queue:failed`,
              "node.failed",
              `${node.title} stopped after ${errors.length} queued item${errors.length === 1 ? "" : "s"} failed`,
              { nodeId, wave, data: { error: errors.join("; ") } },
            ),
          );
        }
        throw ApplicationFailure.create({
          message: failures.join("; "),
          type: workflowAbort ? "OperatorAbortedWorkflow" : "NodeExecutionError",
          nonRetryable: true,
        });
      }
      for (const node of ready) {
        if (!node.for_each) continue;
        const output = mappedResults[node.id];
        outputs[node.id] = output;
        await administrative.recordTransition(
          baseTransition(
            run,
            temporalRunId,
            `${run.runId}:${node.id}:queue:completed`,
            "node.completed",
            `${node.title} committed ${output.length} queued item${output.length === 1 ? "" : "s"}`,
            {
              nodeId: node.id,
              wave,
              data: { output, completedItems: output.length, totalItems: output.length },
            },
          ),
        );
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
    if (error instanceof ApplicationFailure || error instanceof ActivityFailure) throw error;
    throw ApplicationFailure.create({
      message,
      type: "WorkflowRuntimeValidationError",
      nonRetryable: true,
    });
  }
}
