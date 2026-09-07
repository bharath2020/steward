import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkflow } from "../src/definition";
import { workflowAuthoringPrompt } from "../src/authoring";

const { definitionNode, scopeInstances, predicateLabel, loopLabel } = require("../ui/assets/graph-layout.js");

test("scope inspection resolves nested instance definitions and preserves human request identity", () => {
  const human = { id: "approval", kind: "human" };
  const definition = { nodes: [{ id: "outer", nodes: [{ id: "inner", nodes: [human] }] }] };
  assert.equal(definitionNode(definition, "outer~2.inner~3.approval"), human);
  assert.equal(definitionNode(definition, "outer~2.inner~3.missing"), undefined);
  const second = { id: "outer~2.inner~3.approval", parentId: "outer~2.inner", status: "awaiting_input", humanRequest: { requestId: "second-request" } };
  const run = { nodes: {
    first: { id: "outer~1.inner~3.approval", parentId: "outer~1.inner", status: "completed" },
    second,
  } };
  assert.deepEqual(scopeInstances(run, "outer~2.inner"), [second]);
  assert.equal(scopeInstances(run, "outer~2.inner")[0].humanRequest.requestId, "second-request");
});

test("loop presentation uses runtime outcomes even when output would suggest a different result", () => {
  const node = { loop: { max_iterations: 3, until: { all: [
    { path: "left.success", operator: "equals", value: true },
    { not: { path: "right.failed", operator: "truthy" } },
  ] } } };
  assert.match(predicateLabel(node.loop.until), /ALL.*left.success.*NOT.*right.failed/);
  for (const [loopOutcome, label] of [["condition_met", "CONDITION MET"], ["exhausted_accepted", "LIMIT ACCEPTED"], ["exhausted_failed", "LIMIT FAILED"]]) {
    assert.match(loopLabel(node, { iteration: 2, status: "completed", loopOutcome, output: {} }), new RegExp(label));
  }
  assert.match(loopLabel(node, { status: "completed", iteration: 3, output: { left: { success: true }, right: { failed: false } } }), /OUTCOME UNKNOWN/);
  assert.match(loopLabel(node, { status: "failed", iteration: 1 }), /OUTCOME UNKNOWN/);
});

test("portable scope example loads and authoring contract describes composable repeat", async () => {
  const definition = await loadWorkflow("skills/steward-workflow/assets/scope-loop.yaml");
  assert.equal(definition.nodes[0].kind, "scope");
  assert.equal(definition.nodes[0].nodes?.[1].kind, "scope");
  assert.deepEqual(definition.nodes[1].needs, ["resolve"]);
  const prompt = workflowAuthoringPrompt({ message: "Repeat review and parallel checks", provider: "codex", history: [] });
  assert.match(prompt, /kind: scope/);
  assert.match(prompt, /same iteration/);
  assert.match(prompt, /\$state/);
  assert.match(prompt, /never both/);
});

test("session continuation example opts in while default example preserves fresh behavior", async () => {
  const defaults = await loadWorkflow("skills/steward-workflow/assets/scope-loop.yaml");
  const resumed = await loadWorkflow("skills/steward-workflow/assets/scope-loop-resume.yaml");
  assert.equal(defaults.nodes[0].loop?.agent_sessions, undefined);
  assert.equal(resumed.nodes[0].loop?.agent_sessions, "resume");
  assert.deepEqual(resumed.nodes[0].loop?.next, defaults.nodes[0].loop?.next);
  const prompt = workflowAuthoringPrompt({ message: "Continue each review agent's conversation", provider: "codex", history: [] });
  assert.match(prompt, /agent_sessions: fresh or resume \(default fresh\)/);
  assert.match(prompt, /nested repeated scope owns its own policy/);
  assert.match(prompt, /canonical local workspace/);
  assert.match(prompt, /always declare loop.next/);
});
