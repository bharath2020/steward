import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import YAML from "yaml";
import { Harness, until } from "./harness";
import { sha256Json } from "../../src/completion-receipt";
import type { AgentCompletionReceipt, WorkflowDefinition } from "../../src/contracts";

/* PROVISIONAL ACCEPTANCE CONTRACT, not implemented/adopted API:
 * YAMLFLOW_CATALOG -> {workflows:[{id,name,workflow,input,allowedRoots}]}
 * GET /api/workflows; POST /api/runs/prepare {workflowId,inputText,mode}
 * -> {preparedId,definition,initialInput,mode}; POST /api/runs {preparedId,startId}
 * mode: simulated | workflow. Isolate exact spelling here when the design is adopted.
 * Browser prerequisite: installed Playwright+Chromium; STEWARD_PLAYWRIGHT_MODULE
 * may name an existing Playwright module directory. No paid provider is invoked.
 */
const contract = {
  catalog: "/api/workflows", prepare: "/api/runs/prepare", start: "/api/runs",
  workflowLabel: "Workflow", inputLabel: "Input JSON", modeLabel: "Execution mode",
  validateLabel: "Validate and preview", startLabel: "Start new run",
};

test("proposed dashboard picker through real browser, HTTP, Temporal and provider boundary", { timeout: 180_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  const bin = join(h.root, "provider-bin");
  await mkdir(bin);
  const providerLog = join(h.root, "provider-calls.jsonl");
  await writeFile(providerLog, "");
  await writeFile(join(bin, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args.at(-1);
const input = JSON.parse(prompt.split("RESOLVED INPUTS\\n").at(-1));
fs.appendFileSync(process.env.STEWARD_PICKER_PROVIDER_LOG, JSON.stringify({input, prompt}) + "\\n");
console.log(JSON.stringify({type:"thread.started",thread_id:"fixture-"+require("node:crypto").randomUUID()}));
fs.writeFileSync(args[args.indexOf("--output-last-message")+1], JSON.stringify({result:input.marker}));
`);
  await chmod(join(bin, "codex"), 0o755);
  // Relaunch only this isolated worker with the controlled external provider.
  const originalWorker = h.children.pop()!;
  await new Promise<void>(done => { originalWorker.once("exit", () => done()); originalWorker.kill("SIGTERM"); });
  h.env = { ...h.env, PATH: `${bin}:${process.env.PATH}`, STEWARD_PICKER_PROVIDER_LOG: providerLog };
  h.launch(process.execPath, ["--import", "tsx", "src/worker.ts"], "picker-worker");

  const leaf = (provider: string, result: string) => ({ agent: provider, prompt: "Return the marker as result.", inputs: { marker: "$input.marker" }, outputs: { result: "string" }, demo_output: { result } });
  const alpha = await h.fixture("alpha.yaml", YAML.stringify({ version: 1, name: "Alpha catalog", nodes: { alpha: leaf("simulated", "alpha fixture") } }));
  const beta = await h.fixture("beta.yaml", YAML.stringify({ version: 1, name: "Beta catalog", nodes: { local: leaf("simulated", "local fixture"), remote: leaf("codex", "remote fixture") } }));
  const configuredInput = await h.fixture("configured.json", JSON.stringify({ marker: "configured input" }));
  const betaInput = await h.fixture("beta-input.json", JSON.stringify({ marker: "beta example" }));
  const catalog = await h.fixture("catalog.json", JSON.stringify({ workflows: [
    { id: "alpha", name: "Alpha catalog", workflow: alpha, input: configuredInput, allowedRoots: [h.root] },
    { id: "beta", name: "Beta catalog", workflow: beta, input: betaInput, allowedRoots: [h.root] },
  ] }));
  const port = await new Promise<number>((done, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => done(port)); });
  });
  h.env = { ...h.env, YAMLFLOW_PORT: String(port), YAMLFLOW_WORKFLOW: alpha, YAMLFLOW_INPUT: configuredInput, YAMLFLOW_CATALOG: catalog };
  h.launch(process.execPath, ["--import", "tsx", "src/server.ts"], "picker-dashboard");
  const url = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${url}/health`)).ok ? true : undefined; } catch { h.assertAlive(); return undefined; } }, "dashboard readiness");
  const request = async (path: string, data?: unknown) => {
    const response = await fetch(`${url}${path}`, data === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const text = await response.text();
    let body: any; try { body = JSON.parse(text); } catch { body = { text }; }
    return { status: response.status, body };
  };
  const calls = async () => (await readFile(providerLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const runIds = async () => (await readdir(join(h.root, "runs"))).sort();
  async function accepted(runId: string, name: string, input: object, providers: string[]) {
    const state = await h.state(runId, state => state.status === "completed" || state.status === "failed");
    assert.equal(state.status, "completed", JSON.stringify(state));
    const handle = h.client.workflow.getHandle(`yamlflow-${runId}`);
    await until(async () => (await handle.describe()).status.name === "COMPLETED" ? true : undefined, "Temporal completed");
    assert.deepEqual(await handle.result(), state.finalOutputs);
    const definition = await h.json<WorkflowDefinition>(runId, "definition.json");
    assert.equal(definition.name, name);
    assert.deepEqual(await h.json(runId, "input.json"), input);
    const files = await readdir(join(h.root, "runs", runId), { recursive: true });
    const receipts = await Promise.all(files.filter(file => file.endsWith("completion-receipt.json")).map(file => h.json<AgentCompletionReceipt>(runId, file)));
    assert.deepEqual(receipts.map(receipt => receipt.provider).sort(), providers.slice().sort());
    for (const receipt of receipts) {
      const { receiptSha256, ...body } = receipt;
      assert.equal(receiptSha256, sha256Json(body));
      assert.equal(receipt.outputSha256, sha256Json(receipt.output));
      assert.equal(receipt.temporalRunId, state.temporalRunId);
      assert.deepEqual(receipt.output, state.nodes[receipt.nodeId].output);
      assert.deepEqual(await h.json(runId, `nodes/${receipt.nodeId}/output.json`), receipt.output);
    }
    return { state, definition, receipts };
  }
  async function prepare(id: string, inputText: string, mode = "simulated") {
    const response = await request(contract.prepare, { workflowId: id, inputText, mode });
    assert.equal(response.status, 200, `Proposed prepare contract: ${JSON.stringify(response)}`);
    assert.equal(typeof response.body.preparedId, "string");
    return response.body;
  }
  async function start(preparedId: string, startId = randomUUID()) {
    const response = await request(contract.start, { preparedId, startId });
    assert.equal(response.status, 202, JSON.stringify(response));
    assert.equal(typeof response.body.runId, "string");
    return response.body.runId as string;
  }

  let baselineRun = "";
  await t.test("healthy baseline starts configured workflow through existing HTTP and commits simulated evidence", async () => {
    const response = await request("/api/runs", { mode: "simulated", delayMs: 1 });
    assert.equal(response.status, 202, JSON.stringify(response));
    baselineRun = response.body.runId;
    await accepted(baselineRun, "Alpha catalog", { marker: "configured input" }, ["simulated"]);
    assert.equal((await calls()).length, 0);
  });

  const require = createRequire(__filename);
  const { chromium } = require(process.env.STEWARD_PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.goto(url);
  await page.locator(`[data-run-id="${baselineRun}"]`).waitFor();
  const screenshot = join(h.root, "dashboard-before-picker.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`Browser evidence: ${screenshot}`);

  await t.test("browser presents workflow selection and starts the reviewed chosen input in simulation", async () => {
    const picker = page.getByLabel(contract.workflowLabel, { exact: true });
    assert.equal(await picker.count(), 1, "Dashboard must expose an accessible Workflow picker");
    await picker.selectOption("beta");
    await page.getByLabel(contract.inputLabel, { exact: true }).fill(JSON.stringify({ marker: "chosen in browser" }));
    await page.getByLabel(contract.modeLabel, { exact: true }).selectOption("simulated");
    await page.getByRole("button", { name: contract.validateLabel, exact: true }).click();
    await page.getByRole("region", { name: "Workflow preview", exact: true }).waitFor();
    const started = page.waitForResponse((response: any) => response.url() === `${url}/api/runs` && response.request().method() === "POST");
    await page.getByRole("button", { name: contract.startLabel, exact: true }).click();
    const response = await started;
    assert.equal(response.status(), 202);
    const result = await response.json();
    await accepted(result.runId, "Beta catalog", { marker: "chosen in browser" }, ["simulated", "simulated"]);
    assert.equal((await calls()).length, 0, "Simulation must never launch Codex");
  });

  await t.test("catalog selection and reviewed data are bound to the accepted start", async () => {
    const catalogResponse = await request(contract.catalog);
    assert.equal(catalogResponse.status, 200, JSON.stringify(catalogResponse));
    const prepared = await prepare("beta", JSON.stringify({ marker: "reviewed beta" }));
    assert.equal(prepared.definition.name, "Beta catalog");
    assert.deepEqual(prepared.initialInput, { marker: "reviewed beta" });
    assert.equal(prepared.mode, "simulated");
    const run = await start(prepared.preparedId);
    const result = await accepted(run, "Beta catalog", { marker: "reviewed beta" }, ["simulated", "simulated"]);
    assert.deepEqual(result.definition, prepared.definition);
    assert.equal(result.state.mode, "simulated");
  });

  await t.test("workflow mode dispatches each declared provider while simulation overrides it", async () => {
    const before = (await calls()).length;
    const prepared = await prepare("beta", JSON.stringify({ marker: "declared providers" }), "workflow");
    const run = await start(prepared.preparedId);
    await accepted(run, "Beta catalog", { marker: "declared providers" }, ["codex", "simulated"]);
    const observed = (await calls()).slice(before);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].input.marker, "declared providers");
  });

  await t.test("invalid input preflight has actionable error and starts no durable work", async () => {
    const before = await runIds();
    const launches = (await calls()).length;
    const response = await request(contract.prepare, { workflowId: "beta", inputText: "{", mode: "simulated" });
    assert.equal(response.status, 400, JSON.stringify(response));
    assert.match(String(response.body.error), /JSON|input/i);
    assert.deepEqual(await runIds(), before);
    assert.equal((await calls()).length, launches);
  });

  await t.test("an unknown prepared intent cannot silently start the configured workflow", async () => {
    const before = await runIds();
    const response = await request(contract.start, { preparedId: "never-prepared", startId: randomUUID() });
    // Reconcile an erroneously accepted run before failing; never leave work running.
    if (response.status === 202) await accepted(response.body.runId, "Alpha catalog", { marker: "configured input" }, ["simulated"]);
    assert([400, 404, 409].includes(response.status), `Unknown prepared intent requires a validation error, not fallback or server failure: ${JSON.stringify(response)}`);
    assert.match(String(response.body.error), /prepar|intent/i);
    assert.deepEqual(await runIds(), before);
  });

  await t.test("history browsing preserves the separate unstarted workflow and input selection", async () => {
    await page.goto(url);
    const picker = page.getByLabel(contract.workflowLabel, { exact: true });
    assert.equal(await picker.count(), 1, "History and draft workflow selection require separate state");
    await picker.selectOption("beta");
    await page.getByLabel(contract.inputLabel, { exact: true }).fill(JSON.stringify({ marker: "unsaved choice" }));
    const before = await runIds();
    await page.locator(`[data-run-id="${baselineRun}"]`).click();
    assert.equal(await picker.inputValue(), "beta");
    assert.equal(await page.getByLabel(contract.inputLabel, { exact: true }).inputValue(), JSON.stringify({ marker: "unsaved choice" }));
    assert.deepEqual(await runIds(), before);
  });
});
