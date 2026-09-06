import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflow } from "../src/definition";

test("rejects malformed deterministic outputs during preflight", () => {
  assert.throws(() => parseWorkflow(`
version: 1
name: bad fixture
nodes:
  agent:
    prompt: Test
    outputs:
      values: string[]
    demo_output:
      values:
        - key: accidentally parsed mapping
`), /demo output 1 does not match outputs/);
});
