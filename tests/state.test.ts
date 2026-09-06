import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimelineEvent, TransitionInput, WorkflowDefinition } from "../src/contracts";
import { rebuildState } from "../src/store";

const definition: WorkflowDefinition = {
  version: 1,
  name: "test",
  description: "",
  sourcePath: "test.yaml",
  definitionHash: "abc",
  defaults: { provider: "simulated", max_parallelism: 2, delay_ms: 0, retry: { maximum_attempts: 1 } },
  groups: [],
  nodes: [
    { id: "a", title: "A", kind: "agent", agent: "simulated", needs: [], prompt: "A", inputs: {}, outputs: { value: "string" }, outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
    { id: "b", title: "B", kind: "agent", agent: "simulated", needs: ["a"], prompt: "B", inputs: {}, outputs: { value: "string" }, outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
  ],
};

const transition: Pick<TransitionInput, "runId" | "temporalRunId" | "definition" | "mode"> = {
  runId: "run-1",
  temporalRunId: "temporal-1",
  definition,
  mode: "simulated",
};

test("rebuilds operator state from the append-only event timeline", () => {
  const events: TimelineEvent[] = [
    { id: "1", seq: 1, at: "2026-01-01T00:00:00.000Z", type: "run.started", runId: "run-1", message: "started" },
    { id: "2", seq: 2, at: "2026-01-01T00:00:01.000Z", type: "node.started", runId: "run-1", nodeId: "a", wave: 1, message: "started", data: { input: {}, attempt: 1 } },
    { id: "3", seq: 3, at: "2026-01-01T00:00:02.000Z", type: "node.completed", runId: "run-1", nodeId: "a", wave: 1, message: "done", data: { output: { value: "ok" }, durationMs: 1000 } },
  ];
  const state = rebuildState(transition, events);
  assert.equal(state.completedCount, 1);
  assert.equal(state.nodes.a.status, "completed");
  assert.equal(state.nodes.b.status, "pending");
  assert.equal(state.currentWave, 1);
});

test("projects durable operator recovery from the event timeline", () => {
  const request = {
    requestId: "run-1:a:iteration:1:recovery:1",
    nodeId: "a",
    iteration: 1,
    recoveryCycle: 1,
    status: "waiting",
    failure: {
      schema: "agent-failure.v1",
      kind: "network",
      message: "The provider connection ended.",
      providerSessionId: "session-1",
    },
    canResumeSession: true,
    requestedAt: "2026-01-01T00:00:02.000Z",
  } as const;
  const events: TimelineEvent[] = [
    { id: "1", seq: 1, at: "2026-01-01T00:00:00.000Z", type: "run.started", runId: "run-1", message: "started" },
    { id: "2", seq: 2, at: "2026-01-01T00:00:01.000Z", type: "node.failed", runId: "run-1", nodeId: "a", wave: 1, message: "failed", data: { error: "network" } },
    { id: "3", seq: 3, at: "2026-01-01T00:00:02.000Z", type: "recovery.required", runId: "run-1", nodeId: "a", wave: 1, message: "recovery", data: { request } },
  ];
  const waiting = rebuildState(transition, events);
  assert.equal(waiting.status, "waiting_for_recovery");
  assert.equal(waiting.nodes.a.status, "awaiting_recovery");
  assert.equal(waiting.nodes.a.recovery?.canResumeSession, true);

  events.push({
    id: "4",
    seq: 4,
    at: "2026-01-01T00:00:03.000Z",
    type: "recovery.accepted",
    runId: "run-1",
    nodeId: "a",
    wave: 1,
    message: "resuming",
    data: { requestId: request.requestId, action: "retry_same_session", receivedAt: "2026-01-01T00:00:03.000Z" },
  });
  const resumed = rebuildState(transition, events);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.nodes.a.status, "running");
  assert.equal(resumed.nodes.a.recovery?.status, "received");
});

test("projects a durable human question and accepted answer", () => {
  const humanDefinition: WorkflowDefinition = {
    ...definition,
    nodes: [{
      id: "answer",
      title: "Your answer",
      kind: "human",
      agent: "simulated",
      needs: [],
      prompt: "Wait for the operator's answer.",
      inputs: { question: "Choose a launch audience." },
      outputs: { answer: "string" },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    }],
  };
  const humanTransition = { ...transition, definition: humanDefinition };
  const request = {
    requestId: "run-1:answer:human",
    nodeId: "answer",
    question: "Choose a launch audience.",
    status: "waiting",
    requestedAt: "2026-01-01T00:00:01.000Z",
  } as const;
  const events: TimelineEvent[] = [
    { id: "1", seq: 1, at: "2026-01-01T00:00:00.000Z", type: "run.started", runId: "run-1", message: "started" },
    { id: "2", seq: 2, at: "2026-01-01T00:00:01.000Z", type: "node.started", runId: "run-1", nodeId: "answer", wave: 1, message: "started", data: { input: { question: request.question }, attempt: 1, iteration: 1 } },
    { id: "3", seq: 3, at: "2026-01-01T00:00:01.000Z", type: "human.required", runId: "run-1", nodeId: "answer", wave: 1, message: "waiting", data: { request } },
  ];
  const waiting = rebuildState(humanTransition, events);
  assert.equal(waiting.status, "waiting_for_human");
  assert.equal(waiting.nodes.answer.status, "awaiting_input");
  assert.equal(waiting.nodes.answer.agent, "human");

  events.push({
    id: "4",
    seq: 4,
    at: "2026-01-01T00:00:02.000Z",
    type: "human.accepted",
    runId: "run-1",
    nodeId: "answer",
    wave: 1,
    message: "accepted",
    data: { requestId: request.requestId, answer: "Design leaders", receivedAt: "2026-01-01T00:00:02.000Z" },
  });
  const accepted = rebuildState(humanTransition, events);
  assert.equal(accepted.status, "running");
  assert.equal(accepted.nodes.answer.humanRequest?.answer, "Design leaders");
});
