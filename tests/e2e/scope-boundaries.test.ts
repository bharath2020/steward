import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";
import type { AgentCompletionReceipt } from "../../src/contracts";
import { sha256Json } from "../../src/completion-receipt";
import { Harness, until } from "./harness";

const agent = (role: string, demo_outputs = [{ success: false }]) => ({
  kind: "agent", prompt: "Return the deterministic boundary fixture.", inputs: { role },
  outputs: { success: "boolean" }, demo_outputs,
});
const loop = (on_exhaustion = "fail", max_iterations = 2) => ({
  max_iterations, on_exhaustion, until: { path: "success", operator: "equals", value: true },
});
const scope = (on_exhaustion = "fail") => ({
  kind: "scope", loop: loop(on_exhaustion), nodes: { leaf: agent("leaf") }, outputs: { success: "$nodes.leaf.output.success" },
});
const definition = (nodes: object) => ({ version: 1, name: "Scope boundary acceptance", defaults: { max_parallelism: 1, retry: { maximum_attempts: 1 } }, nodes });
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
  return Promise.all(files.filter(file => file.endsWith("completion-receipt.json")).map(async file => {
    const receipt = await h.json<AgentCompletionReceipt>(run, file);
    const { receiptSha256, ...body } = receipt;
    assert.equal(receiptSha256, sha256Json(body));
    assert.equal(receipt.outputSha256, sha256Json(receipt.output));
    assert.deepEqual(await h.json(run, file.replace("completion-receipt.json", "output.json")), receipt.output);
    return { receipt, input: await h.json<{ role: string }>(run, file.replace("completion-receipt.json", "input.json")) };
  }));
}

test("scope loop boundaries through real Temporal", { timeout: 180_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  await t.test("nested loops complete with one global leaf permit and independent iteration counters", async () => {
    const source = definition({
      outer: {
        kind: "scope", loop: loop(),
        nodes: {
          inner: { kind: "scope", loop: loop(), nodes: { leaf: agent("inner_leaf", [{ success: false }, { success: true }]) }, outputs: { success: "$nodes.leaf.output.success" } },
          review: { ...agent("outer_review", [{ success: false }, { success: true }]), needs: ["inner"] },
        }, outputs: { success: "$nodes.review.output.success" },
      },
      after: { ...agent("after", [{ success: true }]), needs: ["outer"] },
    });
    const run = await h.run(await h.fixture("nested-boundary.yaml", YAML.stringify(source)));
    const state = await closed(h, run, "completed");
    assert.equal(state.nodes.outer.loopOutcome, "condition_met");
    const committed = await receipts(h, run);
    assert.equal(committed.filter(item => item.input.role === "inner_leaf").length, 4, "Inner loop starts fresh on each outer iteration");
    assert.equal(committed.filter(item => item.input.role === "outer_review").length, 2);
    assert.equal(committed.filter(item => item.input.role === "after").length, 1);
    const leafIds = new Set(committed.map(item => item.receipt.nodeId));
    assert.equal(leafIds.size, 7, "Every full nested iteration identity is distinct");
    let active = 0;
    for (const event of await h.events(run)) {
      if (!event.nodeId || !leafIds.has(event.nodeId)) continue;
      if (event.type === "node.started") active++;
      if (event.type === "node.completed") active--;
      assert(active >= 0 && active <= 1, "Nested scopes share the workflow leaf concurrency budget");
    }
    assert.equal(active, 0);
  });
  for (const exhaustion of ["fail", "accept_last"] as const) {
    await t.test(`scope exhaustion ${exhaustion} exposes its outcome and gates dependents`, async () => {
      const run = await h.run(await h.fixture(`scope-exhaustion-${exhaustion}.yaml`, YAML.stringify(definition({
        repeat: scope(exhaustion), after: { ...agent("after", [{ success: true }]), needs: ["repeat"] },
      }))));
      const state = await closed(h, run, exhaustion === "fail" ? "failed" : "completed");
      assert.equal(state.nodes.repeat.loopOutcome, exhaustion === "fail" ? "exhausted_failed" : "exhausted_accepted");
      const committed = await receipts(h, run);
      assert.equal(committed.filter(item => item.input.role === "leaf").length, 2);
      assert.equal(committed.filter(item => item.input.role === "after").length, exhaustion === "fail" ? 0 : 1);
      if (exhaustion === "accept_last") assert.deepEqual(state.nodes.repeat.output, { success: false });
    });
  }
  await t.test("invalid nested operand is an error even when another all operand is false", async () => {
    const source = definition({
      repeat: {
        kind: "scope", loop: { ...loop("accept_last"), until: { all: [
          { path: "success", operator: "equals", value: true },
          { path: "details.missing", operator: "equals", value: true },
        ] } },
        nodes: { leaf: { ...agent("leaf"), outputs: { success: "boolean", details: "object" }, demo_outputs: [{ success: false, details: {} }] } },
        outputs: { success: "$nodes.leaf.output.success", details: "$nodes.leaf.output.details" },
      }, after: { ...agent("after", [{ success: true }]), needs: ["repeat"] },
    });
    const run = await h.run(await h.fixture("scope-invalid-operand.yaml", YAML.stringify(source)));
    const state = await closed(h, run, "failed");
    assert.notEqual(state.nodes.repeat.loopOutcome, "exhausted_accepted");
    assert.equal((await receipts(h, run)).filter(item => item.input.role === "after").length, 0);
    assert.match(JSON.stringify(state), /details\.missing/);
  });

  const invalid: [string, object, RegExp][] = [
    ["undeclared-sibling", definition({ group: { kind: "scope", nodes: { a: agent("a"), b: { ...agent("b"), inputs: { value: "$nodes.a.output.success" } } }, outputs: { success: "$nodes.b.output.success" } } }), /needs|depend/i],
    ["out-of-scope-reference", definition({ outside: agent("outside"), group: { kind: "scope", needs: ["outside"], nodes: { leaf: { ...agent("leaf"), inputs: { value: "$nodes.outside.output.success" } } }, outputs: { success: "$nodes.leaf.output.success" } } }), /unknown|scope|reference/i],
    ["state-without-loop", definition({ group: { kind: "scope", nodes: { leaf: { ...agent("leaf"), inputs: { value: "$state.value" } } }, outputs: { success: "$nodes.leaf.output.success" } } }), /state|loop/i],
    ["output-outside-next", definition({ group: { kind: "scope", nodes: { leaf: { ...agent("leaf"), inputs: { value: "$output.success" } } }, outputs: { success: "$nodes.leaf.output.success" } } }), /output|reference/i],
    ["conflicting-dependency-aliases", definition({ a: agent("a"), b: { ...agent("b"), needs: ["a"], depends_on: ["a"] } }), /needs|depends_on|both/i],
    ["predicate-missing-value", definition({ group: { ...scope(), loop: { ...loop(), until: { path: "success", operator: "equals" } } } }), /value/i],
    ["expansion-limit", definition({ outer: { kind: "scope", loop: loop("fail", 20), nodes: { middle: { kind: "scope", loop: loop("fail", 20), nodes: { inner: { ...scope(), loop: loop("fail", 20) } }, outputs: { success: "$nodes.inner.output.success" } } }, outputs: { success: "$nodes.middle.output.success" } } }), /expansion|1000|limit/i],
    ["numeric-predicate-string-value", definition({ group: { ...scope(), loop: { ...loop(), until: { path: "success", operator: "greater_than", value: "one" } } } }), /number|numeric|value|operand/i],
  ];
  for (const [name, source, diagnostic] of invalid) {
    await t.test(`reject ${name} before submitting runtime work`, async () => {
      const runs = async () => readdir(`${h.root}/runs`).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      const before = await runs();
      const result = await h.cli("start", ["--workflow", await h.fixture(`invalid-scope-${name}.yaml`, YAML.stringify(source))], 1);
      assert.match(result.stderr, diagnostic);
      assert.equal(result.stdout, "");
      assert.deepEqual(await runs(), before, "Preflight rejection must not allocate a run");
    });
  }
});
