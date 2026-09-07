import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompletionReceipt, completionPaths, validateCompletionReceipt } from "../src/completion-receipt";
import type { AgentExecutionInput, WorkflowDefinition } from "../src/contracts";
import {
  classifyAgentFailure,
  codexExecutionArgs,
  matchingHeartbeatCheckpoint,
} from "../src/execution-policy";

const definition: WorkflowDefinition = {
  version: 1,
  name: "recovery fixture",
  description: "",
  sourcePath: "fixture.yaml",
  definitionHash: "definition-hash",
  defaults: { provider: "codex", max_parallelism: 1, delay_ms: 0, retry: { maximum_attempts: 2 } },
  groups: [],
  nodes: [],
};

const execution: AgentExecutionInput = {
  runId: "run-1",
  temporalRunId: "temporal-run-1",
  definition,
  node: {
    id: "worker",
    title: "Worker",
    kind: "agent",
    agent: "codex",
    needs: [],
    prompt: "Return a value.",
    inputs: {},
    outputs: { value: "string" },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
  input: {},
  mode: "codex",
  wave: 1,
  iteration: 1,
  recoveryCycle: 0,
  receiptToken: "unpredictable-dispatch-token",
};

test("Codex retries resume the exact provider session", () => {
  const args = codexExecutionArgs({
    prompt: "finish",
    schemaPath: "/tmp/schema.json",
    outputPath: "/tmp/output.json",
    cwd: "/tmp/work",
    priorSessionId: "019-session",
  });
  assert.deepEqual(args.slice(0, 4), ["--sandbox", "read-only", "exec", "resume"]);
  assert(args.includes("019-session"));
  assert.equal(args.at(-1), "finish");
});

test("heartbeat session checkpoints are bound to one Temporal activity identity", () => {
  const checkpoint = {
    schema: "agent-heartbeat.v1" as const,
    runId: execution.runId,
    temporalRunId: execution.temporalRunId,
    nodeId: execution.node.id,
    provider: execution.mode,
    iteration: execution.iteration,
    recoveryCycle: execution.recoveryCycle,
    attempt: 1,
    phase: "working" as const,
    startedAt: "2026-09-04T00:00:00.000Z",
    providerSessionId: "019-session",
  };
  const identity = {
    runId: execution.runId,
    temporalRunId: execution.temporalRunId,
    nodeId: execution.node.id,
    provider: execution.mode,
    iteration: execution.iteration,
    recoveryCycle: execution.recoveryCycle,
  };
  assert.equal(matchingHeartbeatCheckpoint([checkpoint], identity)?.providerSessionId, "019-session");
  assert.equal(matchingHeartbeatCheckpoint([checkpoint], { ...identity, nodeId: "other" }), undefined);
});

test("network failures remain retryable and context exhaustion cannot be resumed", () => {
  assert.equal(classifyAgentFailure(new Error("socket connection reset"), "session-1").kind, "network");
  assert.equal(classifyAgentFailure(new Error("context window exceeded"), "session-1").kind, "context_exhausted");
});

test("completion receipts reject altered identity, output, and dispatch tokens", () => {
  const receipt = buildCompletionReceipt({
    execution,
    promptSha256: "prompt-hash",
    outputSchemaSha256: "schema-hash",
    output: { value: "done" },
    providerSessionId: "019-session",
    completedAt: "2026-09-04T00:00:00.000Z",
  });
  const expected = { execution, promptSha256: "prompt-hash", outputSchemaSha256: "schema-hash" };
  assert.doesNotThrow(() => validateCompletionReceipt(receipt, expected));
  assert.throws(
    () => validateCompletionReceipt({ ...receipt, receiptToken: "forged" }, expected),
    /identity/,
  );
  assert.throws(
    () => validateCompletionReceipt({ ...receipt, output: { value: "forged" } }, expected),
    /output hash/,
  );
});

test("queued items receive distinct durable artifact and receipt paths", () => {
  const queuedNode = {
    ...execution.node,
    for_each: { items: "$input.tasks", as: "task", max_parallelism: 2 },
  };
  const first = completionPaths({
    ...execution,
    node: queuedNode,
    queueItem: { index: 0, count: 2 },
  });
  const second = completionPaths({
    ...execution,
    node: queuedNode,
    iteration: 2,
    queueItem: { index: 1, count: 2 },
  });
  assert.match(first.outputPath, /nodes\/worker\/items\/0001\/dispatches\/recovery-0000-unpredictable-dispatch-token\/output\.json$/);
  assert.match(second.outputPath, /nodes\/worker\/items\/0002\/dispatches\/recovery-0000-unpredictable-dispatch-token\/output\.json$/);
  assert.match(first.acceptedOutputPath, /nodes\/worker\/items\/0001\/output\.json$/);
  assert.match(second.acceptedOutputPath, /nodes\/worker\/items\/0002\/output\.json$/);
  assert.notEqual(first.primaryReceiptPath, second.primaryReceiptPath);
  assert.notEqual(first.mirrorReceiptPath, second.mirrorReceiptPath);

  const recoveredFresh = completionPaths({
    ...execution,
    node: queuedNode,
    queueItem: { index: 0, count: 2 },
    recoveryCycle: 1,
    receiptToken: "fresh-token",
  });
  assert.notEqual(first.directory, recoveredFresh.directory);
  assert.notEqual(first.primaryReceiptPath, recoveredFresh.primaryReceiptPath);
  assert.notEqual(first.mirrorReceiptPath, recoveredFresh.mirrorReceiptPath);
  assert.equal(first.acceptedOutputPath, recoveredFresh.acceptedOutputPath);
});
