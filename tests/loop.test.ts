import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeLoop } from "../src/contracts";
import { loopSatisfied } from "../src/loop";

const loop: NodeLoop = {
  max_iterations: 3,
  carry_as: "previous",
  on_exhaustion: "fail",
  until: { path: "review.score", operator: "greater_than_or_equal", value: 0.85 },
};

test("bounded loop continues before its quality gate", () => {
  assert.equal(loopSatisfied(loop, { review: { score: 0.7 } }), false);
});

test("bounded loop exits when its quality gate passes", () => {
  assert.equal(loopSatisfied(loop, { review: { score: 0.9 } }), true);
});
