import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import YAML from "yaml";
import { loadWorkflow, parseWorkflow } from "../src/definition";
import type { WorkflowDefinition } from "../src/contracts";
import { resolveNodeInputs } from "../src/resolver";

function source(node: Record<string, unknown>): string {
  return YAML.stringify({ version: 1, name: "File prompt", nodes: {
    review: { outputs: { summary: "string" }, ...node },
  } });
}

async function fixture(t: TestContext, node: Record<string, unknown> = { prompt_file: "./prompts/review.md" }) {
  const directory = await mkdtemp(join(tmpdir(), "steward-prompt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "prompts"));
  const workflow = join(directory, "workflow.yaml");
  const prompt = join(directory, "prompts", "review.md");
  await writeFile(workflow, source(node));
  return { directory, workflow, prompt };
}

test("file prompts resolve relative to YAML and preserve exact Unicode text and input bindings", async (t) => {
  const paths = await fixture(t, { prompt_file: "./prompts/review.md", inputs: { brief: "$input.brief" } });
  const content = "\uFEFF# Review café\r\n\r\n  Keep $input.brief and {{braces}} literal.\n";
  await writeFile(paths.prompt, content);
  const definition = await loadWorkflow(paths.workflow);
  const node = definition.nodes[0];
  assert.equal(node.prompt, content);
  assert.deepEqual(node.promptSource, {
    path: "./prompts/review.md",
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  assert.deepEqual(resolveNodeInputs(node, { brief: "Check correctness" }, {}), { brief: "Check correctness" });
  const inline = parseWorkflow(source({ prompt: content, inputs: { brief: "$input.brief" } }));
  assert.equal(inline.nodes[0].prompt, node.prompt);
  assert.deepEqual(inline.nodes[0].outputSchema, node.outputSchema);
});

test("saved definitions survive prompt edits and deletion; new loads bind changed content", async (t) => {
  const paths = await fixture(t);
  await writeFile(paths.prompt, "Original assignment\n");
  const first = await loadWorkflow(paths.workflow);
  const serialized = JSON.stringify(first);
  await writeFile(paths.prompt, "Revised assignment\n");
  const second = await loadWorkflow(paths.workflow);
  assert.notEqual(first.definitionHash, second.definitionHash);
  assert.notEqual(first.nodes[0].promptSource?.sha256, second.nodes[0].promptSource?.sha256);
  await rm(paths.prompt);
  const restored = JSON.parse(serialized) as WorkflowDefinition;
  assert.equal(restored.nodes[0].prompt, "Original assignment\n");
  assert.deepEqual(restored, JSON.parse(JSON.stringify(first)));
  await assert.rejects(loadWorkflow(paths.workflow), /node review\.prompt_file.*cannot be read as UTF-8/);
});

test("pure parser accepts supplied contents and never silently reads files", async (t) => {
  const paths = await fixture(t);
  await writeFile(paths.prompt, "On disk");
  const yaml = await readFile(paths.workflow, "utf8");
  assert.throws(() => parseWorkflow(yaml, paths.workflow), /use loadWorkflow/);
  const parsed = parseWorkflow(yaml, paths.workflow, new Map([["./prompts/review.md", "Supplied snapshot"]]));
  assert.equal(parsed.nodes[0].prompt, "Supplied snapshot");
});

test("rejects missing, ambiguous and malformed prompt sources in both entrypoints", async (t) => {
  const paths = await fixture(t);
  const invalid: [Record<string, unknown>, RegExp][] = [
    [{}, /exactly one of prompt or prompt_file/],
    [{ prompt: "Inline", prompt_file: "missing.md" }, /exactly one/],
    [{ prompt: null, prompt_file: "missing.md" }, /exactly one/],
    [{ prompt: "Inline", prompt_file: null }, /exactly one/],
    ...[null, false, 42, {}, [], "", " \n", "bad\0path"].map((prompt_file): [Record<string, unknown>, RegExp] =>
      [{ prompt_file }, /prompt_file must be a non-empty file path/]),
    [{ kind: "human", question: "Continue?", prompt_file: "missing.md" }, /not supported for human input/],
  ];
  for (const [node, message] of invalid) {
    const yaml = source(node);
    assert.throws(() => parseWorkflow(yaml), message);
    await writeFile(paths.workflow, yaml);
    await assert.rejects(loadWorkflow(paths.workflow), message);
  }
});

test("rejects empty, missing, directory and malformed UTF-8 prompt files with node context", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(loadWorkflow(paths.workflow), /node review\.prompt_file.*cannot be read/);
  for (const content of ["", " \n\t ", "\uFEFF"]) {
    await writeFile(paths.prompt, content);
    await assert.rejects(loadWorkflow(paths.workflow), /node review\.prompt_file.*non-empty prompt/);
  }
  await writeFile(paths.prompt, Buffer.from([0xc3, 0x28]));
  await assert.rejects(loadWorkflow(paths.workflow), /node review\.prompt_file.*cannot be read as UTF-8/);
  await writeFile(paths.workflow, source({ prompt_file: "./prompts" }));
  await assert.rejects(loadWorkflow(paths.workflow), /node review\.prompt_file.*cannot be read as UTF-8/);
});

test("supports mixed inline, shared file, and human nodes without changing their contracts", async (t) => {
  const paths = await fixture(t);
  await writeFile(paths.prompt, "Shared assignment");
  await writeFile(paths.workflow, YAML.stringify({ version: 1, name: "Mixed", nodes: {
    first: { prompt_file: "./prompts/review.md", outputs: { summary: "string" } },
    second: { prompt_file: "prompts/../prompts/review.md", outputs: { summary: "string" } },
    inline: { prompt: "Combine", needs: ["first", "second"], outputs: { summary: "string" } },
    answer: { kind: "human", needs: ["inline"], question: "$nodes.inline.output.summary" },
  } }));
  const definition = await loadWorkflow(paths.workflow);
  assert.deepEqual(definition.nodes.map((node) => node.prompt), [
    "Shared assignment", "Shared assignment", "Combine", "Wait for the operator's answer.",
  ]);
  assert.deepEqual(definition.nodes[2].needs, ["first", "second"]);
  assert.deepEqual(definition.nodes[3].outputs, { answer: "string" });
  assert.equal(definition.nodes[2].promptSource, undefined);
  assert.equal(definition.nodes[3].promptSource, undefined);
});

test("file definition identity excludes the containing directory and retains declared paths", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await writeFile(first.prompt, "Portable");
  await writeFile(second.prompt, "Portable");
  const a = await loadWorkflow(first.workflow);
  const b = await loadWorkflow(second.workflow);
  assert.notEqual(a.sourcePath, b.sourcePath);
  assert.equal(a.definitionHash, b.definitionHash);
  assert.deepEqual(a.nodes, b.nodes);
});

test("explicit absolute prompt paths are supported", async (t) => {
  const paths = await fixture(t);
  await writeFile(paths.prompt, "Absolute");
  await writeFile(paths.workflow, source({ prompt_file: paths.prompt }));
  assert.equal((await loadWorkflow(paths.workflow)).nodes[0].prompt, "Absolute");
});

test("legacy inline-only definition hash remains unchanged", async () => {
  const definition = await loadWorkflow("workflows/product-launch.yaml");
  assert.equal(definition.definitionHash, "adf3039fd7abe7c07cbea9ed3963787aea48ee04e2d0ab7852304ad1d8ec6858");
  assert.ok(definition.nodes.every((node) => !Object.hasOwn(node, "promptSource")));
});

test("loads the runnable file prompt example", async () => {
  const definition = await loadWorkflow("workflows/file-prompt.yaml");
  assert.equal(definition.nodes[0].prompt, await readFile("workflows/prompts/review.md", "utf8"));
  assert.deepEqual(definition.nodes[0].demo_output, { summary: "The brief has been reviewed." });
});
