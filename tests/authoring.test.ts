import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowDraft, normalizeWorkflowDraftRequest, workflowAuthoringPrompt } from "../src/authoring";
import { createDashboardServer } from "../src/server/index";

const validYaml = `version: 1
name: Release review
description: Review readiness in parallel and join the findings.
defaults:
  provider: codex
  max_parallelism: 2
nodes:
  product_review:
    title: Product review
    prompt: Review product readiness.
    outputs: { findings: "string[]" }
  technical_review:
    title: Technical review
    prompt: Review technical readiness.
    outputs: { findings: "string[]" }
  synthesis:
    title: Readiness synthesis
    needs: [product_review, technical_review]
    prompt: Combine both reviews.
    inputs:
      product: $nodes.product_review.output.findings
      technical: $nodes.technical_review.output.findings
    outputs: { recommendation: string }
`;

test("authoring requests are bounded and provider-specific", () => {
  assert.deepEqual(normalizeWorkflowDraftRequest({ provider: "codex", message: "Build a review" }), {
    provider: "codex", message: "Build a review", history: [], currentYaml: undefined,
  });
  assert.throws(() => normalizeWorkflowDraftRequest({ provider: "simulated", message: "Build" }), /codex or claude/);
  assert.throws(() => normalizeWorkflowDraftRequest({ provider: "claude", message: " " }), /non-empty/);
  assert.throws(() => normalizeWorkflowDraftRequest({ provider: "claude", message: "Build", history: Array(13).fill({ role: "user", text: "x" }) }), /cannot exceed 12/);
});

test("authoring prompt binds the current draft and existing workflow contract", () => {
  const prompt = workflowAuthoringPrompt({
    provider: "claude",
    message: "Add a human approval",
    history: [{ role: "assistant", text: "I drafted a review." }],
    currentYaml: validYaml,
  });
  assert.match(prompt, /workflow\.v1/);
  assert.match(prompt, /inline prompts only/);
  assert.match(prompt, /Add a human approval/);
  assert.match(prompt, /Release review/);
});

test("authoring output is accepted only after the existing parser validates it", async () => {
  const draft = await createWorkflowDraft(
    { provider: "codex", message: "Build a release review" },
    async (provider, prompt) => {
      assert.equal(provider, "codex");
      assert.match(prompt, /LATEST USER REQUEST/);
      return JSON.stringify({ reply: "I created two parallel reviews with a final join.", workflow_yaml: validYaml });
    },
  );
  assert.equal(draft.definition.nodes.length, 3);
  assert.deepEqual(draft.definition.nodes.at(-1)?.needs, ["product_review", "technical_review"]);
  assert.equal(draft.definition.sourcePath, "generated-workflow.yaml");
});

test("invalid generated YAML is rejected instead of rendered", async () => {
  let attempts = 0;
  await assert.rejects(
    createWorkflowDraft(
      { provider: "claude", message: "Build an invalid cycle" },
      async () => {
        attempts += 1;
        return JSON.stringify({
          reply: "Drafted.",
          workflow_yaml: "version: 1\nname: broken\nnodes:\n  alpha:\n    needs: [ghost]\n    prompt: A\n    outputs: { value: string }",
        });
      },
    ),
    /unknown node ghost/,
  );
  assert.equal(attempts, 2, "one bounded repair pass should be attempted");
});

test("a parser diagnostic gets one repair pass before a draft is rendered", async () => {
  let attempts = 0;
  const draft = await createWorkflowDraft(
    { provider: "codex", message: "Build a release review" },
    async (_provider, prompt) => {
      attempts += 1;
      if (attempts === 1) return JSON.stringify({
        reply: "First draft.",
        workflow_yaml: "version: 1\nname: broken\nnodes:\n  alpha:\n    needs: [ghost]\n    prompt: A\n    outputs: { value: string }",
      });
      assert.match(prompt, /PARSER DIAGNOSTIC/);
      assert.match(prompt, /unknown node ghost/);
      return JSON.stringify({ reply: "Repaired the dependency.", workflow_yaml: validYaml });
    },
  );
  assert.equal(attempts, 2);
  assert.equal(draft.reply, "Repaired the dependency.");
  assert.equal(draft.definition.nodes.length, 3);
});

test("authoring HTTP accepts the local Console and rejects a foreign browser origin", async () => {
  let calls = 0;
  const server = createDashboardServer({ authoringRunner: async () => {
    calls += 1;
    return JSON.stringify({ reply: "Built a release review.", workflow_yaml: validYaml });
  } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/authoring/chat`;
  try {
    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:4310" },
      body: JSON.stringify({ provider: "codex", message: "Build a release review" }),
    });
    assert.equal(accepted.status, 200);
    const value = await accepted.json() as { definition: { nodes: unknown[] } };
    assert.equal(value.definition.nodes.length, 3);

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ provider: "codex", message: "Build a release review" }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(calls, 1, "foreign origins must be rejected before provider invocation");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
