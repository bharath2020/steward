import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import type { TransitionInput } from "../src/contracts";
import { parseWorkflow } from "../src/definition";

// Review regressions added while integrity implementation was being hardened;
// these are not claimed as part of the original pre-implementation RED suite.
test("scope artifact acceptance verifies declared exports and committed child evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "steward-scope-artifacts-"));
  const previousRuntime = process.env.YAMLFLOW_RUNTIME_DIR;
  process.env.YAMLFLOW_RUNTIME_DIR = root;
  t.after(() => { if (previousRuntime === undefined) delete process.env.YAMLFLOW_RUNTIME_DIR; else process.env.YAMLFLOW_RUNTIME_DIR = previousRuntime; });
  const { commitScopeIteration } = await import("../src/scope-artifacts");
  const { commitCompletionReceipt, completionPaths, sha256Json } = await import("../src/completion-receipt");
  const { initializeRun, recordTransition } = await import("../src/store");
  let sequence = 0;
  async function fixture(nested = false, ownLoop = false) {
    const scope = { kind: "scope", nodes: { leaf: { prompt: "Return a boolean.", outputs: { success: "boolean" }, ...(ownLoop ? { loop: { max_iterations: 2, on_exhaustion: "accept_last", until: { path: "success", operator: "equals", value: false } } } : {}) } }, outputs: { success: "$nodes.leaf.output.success" } };
    const nodes = nested ? { outer: { kind: "scope", nodes: { scope }, outputs: { success: "$nodes.scope.output.success" } } } : { scope };
    const definition = parseWorkflow(YAML.stringify({ version: 1, name: "Scope evidence fixture", nodes }));
    const runId = `scope-integrity-${++sequence}`;
    const base = { runId, temporalRunId: "temporal-fixture", definition, mode: "simulated" as const, initialInput: {} };
    await initializeRun({ ...base, id: `${runId}:started`, type: "run.started", message: "Fixture initialized" }, definition, {});
    const scopeId = nested ? "outer~1.scope" : "scope";
    const scopeNode = nested ? definition.nodes[0].nodes![0] : definition.nodes[0];
    const node = { ...scopeNode.nodes![0], id: `${scopeId}~1.leaf` };
    const execution = { ...base, node, input: {}, wave: 1, iteration: 1, recoveryCycle: 0, receiptToken: "test-dispatch" };
    const output = { success: true };
    const receipt = await commitCompletionReceipt({ execution, promptSha256: "fixture-prompt", outputSchemaSha256: sha256Json(node.outputSchema), output });
    await recordTransition({ ...base, id: `${runId}:leaf:completed`, nodeId: node.id, type: "node.completed", message: "Fixture child committed", data: { output, iteration: 1, receiptSha256: receipt.receiptSha256 } });
    let terminalReceipt = receipt;
    if (ownLoop) {
      terminalReceipt = await commitCompletionReceipt({ execution: { ...execution, iteration: 2, receiptToken: "second-dispatch" }, promptSha256: "fixture-prompt", outputSchemaSha256: sha256Json(node.outputSchema), output });
      await recordTransition({ ...base, id: `${runId}:leaf:second:completed`, nodeId: node.id, type: "node.completed", message: "Second iteration committed", data: { output, iteration: 2, receiptSha256: terminalReceipt.receiptSha256 } });
    }
    const commit: TransitionInput = { ...base, id: `${runId}:scope:committed`, nodeId: scopeId, type: "scope.iteration_committed", message: "Scope committed", data: { iteration: 1, output, children: [node.id], scopeInput: {} } };
    const parentCommit: TransitionInput = { ...base, id: `${runId}:outer:committed`, nodeId: "outer", type: "scope.iteration_committed", message: "Outer committed", data: { iteration: 1, output, children: [scopeId], scopeInput: {} } };
    return { commit, parentCommit, receipt, terminalReceipt, terminalPaths: completionPaths({ ...execution, iteration: 2, receiptToken: "second-dispatch" }), paths: completionPaths(execution), artifact: join(root, "runs", runId, "nodes", scopeId, "scope-iterations", "1", "output.json") };
  }
  await t.test("identical recommit preserves bytes and binds schema and child receipt hash", async () => {
    const f = await fixture();
    await commitScopeIteration(f.commit);
    const first = await readFile(f.artifact, "utf8");
    await commitScopeIteration(f.commit);
    assert.equal(await readFile(f.artifact, "utf8"), first);
    const artifact = JSON.parse(first);
    assert.equal(artifact.outputSchemaSha256, sha256Json(f.commit.definition.nodes[0].outputSchema));
    assert.equal(artifact.outputSha256, sha256Json({ success: true }));
    assert(artifact.children[0].evidence.includes(f.receipt.receiptSha256));
  });
  await t.test("rejects output that violates inferred schema before publication", async () => {
    const f = await fixture();
    f.commit.data = { ...(f.commit.data as object), output: { success: "wrong" } };
    await assert.rejects(commitScopeIteration(f.commit), /Invalid committed output/);
    await assert.rejects(readFile(f.artifact), { code: "ENOENT" });
  });
  await t.test("rejects schema-valid output that disagrees with export binding", async () => {
    const f = await fixture();
    f.commit.data = { ...(f.commit.data as object), output: { success: false } };
    await assert.rejects(commitScopeIteration(f.commit), /export bindings/);
  });
  await t.test("rejects incomplete child set", async () => {
    const f = await fixture();
    f.commit.data = { ...(f.commit.data as object), children: [] };
    await assert.rejects(commitScopeIteration(f.commit), /complete declared child set/);
  });
  await t.test("rejects absent accepted child receipts despite completed projection", async () => {
    const f = await fixture();
    const files = await import("node:fs/promises").then(fs => fs.readdir(f.paths.directory, { recursive: true }));
    for (const path of files.filter(path => path.endsWith("completion-receipt.json"))) await rm(join(f.paths.directory, path));
    // The primary immutable receipt can reside outside the attempt directory.
    await rm(f.paths.primaryReceiptPath, { force: true });
    await rm(f.paths.mirrorReceiptPath, { force: true });
    await assert.rejects(commitScopeIteration(f.commit), /accepted receipt|ENOENT/);
  });
  await t.test("rejects corrupted child output", async () => {
    const f = await fixture();
    await writeFile(f.paths.outputPath, JSON.stringify({ success: false }));
    await assert.rejects(commitScopeIteration(f.commit), /Corrupt child output/);
  });
  await t.test("rejects corrupted child receipt", async () => {
    const f = await fixture();
    await writeFile(f.paths.primaryReceiptPath, JSON.stringify({ ...f.receipt, receiptSha256: "corrupt" }));
    await assert.rejects(commitScopeIteration(f.commit), /Corrupt child receipt|accepted receipt/);
  });
  await t.test("scope binds the terminal loop receipt when iterations return identical values", async () => {
    const f = await fixture(false, true);
    await commitScopeIteration(f.commit);
    const artifact = JSON.parse(await readFile(f.artifact, "utf8"));
    assert.deepEqual(artifact.children[0].evidence, [f.terminalReceipt.receiptSha256]);
    assert.notEqual(f.receipt.receiptSha256, f.terminalReceipt.receiptSha256);
  });
  await t.test("corrupt superseded receipt does not replace or invalidate valid terminal evidence", async () => {
    const f = await fixture(false, true);
    await writeFile(f.paths.primaryReceiptPath, JSON.stringify({ ...f.receipt, receiptSha256: "corrupt-superseded-receipt" }));
    await commitScopeIteration(f.commit);
    const artifact = JSON.parse(await readFile(f.artifact, "utf8"));
    assert.deepEqual(artifact.children[0].evidence, [f.terminalReceipt.receiptSha256]);
  });
  await t.test("earlier equal output cannot replace a missing terminal loop receipt", async () => {
    const f = await fixture(false, true);
    await rm(f.terminalPaths.primaryReceiptPath);
    await rm(f.terminalPaths.mirrorReceiptPath);
    await assert.rejects(commitScopeIteration(f.commit), /receipt/i);
  });
  await t.test("parent refuses nested scope evidence whose child provenance was corrupted", async () => {
    const f = await fixture(true);
    await commitScopeIteration(f.commit);
    await recordTransition({ ...f.commit, id: `${f.commit.runId}:inner:completed`, type: "node.completed", data: { output: { success: true } } });
    const artifact = JSON.parse(await readFile(f.artifact, "utf8"));
    artifact.children[0].evidence[0] = "corrupted-accepted-child-hash";
    await writeFile(f.artifact, JSON.stringify(artifact));
    await assert.rejects(commitScopeIteration(f.parentCommit), /evidence|hash|corrupt/i);
  });
  await t.test("refuses to replace corrupted committed scope evidence", async () => {
    const f = await fixture();
    await commitScopeIteration(f.commit);
    await writeFile(f.artifact, "{partial");
    await assert.rejects(commitScopeIteration(f.commit), /different contents/);
    assert.equal(await readFile(f.artifact, "utf8"), "{partial");
  });
});
