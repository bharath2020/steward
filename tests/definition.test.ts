import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseWorkflow } from "../src/definition";
import { resolveNodeInputs } from "../src/resolver";

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
