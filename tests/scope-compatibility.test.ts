import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflow } from "../src/definition";
import { resolveNodeInputs } from "../src/resolver";

test("flat V1 inputs retain literal dollar strings", () => {
  const definition = parseWorkflow(`version: 1\nname: Literal compatibility\nnodes:\n  leaf:\n    prompt: Return fixture\n    inputs: {price: '$100', schema: '$schema', state: '$state.value', output: '$output'}\n    outputs: {ok: boolean}\n`);
  assert.deepEqual(resolveNodeInputs(definition.nodes[0], {}, {}), { price: "$100", schema: "$schema", state: "$state.value", output: "$output" });
});
test("old persisted dollar-state inputs remain literals without scope context", () => {
  const node = parseWorkflow(`version: 1\nname: Persisted input compatibility\nnodes:\n  leaf:\n    prompt: Return fixture\n    outputs: {ok: boolean}\n`).nodes[0];
  node.inputs = { state: "$state.value", output: "$output" };
  assert.deepEqual(resolveNodeInputs(node, {}, {}), node.inputs);
});
