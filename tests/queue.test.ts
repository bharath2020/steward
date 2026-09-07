import assert from "node:assert/strict";
import { test } from "node:test";
import { queueBatches, takeQueueWork } from "../src/queue";

test("queue batches independently honor global, group, and node-local concurrency caps", () => {
  const work = [
    { nodeId: "review", group: "agents", nodeMaxParallelism: 2, item: 0 },
    { nodeId: "review", group: "agents", nodeMaxParallelism: 2, item: 1 },
    { nodeId: "review", group: "agents", nodeMaxParallelism: 2, item: 2 },
    { nodeId: "other", group: "agents", item: 0 },
    { nodeId: "free", item: 0 },
  ];
  const batches = queueBatches(work, 3, { agents: 2 });
  assert.deepEqual(
    batches.map((batch) => batch.map(({ nodeId, item }) => `${nodeId}:${item}`)),
    [
      ["review:0", "review:1", "free:0"],
      ["review:2", "other:0"],
    ],
  );
  for (const batch of batches) {
    assert(batch.length <= 3);
    assert(batch.filter((item) => item.nodeId === "review").length <= 2);
    assert(batch.filter((item) => item.group === "agents").length <= 2);
  }
});

test("prototype-named nodes and groups remain schedulable", () => {
  const work = [
    { nodeId: "constructor", group: "toString" },
    { nodeId: "hasOwnProperty", group: "toString" },
  ];
  assert.deepEqual(takeQueueWork(work, 2, { toString: 2 }).selected, work);
});

test("node-local concurrency remains stricter than global and group limits", () => {
  const work = [
    { nodeId: "review", group: "agents", nodeMaxParallelism: 1, item: 0 },
    { nodeId: "review", group: "agents", nodeMaxParallelism: 1, item: 1 },
    { nodeId: "other", group: "agents", item: 0 },
  ];
  const next = takeQueueWork(work, 3, { agents: 3 });
  assert.deepEqual(
    next.selected.map(({ nodeId, item }) => `${nodeId}:${item}`),
    ["review:0", "other:0"],
  );
  assert.deepEqual(next.remaining.map(({ nodeId, item }) => `${nodeId}:${item}`), ["review:1"]);
});

test("an empty queue produces no activity batches", () => {
  assert.deepEqual(queueBatches([], 4, {}), []);
});

test("a rolling queue fills a freed slot without exceeding active limits", () => {
  const pending = [
    { nodeId: "review", group: "agents", nodeMaxParallelism: 2, item: 2 },
    { nodeId: "review", group: "agents", nodeMaxParallelism: 2, item: 3 },
    { nodeId: "other", group: "agents", item: 0 },
  ];
  const next = takeQueueWork(
    pending,
    1,
    { agents: 3 },
    { agents: 1 },
    { review: 1 },
  );
  assert.deepEqual(next.selected.map((item) => item.item), [2]);
  assert.deepEqual(next.remaining.map(({ nodeId, item }) => `${nodeId}:${item}`), ["review:3", "other:0"]);
});
