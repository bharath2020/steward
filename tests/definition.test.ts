import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseWorkflow } from "../src/definition";
import { resolveForEachItems, resolveNodeInputs } from "../src/resolver";

test("parses the demo DAG and preserves fan-out/fan-in dependencies", async () => {
  const source = await readFile("workflows/product-launch.yaml", "utf8");
  const definition = parseWorkflow(source, "workflows/product-launch.yaml");
  assert.equal(definition.nodes.length, 8);
  assert.equal(definition.groups.length, 5);
  assert.deepEqual(definition.nodes.find((node) => node.id === "synthesis")?.needs, [
    "audience_research",
    "feasibility",
    "narrative",
  ]);
  assert.equal(definition.definitionHash.length, 64);
  assert.equal(definition.nodes.find((node) => node.id === "synthesis")?.loop?.max_iterations, 3);
});

test("rejects cycles before a durable run starts", () => {
  assert.throws(
    () =>
      parseWorkflow(`
version: 1
name: cycle
nodes:
  alpha:
    needs: [beta]
    prompt: A
    outputs: { value: string }
  beta:
    needs: [alpha]
    prompt: B
    outputs: { value: string }
`),
    /cycle detected/,
  );
});

test("resolves initial and fan-in output variables", async () => {
  const source = await readFile("workflows/product-launch.yaml", "utf8");
  const definition = parseWorkflow(source);
  const node = definition.nodes.find((candidate) => candidate.id === "synthesis")!;
  const resolved = resolveNodeInputs(node, { brief: "hello" }, {
    audience_research: { message: "clear" },
    feasibility: { confidence: 0.8 },
    narrative: { headline: "ship" },
  });
  assert.deepEqual(resolved, {
    audience: { message: "clear" },
    feasibility: { confidence: 0.8 },
    narrative: { headline: "ship" },
  });
});

test("rejects an unresolved dependency", () => {
  assert.throws(
    () =>
      parseWorkflow(`
version: 1
name: missing
nodes:
  alpha:
    needs: [ghost]
    prompt: A
    outputs: { value: string }
`),
    /unknown node ghost/,
  );
});

test("parses a human input node with a generated question binding", () => {
  const definition = parseWorkflow(`
version: 1
name: human input
nodes:
  interviewer:
    prompt: Ask one question.
    outputs: { question: string }
  answer:
    kind: human
    needs: [interviewer]
    question: $nodes.interviewer.output.question
`);
  const human = definition.nodes.find((node) => node.id === "answer")!;
  assert.equal(human.kind, "human");
  assert.equal(human.inputs.question, "$nodes.interviewer.output.question");
  assert.deepEqual(human.outputs, { answer: "string" });
});

test("rejects a human input node without a question binding", () => {
  assert.throws(
    () => parseWorkflow(`
version: 1
name: missing question
nodes:
  answer:
    kind: human
`),
    /node answer\.question is required/,
  );
});

test("parses a bounded for_each queue over an array output", () => {
  const definition = parseWorkflow(`
version: 1
name: queued reviews
defaults:
  max_parallelism: 4
nodes:
  planner:
    prompt: Split the work.
    outputs: { tasks: "object[]" }
  reviewer:
    needs: [planner]
    prompt: Review one task.
    for_each:
      items: $nodes.planner.output.tasks
      as: task
      max_parallelism: 2
    inputs:
      context: $input.context
    outputs: { summary: string }
`);
  const reviewer = definition.nodes.find((node) => node.id === "reviewer")!;
  assert.deepEqual(reviewer.for_each, {
    items: "$nodes.planner.output.tasks",
    as: "task",
    max_parallelism: 2,
  });
  assert.equal(definition.nodes[0].outputs.tasks, "object[]");
  assert.deepEqual(
    resolveForEachItems(reviewer, { context: "launch" }, { planner: { tasks: [{ id: 1 }, { id: 2 }] } }),
    [{ id: 1 }, { id: 2 }],
  );
});

test("rejects unsafe or ambiguous for_each declarations", () => {
  assert.throws(
    () => parseWorkflow(`
version: 1
name: missing dependency
nodes:
  planner:
    prompt: Plan.
    outputs: { tasks: "string[]" }
  reviewer:
    prompt: Review.
    for_each: { items: $nodes.planner.output.tasks, as: task, max_parallelism: 2 }
    outputs: { summary: string }
`),
    /must be listed in needs/,
  );
  assert.throws(
    () => parseWorkflow(`
version: 1
name: scalar queue
nodes:
  planner:
    prompt: Plan.
    outputs: { task: string }
  reviewer:
    needs: [planner]
    prompt: Review.
    for_each: { items: $nodes.planner.output.task, as: task, max_parallelism: 2 }
    outputs: { summary: string }
`),
    /must reference an array output/,
  );
  assert.throws(
    () => parseWorkflow(`
version: 1
name: loop queue
nodes:
  reviewer:
    prompt: Review.
    for_each: { items: $input.tasks, as: task }
    loop:
      max_iterations: 2
      until: { path: done, operator: truthy }
    outputs: { done: boolean }
`),
    /cannot combine loop and for_each/,
  );
  assert.throws(
    () => parseWorkflow(`
version: 1
name: human queue
nodes:
  reviewer:
    kind: human
    question: Review this?
    for_each: { items: $input.tasks, as: task }
`),
    /for_each is not supported for human input/,
  );
  assert.throws(
    () => parseWorkflow(`
version: 1
name: ambiguous item binding
nodes:
  reviewer:
    prompt: Review.
    for_each: { items: $input.tasks, as: task }
    inputs: { task: $input.fallback }
    outputs: { summary: string }
`),
    /conflicts with for_each.as/,
  );
  const inputQueue = parseWorkflow(`
version: 1
name: runtime array check
nodes:
  reviewer:
    prompt: Review.
    for_each: { items: $input.tasks, as: task }
    outputs: { summary: string }
`);
  assert.throws(
    () => resolveForEachItems(inputQueue.nodes[0], { tasks: "not-an-array" }, {}),
    /did not resolve to an array/,
  );
  const chainedQueue = parseWorkflow(`
version: 1
name: chained queues
nodes:
  first:
    prompt: First pass.
    for_each: { items: $input.tasks, as: task }
    outputs: { summary: string }
  second:
    needs: [first]
    prompt: Second pass.
    for_each: { items: $nodes.first.output, as: result }
    outputs: { decision: string }
`);
  assert.equal(chainedQueue.nodes[1].for_each?.items, "$nodes.first.output");
  assert.throws(
    () => parseWorkflow(`
version: 1
name: invalid mapped field
nodes:
  first:
    prompt: First pass.
    for_each: { items: $input.tasks, as: task }
    outputs: { tags: "string[]" }
  second:
    needs: [first]
    prompt: Second pass.
    for_each: { items: $nodes.first.output.tags, as: tag }
    outputs: { decision: string }
`),
    /must reference the complete mapped output/,
  );
});
