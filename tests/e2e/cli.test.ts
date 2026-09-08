import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";
import { Harness } from "./harness";

const examples: Record<string, string> = {
  "file-prompt.yaml": "product-input.json",
  "product-launch.yaml": "product-input.json",
  "privacy-launch-with-questions.yaml": "product-input.json",
  "two-agent-multiple-choice.yaml": "two-agent-multiple-choice-input.json",
  "queued-fan-out.yaml": "queued-fan-out-input.json",
};
const agent = () => ({ prompt: "Return the synthetic test value.", outputs: { value: "number" }, demo_output: { value: 1 } });
const workflow = (node: object) => ({ version: 1, name: "CLI fixture", defaults: { retry: { maximum_attempts: 1 } }, nodes: { step: node } });

test("consumer CLI end to end", { timeout: 360_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  await t.test("every shipped YAML has an explicit scenario", async () => {
    assert.deepEqual((await readdir("workflows")).filter(file => file.endsWith(".yaml")).sort(), [...Object.keys(examples), "upgrade-testbeds-long-running.yaml"].sort());
  });
  await t.test("real testbed workflow validates without running platform commands", async () => {
    const { loadWorkflow, loadInitialInput } = await import("../../src/definition");
    const definition = await loadWorkflow("workflows/upgrade-testbeds-long-running.yaml");
    await loadInitialInput("examples/upgrade-testbeds-long-running-input.json");
    assert.equal(definition.nodes.length, 18);
  });
  for (const [file, input] of Object.entries(examples)) {
    await t.test(`bundled ${file}`, async () => {
      const run = await h.run(`workflows/${file}`, `examples/${input}`);
      if (file.includes("questions") || file.includes("multiple-choice")) {
        const count = file.includes("multiple-choice") ? 4 : 2;
        const waiting = await h.state(run, state => Object.values(state.nodes).filter(node => node.humanRequest?.status === "waiting").length === count);
        const requests = Object.values(waiting.nodes).flatMap(node => node.humanRequest ? [node.humanRequest] : []);
        const bad = await h.cli("answer", ["--run", run, "--request", "unknown", "--answer", "A"], 1);
        assert.match(bad.stderr, /does not exist/);
        for (const [index, request] of requests.entries()) {
          const result = await h.cli("answer", ["--run", run, "--request", request.requestId, "--answer", index % 2 ? "Synthetic free-text answer" : "A"]);
          assert.equal(JSON.parse(result.stdout).accepted, true);
          if (index === 0) {
            const duplicate = await h.cli("answer", ["--run", run, "--request", request.requestId, "--answer", "B"], 1);
            assert.match(duplicate.stderr, /already answered/);
            const partial = await h.state(run, state => Object.values(state.nodes).some(node => node.humanRequest?.status === "waiting"));
            assert.notEqual(partial.nodes.final_brief?.status, "completed");
          }
        }
      }
      const state = await h.finished(run);
      if (file === "queued-fan-out.yaml") {
        assert.equal(state.nodes.review.completedItems, 4);
        assert.deepEqual(state.nodes.review.output, ["Accessibility", "Performance", "Resilience", "Security"].map(name => ({ finding: `${name} review complete.` })));
        let active = 0;
        for (const event of await h.events(run)) {
          if (event.nodeId !== "review") continue;
          if (event.type === "node.started") active++;
          if (event.type === "node.item_completed") active--;
          assert(active >= 0 && active <= 2, "Queue exceeded its declared concurrency cap");
        }
        assert.equal(active, 0);
      }
      if (file === "product-launch.yaml") assert.equal(state.nodes.synthesis.iterationCount, 2);
      if (file === "privacy-launch-with-questions.yaml") assert.equal(state.nodes.synthesis.iterationCount, 3);
    });
  }
  await t.test("all output types survive CLI submission and receipt commit", async () => {
    const outputs = { text: "string", number: "number", flag: "boolean", record: "object", texts: "string[]", numbers: "number[]", flags: "boolean[]", records: "object[]" };
    const demo_output = { text: "hello", number: 1.5, flag: false, record: { nested: true }, texts: ["a"], numbers: [1, 2], flags: [true, false], records: [{ id: 1 }] };
    const run = await h.run(await h.fixture("types.yaml", YAML.stringify(workflow({ prompt: "Return typed fixture values.", outputs, demo_output }))));
    assert.deepEqual((await h.finished(run)).nodes.step.output, demo_output);
  });
  for (const operator of ["equals", "not_equals", "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal", "contains", "truthy"]) {
    await t.test(`loop predicate ${operator}`, async () => {
      const value = operator === "contains" ? "hello" : 1;
      const expected = operator === "contains" ? "ell" : operator === "less_than" ? 2 : operator === "not_equals" || operator === "greater_than" ? 0 : 1;
      const node = { ...agent(), outputs: { value: typeof value }, demo_output: { value }, loop: { max_iterations: 2, until: { path: "value", operator, value: expected } } };
      const run = await h.run(await h.fixture(`${operator}.yaml`, YAML.stringify(workflow(node))));
      await h.finished(run);
      assert(!(await h.events(run)).some(event => event.type === "loop.continued"));
    });
  }
  for (const exhaustion of ["fail", "accept_last"]) {
    await t.test(`loop exhaustion ${exhaustion}`, async () => {
      const node = { ...agent(), loop: { max_iterations: 2, on_exhaustion: exhaustion, until: { path: "value", operator: "equals", value: 99 } } };
      const source = { ...workflow(node), nodes: { step: node, join: { ...agent(), needs: ["step"] } } };
      const run = await h.run(await h.fixture(`exhaust-${exhaustion}.yaml`, YAML.stringify(source)));
      await h.finished(run, exhaustion === "fail" ? "failed" : "completed");
      assert.equal((await h.events(run)).filter(event => event.type === "loop.exhausted").length, 1);
      if (exhaustion === "fail") assert(!(await h.events(run)).some(event => event.nodeId === "join" && event.type === "node.started"));
    });
  }
  for (const [name, items, status] of [["empty", [], "completed"], ["single", [1], "completed"], ["scalar", 1, "failed"], ["missing", undefined, "failed"]] as const) {
    await t.test(`array source ${name}`, async () => {
      const node = { ...agent(), for_each: { items: "$input.items", as: "item", max_parallelism: 1 } };
      const run = await h.run(await h.fixture(`queue-${name}.yaml`, YAML.stringify(workflow(node))), await h.fixture(`${name}.json`, JSON.stringify({ items })));
      const state = await h.finished(run, status);
      if (status === "completed") assert.deepEqual(state.nodes.step.output, name === "empty" ? [] : [{ value: 1 }]);
    });
  }
  const invalid: [string, object, RegExp][] = [
    ["version", { ...workflow(agent()), version: 2 }, /version must be 1/],
    ["empty-nodes", { ...workflow(agent()), nodes: {} }, /non-empty object/],
    ["missing-dependency", workflow({ ...agent(), needs: ["ghost"] }), /unknown node/],
    ["self-dependency", workflow({ ...agent(), needs: ["step"] }), /depend on itself/],
    ["cycle", { ...workflow(agent()), nodes: { step: { ...agent(), needs: ["other"] }, other: { ...agent(), needs: ["step"] } } }, /cycle detected/],
    ["missing-prompt", workflow({ outputs: { value: "number" } }), /exactly one/],
    ["missing-file", workflow({ prompt_file: "absent.md", outputs: { value: "number" } }), /cannot be read/],
    ["both-prompts", workflow({ ...agent(), prompt_file: "absent.md" }), /exactly one/],
    ["bad-output", workflow({ ...agent(), demo_output: { value: "wrong" } }), /does not match outputs/],
    ["bad-type", workflow({ ...agent(), outputs: { value: "integer" } }), /unsupported/],
    ["unknown-group", workflow({ ...agent(), group: "ghost" }), /unknown group/],
    ["provider", workflow({ ...agent(), agent: "unknown" }), /simulated or codex/],
    ["human-question", workflow({ kind: "human" }), /question is required/],
    ["loop-bound", workflow({ ...agent(), loop: { max_iterations: 21, until: { path: "value", operator: "truthy" } } }), /between 1 and 20/],
    ["loop-operator", workflow({ ...agent(), loop: { until: { path: "value", operator: "unknown" } } }), /unsupported/],
    ["queue-bound", workflow({ ...agent(), for_each: { items: "$input.items", as: "item", max_parallelism: 0 } }), /positive integer/],
    ["parallelism", { ...workflow(agent()), defaults: { max_parallelism: 0 } }, /positive integer/],
    ["retry-budget", { ...workflow(agent()), defaults: { retry: { maximum_attempts: 6 } } }, /cannot exceed 5/],
    ["human-queue", workflow({ kind: "human", question: "Synthetic question?", for_each: { items: "$input.items", as: "item" } }), /not supported for human/],
    ["human-loop", workflow({ kind: "human", question: "Synthetic question?", loop: {} }), /not supported for human/],
    ["loop-queue", workflow({ ...agent(), loop: {}, for_each: {} }), /cannot combine/],
    ["queue-alias", workflow({ ...agent(), inputs: { item: "collision" }, for_each: { items: "$input.items", as: "item" } }), /conflicts/],
    ["queue-reference", workflow({ ...agent(), for_each: { items: "$nodes.ghost.output.items", as: "item" } }), /must be listed in needs/],
    ["negative-delay", { ...workflow(agent()), defaults: { delay_ms: -1 } }, /non-negative/],
  ];
  for (const [name, source, diagnostic] of invalid) {
    await t.test(`reject ${name} before start`, async () => {
      const before = await readdir(`${h.root}/runs`);
      const result = await h.cli("start", ["--workflow", await h.fixture(`invalid-${name}.yaml`, YAML.stringify(source))], 1);
      assert.match(result.stderr, diagnostic);
      assert.equal(result.stdout, "");
      assert.deepEqual(await readdir(`${h.root}/runs`), before);
    });
  }
  await t.test("CLI usage, missing files and malformed documents", async () => {
    assert.match((await h.cli("answer", [], 1)).stderr, /Usage:/);
    assert.match((await h.cli("answer", ["--run", "x", "--request", "x", "--answer", "  "], 1)).stderr, /Usage:/);
    assert.match((await h.cli("start", ["--mode", "unknown"], 1)).stderr, /--mode must be/);
    assert.match((await h.cli("start", ["--workflow", `${h.root}/missing.yaml`], 1)).stderr, /ENOENT/);
    assert.match((await h.cli("start", ["--input", await h.fixture("malformed.json", "{")], 1)).stderr, /SyntaxError/);
    assert.match((await h.cli("start", ["--workflow", await h.fixture("malformed.yaml", "nodes: [")], 1)).stderr, /YAMLParseError/);
    assert.match((await h.cli("setup", ["--unknown"], 1)).stderr, /Unknown setup option/);
    assert.match((await h.cli("setup", ["--check"], 1)).stderr, /Unset custom runtime/);
  });
});
