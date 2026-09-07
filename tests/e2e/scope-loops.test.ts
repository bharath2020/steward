import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import Ajv from "ajv";
import YAML from "yaml";
import type { AgentCompletionReceipt, JsonValue } from "../../src/contracts";
import { sha256Json } from "../../src/completion-receipt";
import { Harness, until } from "./harness";

const agent = (role: string, outputs: object, demo_outputs: object[], inputs: object = {}, dependencies: string[] = []) => ({
  kind: "agent", prompt: "Return the declared deterministic acceptance fixture.",
  inputs: { test_role: role, ...inputs }, outputs, demo_outputs,
  ...(dependencies.length ? { depends_on: dependencies } : {}),
});
const definition = (nodes: object) => ({
  version: 1, name: "Composable scope acceptance", defaults: { max_parallelism: 4, retry: { maximum_attempts: 1 } }, nodes,
});

// Reconcile Temporal closure, projection, and every provider receipt. Read the
// committed schema artifact rather than assuming a flat definition/node ID map.
async function evidence(h: Harness, run: string) {
  const state = await h.state(run, state => ["completed", "failed"].includes(state.status));
  assert.equal(state.status, "completed", JSON.stringify(state));
  const handle = h.client.workflow.getHandle(`yamlflow-${run}`);
  await until(async () => (await handle.describe()).status.name === "COMPLETED" ? true : undefined, "Temporal completed");
  assert.deepEqual(await handle.result(), state.finalOutputs);
  const files = await readdir(`${h.root}/runs/${run}`, { recursive: true });
  const receipts = await Promise.all(files.filter(file => file.endsWith("completion-receipt.json")).map(async file => {
    const receipt = await h.json<AgentCompletionReceipt>(run, file);
    const { receiptSha256, ...body } = receipt;
    assert.equal(receiptSha256, sha256Json(body));
    assert.equal(receipt.outputSha256, sha256Json(receipt.output));
    assert.equal(receipt.runId, run);
    assert.equal(receipt.temporalRunId, state.temporalRunId);
    assert.equal(receipt.provider, "simulated");
    const sibling = (name: string) => file.replace("completion-receipt.json", name);
    assert.deepEqual(await h.json(run, sibling("output.json")), receipt.output);
    const validator = new Ajv({ strict: false });
    assert(validator.validate(await h.json<object>(run, sibling("schema.json")), receipt.output), validator.errorsText());
    const input = await h.json<Record<string, JsonValue>>(run, sibling("input.json"));
    return { file, receipt, input };
  }));
  assert(receipts.length > 0, "A successful run must have committed provider evidence");
  assert.equal(new Set(receipts.map(item => item.file)).size, receipts.length);
  return { state, receipts, events: await h.events(run) };
}

test("scope loops through CLI and real Temporal", { timeout: 180_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();

  await t.test("baseline proves isolated Temporal and receipt harness are healthy", async () => {
    const source = definition({ baseline: agent("baseline", { value: "number" }, [{ value: 1 }]) });
    const run = await h.run(await h.fixture("scope-baseline.yaml", YAML.stringify(source)));
    assert.equal((await evidence(h, run)).receipts.length, 1);
  });

  await t.test("draft and review repeat with explicit carried state before downstream runs once", async () => {
    const source = definition({
      improve: {
        kind: "scope", inputs: { brief: "$input.brief" },
        loop: {
          max_iterations: 3, on_exhaustion: "fail", initial: { draft: "", feedback: "" },
          next: { draft: "$output.draft", feedback: "$output.feedback" },
          until: { path: "approved", operator: "equals", value: true },
        },
        nodes: {
          draft: agent("draft", { text: "string" }, [{ text: "first" }, { text: "revised" }], {
            brief: "$input.brief", previous_draft: "$state.draft", feedback: "$state.feedback",
          }),
          review: agent("review", { approved: "boolean", feedback: "string" }, [
            { approved: false, feedback: "Revise the draft" }, { approved: true, feedback: "Approved" },
          ], { draft: "$nodes.draft.output" }, ["draft"]),
        },
        outputs: { draft: "$nodes.draft.output.text", feedback: "$nodes.review.output.feedback", approved: "$nodes.review.output.approved" },
      },
      summarize: agent("summarize", { done: "boolean" }, [{ done: true }], { draft: "$nodes.improve.output.draft" }, ["improve"]),
    });
    const input = await h.fixture("scope-input.json", JSON.stringify({ brief: "A test brief" }));
    const run = await h.run(await h.fixture("scope-draft-review.yaml", YAML.stringify(source)), input);
    const result = await evidence(h, run);
    assert.equal(result.receipts.length, 5, "Two full iterations and exactly one downstream invocation");
    const drafts = result.receipts.filter(item => item.input.test_role === "draft");
    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts.find(item => (item.receipt.output as { text: string }).text === "first")?.input,
      { test_role: "draft", brief: "A test brief", previous_draft: "", feedback: "" });
    assert.deepEqual(drafts.find(item => (item.receipt.output as { text: string }).text === "revised")?.input,
      { test_role: "draft", brief: "A test brief", previous_draft: "first", feedback: "Revise the draft" });
    assert.deepEqual(result.state.nodes.improve.output, { draft: "revised", feedback: "Approved", approved: true });
    assert.equal(result.receipts.find(item => item.input.test_role === "summarize")?.input.draft, "revised");
  });

  await t.test("review fans out to a group and repeats until both succeed in the same iteration", async () => {
    const source = definition({
      resolve: {
        kind: "scope", inputs: { task: "$input.task" },
        loop: {
          max_iterations: 4, on_exhaustion: "fail", initial: { results: null }, next: { results: "$output" },
          until: { all: [
            { path: "implementation.success", operator: "equals", value: true },
            { path: "validation.success", operator: "equals", value: true },
          ] },
        },
        nodes: {
          review: agent("review", { round: "number" }, [{ round: 1 }, { round: 2 }, { round: 3 }],
            { task: "$input.task", previous_results: "$state.results" }),
          parallel_work: {
            kind: "scope", depends_on: ["review"], inputs: { guidance: "$nodes.review.output" },
            nodes: {
              implementation: agent("implementation", { success: "boolean" }, [{ success: true }, { success: false }, { success: true }], { guidance: "$input.guidance" }),
              validation: agent("validation", { success: "boolean" }, [{ success: false }, { success: true }, { success: true }], { guidance: "$input.guidance" }),
            },
            outputs: { implementation: "$nodes.implementation.output", validation: "$nodes.validation.output" },
          },
        },
        outputs: { implementation: "$nodes.parallel_work.output.implementation", validation: "$nodes.parallel_work.output.validation" },
      },
      next_agent: agent("next_agent", { done: "boolean" }, [{ done: true }], { results: "$nodes.resolve.output" }, ["resolve"]),
    });
    // A meaningful simulated work interval makes concurrency observable in the
    // persisted event order without relying on elapsed wall-clock assertions.
    const started = await h.cli("start", ["--workflow", await h.fixture("scope-parallel.yaml", YAML.stringify(source)),
      "--input", await h.fixture("scope-task.json", JSON.stringify({ task: "Resolve this test" })),
      "--mode", "simulated", "--delay-ms", "500"]);
    const run = JSON.parse(started.stdout).runId as string;
    const { state, receipts, events } = await evidence(h, run);
    assert.equal(receipts.length, 10, "Three complete rounds; prior-round successes must not accumulate");
    const reviews = receipts.filter(item => item.input.test_role === "review");
    assert.equal(reviews.length, 3);
    assert.equal(reviews.find(item => (item.receipt.output as { round: number }).round === 1)?.input.previous_results, null);
    assert.deepEqual(reviews.find(item => (item.receipt.output as { round: number }).round === 2)?.input.previous_results,
      { implementation: { success: true }, validation: { success: false } });
    assert.deepEqual(reviews.find(item => (item.receipt.output as { round: number }).round === 3)?.input.previous_results,
      { implementation: { success: false }, validation: { success: true } });
    assert.deepEqual(state.nodes.resolve.output, { implementation: { success: true }, validation: { success: true } });
    for (const round of [1, 2, 3]) {
      const branches = receipts.filter(item => ["implementation", "validation"].includes(String(item.input.test_role))
        && (item.input.guidance as { round: number }).round === round);
      assert.equal(branches.length, 2);
      const starts = branches.map(branch => events.findIndex(event => event.nodeId === branch.receipt.nodeId && event.type === "node.started"));
      const completions = branches.map(branch => events.findIndex(event => event.nodeId === branch.receipt.nodeId && event.type === "node.completed"));
      assert(starts.every(index => index >= 0) && completions.every(index => index >= 0));
      assert(Math.max(...starts) < Math.min(...completions), "Both parallel agents must start before either completes");
      const review = reviews.find(item => (item.receipt.output as { round: number }).round === round)!;
      const reviewCompleted = events.findIndex(event => event.nodeId === review.receipt.nodeId && event.type === "node.completed");
      assert(reviewCompleted >= 0 && reviewCompleted < Math.min(...starts), "Review must commit before parallel agents start");
      if (round < 3) {
        const followingReview = reviews.find(item => (item.receipt.output as { round: number }).round === round + 1)!;
        const followingStart = events.findIndex(event => event.nodeId === followingReview.receipt.nodeId && event.type === "node.started");
        assert(Math.max(...completions) < followingStart, "Both branches must commit before the next review starts");
      }
    }
    const next = receipts.filter(item => item.input.test_role === "next_agent");
    assert.equal(next.length, 1);
    assert.deepEqual(next[0].input.results, state.nodes.resolve.output);
    const nextStart = events.findIndex(event => event.nodeId === next[0].receipt.nodeId && event.type === "node.started");
    for (const role of ["implementation", "validation"]) {
      const branches = receipts.filter(item => item.input.test_role === role);
      assert.equal(branches.length, 3, "Both agents rerun on every round");
      for (const branch of branches) {
        const completed = events.findIndex(event => event.nodeId === branch.receipt.nodeId && event.type === "node.completed");
        assert(completed >= 0 && completed < nextStart, "Downstream may run only after every branch commits");
      }
    }
  });
});
