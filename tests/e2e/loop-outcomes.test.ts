import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";
import { Harness } from "./harness";

test("ordinary loop exposes runtime condition outcome", { timeout: 90_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  const source = { version: 1, name: "Ordinary loop outcome", nodes: { review: {
    kind: "agent", prompt: "Return a deterministic review", outputs: { approved: "boolean" },
    demo_outputs: [{ approved: false }, { approved: true }],
    loop: { max_iterations: 3, until: { path: "approved", operator: "equals", value: true } },
  } } };
  const run = await h.run(await h.fixture("ordinary-loop.yaml", YAML.stringify(source)));
  const state = await h.finished(run);
  await writeFile(`${h.root}/ordinary-loop-history.json`, JSON.stringify(await h.client.workflow.getHandle(`yamlflow-${run}`).fetchHistory()));
  assert.equal(state.nodes.review.loopOutcome, "condition_met");
});
