import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";
import { Harness, until } from "./harness";
const agent = (role: string, demo_outputs = [{ success: false }]) => ({
  kind: "agent", prompt: "Return the deterministic composition fixture.", inputs: { role }, outputs: { success: "boolean" }, demo_outputs,
});
const definition = (nodes: object) => ({ version: 1, name: "Scope composition acceptance", defaults: { max_parallelism: 1, retry: { maximum_attempts: 1 } }, nodes });
async function closed(h: Harness, run: string, expected: string) {
  const state = await h.state(run, state => ["completed", "failed"].includes(state.status));
  assert.equal(state.status, expected, JSON.stringify(state));
  const handle = h.client.workflow.getHandle(`yamlflow-${run}`);
  await until(async () => (await handle.describe()).status.name === expected.toUpperCase() ? true : undefined, "Temporal terminal status");
  if (expected === "completed") assert.deepEqual(await handle.result(), state.finalOutputs);
  return state;
}
async function receipts(h: Harness, run: string) {
  const files = await readdir(`${h.root}/runs/${run}`, { recursive: true });
  return Promise.all(files.filter(file => file.endsWith("completion-receipt.json")).map(async file => ({
    input: await h.json<{ role: string }>(run, file.replace("completion-receipt.json", "input.json")),
  })));
}
test("scope composition regressions through real Temporal", { timeout: 90_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  await t.test("scope exported arrays compose with downstream for_each", async () => {
    const source = definition({
      collect: {
        kind: "scope",
        nodes: { collect: { ...agent("collect"), outputs: { items: "string[]" }, demo_outputs: [{ items: ["alpha", "beta"] }] } },
        outputs: { items: "$nodes.collect.output.items" },
      },
      consume: { ...agent("consume", [{ success: true }]), needs: ["collect"], for_each: { items: "$nodes.collect.output.items", as: "item", max_parallelism: 1 } },
    });
    const run = await h.run(await h.fixture("scope-array-export.yaml", YAML.stringify(source)));
    const state = await closed(h, run, "completed");
    assert.deepEqual(state.nodes.collect.output, { items: ["alpha", "beta"] });
    assert.deepEqual(state.nodes.consume.output, [{ success: true }, { success: true }]);
    assert.equal((await receipts(h, run)).filter(item => item.input.role === "consume").length, 2);
  });

  await t.test("global expansion rejects top-level mapped work in scope workflows before providers start", async () => {
    const source = definition({
      consume: { ...agent("consume", [{ success: true }]), for_each: { items: "$input.items", as: "item", max_parallelism: 1 } },
      finish: { kind: "scope", needs: ["consume"], nodes: { leaf: agent("leaf", [{ success: true }]) }, outputs: { success: "$nodes.leaf.output.success" } },
    });
    const run = await h.run(await h.fixture("scope-map-limit.yaml", YAML.stringify(source)),
      await h.fixture("scope-map-limit.json", JSON.stringify({ items: Array.from({ length: 1001 }, (_, i) => i) })));
    const state = await closed(h, run, "failed");
    assert.match(JSON.stringify(state), /expansion|1000|limit/i);
    assert.equal((await receipts(h, run)).length, 0, "Reject expanded work before launching any of its providers");
  });
});
