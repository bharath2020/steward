import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Harness, until } from "./harness";
import { sha256Json } from "../../src/completion-receipt";
import type { AgentCompletionReceipt } from "../../src/contracts";

test("installed Codex sandbox permits repository writes and denies an unrelated workspace", {
  timeout: 30_000, skip: process.env.STEWARD_TEST_CODEX_SANDBOX !== "1",
}, async t => {
  const repository = await mkdtemp(join(tmpdir(), "steward-sandbox-"));
  const outside = resolve(`.steward-denied-${process.pid}.txt`);
  t.after(() => unlink(outside).catch(() => undefined));
  const program = `const fs = require('node:fs'), assert = require('node:assert/strict');
fs.writeFileSync('allowed.txt', 'repository write succeeded');
assert.throws(() => fs.writeFileSync(${JSON.stringify(outside)}, 'must be denied'), error => ['EPERM','EACCES','EROFS'].includes(error.code));`;
  await promisify(execFile)("codex", ["sandbox", "--permission-profile", ":workspace", "--cd", repository, "--", process.execPath, "-e", program], { timeout: 20_000 });
  assert.equal(await readFile(join(repository, "allowed.txt"), "utf8"), "repository write succeeded");
});

test("live Codex writes in the selected repository and resumes the same session", {
  timeout: 240_000, skip: process.env.STEWARD_TEST_LIVE_CODEX !== "1",
}, async t => {
  const h = new Harness(); t.after(() => h.stop()); await h.start();
  const repo = join(h.root, "live-repository"); await mkdir(repo);
  const workflow = await h.fixture("live.yaml", `version: 1
name: live-workspace-smoke
defaults:
  retry: {maximum_attempts: 1}
nodes:
  repeat:
    kind: scope
    loop:
      max_iterations: 2
      agent_sessions: resume
      initial: {round: 0}
      next: {round: $output.result.round}
      until: {path: result.round, operator: equals, value: 2}
    nodes:
      writer:
        prompt: >-
          This is a bounded filesystem smoke test. Run pwd to observe your working
          directory. If input round is 0, write live-marker.txt in that directory
          containing exactly steward workspace smoke. If round is 1, read and verify
          that file without rewriting it. Do no other repository work. Return the
          actual absolute directory and round equal to input round plus 1.
        inputs: {round: $state.round}
        outputs: {directory: string, round: number}
    outputs: {result: $nodes.writer.output}
`);
  const result = await h.cli("start", ["--workflow", workflow, "--mode", "codex", "--working-directory", repo]);
  const run = JSON.parse(result.stdout).runId;
  const state = await until(async () => {
    const state = await h.json<any>(run, "state.json").catch(() => undefined);
    return state && ["completed", "failed", "waiting_for_recovery"].includes(state.status) ? state : undefined;
  }, "live Codex completion", 210_000);
  assert.equal(state.status, "completed", JSON.stringify(state));
  assert.equal((await readFile(join(repo, "live-marker.txt"), "utf8")).trim(), "steward workspace smoke");
  assert.equal(state.finalOutputs.repeat.result.directory, await realpath(repo));
  const files = await readdir(join(h.root, "runs", run), { recursive: true });
  const receipts = await Promise.all(files.filter(file => file.endsWith("completion-receipt.json")).map(file => h.json<AgentCompletionReceipt>(run, file)));
  assert.equal(receipts.length, 2);
  assert(receipts[0].providerSessionId);
  assert.equal(receipts[0].providerSessionId, receipts[1].providerSessionId);
  for (const receipt of receipts) {
    const { receiptSha256, ...body } = receipt;
    assert.equal(receiptSha256, sha256Json(body));
    assert.equal(receipt.sessionAffinity?.canonicalWorkspace, await realpath(repo));
  }
  const handle = h.client.workflow.getHandle(`yamlflow-${run}`);
  await until(async () => (await handle.describe()).status.name === "COMPLETED" ? true : undefined, "live Temporal closure");
  assert.deepEqual(await handle.result(), state.finalOutputs);
  await writeFile(join(h.root, "live-history.json"), JSON.stringify(await handle.fetchHistory()));
});

test("start requires an explicit repository working directory before creating a run", { timeout: 60_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  const result = await h.cli("start", ["--workflow", "workflows/product-launch.yaml", "--mode", "simulated"], 1);
  assert.match(result.stderr, /working.directory.*required/i);
  assert.equal(result.stdout, "");
  const executions = [];
  for await (const execution of h.client.workflow.list()) executions.push(execution);
  assert.equal(executions.length, 0, "Rejected starts must not create Temporal executions");
});

test("HTTP rejects missing and invalid working directories without starting runs", { timeout: 60_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  h.launch(process.execPath, ["--import", "tsx", "--eval", `const s = require(${JSON.stringify(resolve("src/server/index.ts"))}).createDashboardServer(); s.listen(0, '127.0.0.1', () => console.log('PORT=' + s.address().port));`], "dashboard");
  const port = await until(async () => (await readFile(join(h.root, "dashboard.log"), "utf8").catch(() => "")).match(/PORT=(\d+)/)?.[1], "dashboard port");
  for (const workingDirectory of [undefined, "", 123, join(h.root, "absent"), await h.fixture("file.txt", "not a directory")]) {
    const response = await fetch(`http://127.0.0.1:${port}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workingDirectory }) });
    assert.equal(response.status, 400);
    assert.match((await response.json() as any).error, /working directory/i);
  }
  const rejectedHeaders: Record<string, string>[] = [
    { "content-type": "application/json", origin: "https://unrelated.example" },
    { "content-type": "text/plain" },
  ];
  for (const headers of rejectedHeaders) {
    const response = await fetch(`http://127.0.0.1:${port}/api/runs`, { method: "POST", headers, body: JSON.stringify({ workingDirectory: h.root }) });
    assert.equal(response.status, 403, `Untrusted browser requests cannot authorize repository writes: ${JSON.stringify(headers)}`);
  }
  // Fetch normalizes Host; use a raw HTTP client to actually send a foreign Host.
  const foreignHostStatus = await new Promise<number | undefined>((done, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/api/runs`, { method: "POST", headers: { "content-type": "application/json", host: "unrelated.example" } }, response => {
      response.resume(); response.once("end", () => done(response.statusCode));
    });
    request.once("error", reject); request.end(JSON.stringify({ workingDirectory: h.root }));
  });
  assert.equal(foreignHostStatus, 403);
  const executions = [];
  for await (const execution of h.client.workflow.list()) executions.push(execution);
  assert.equal(executions.length, 0);
});

// Controlled external CLI; exercises real Temporal + Activity + filesystem writes.
// This verifies adapter behavior, not the enforcement of the real Codex sandbox.
const provider = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cwd = fs.realpathSync(process.cwd());
if (cwd !== process.env.STEWARD_TEST_WORKSPACE) throw new Error('Worker launched in the wrong repository: ' + cwd);
if (args[args.indexOf('--sandbox') + 1] !== 'workspace-write') throw new Error('Repository is not writable');
console.log(JSON.stringify({type:'thread.started',thread_id:'workspace-test-session'}));
fs.writeFileSync('worker-result.txt', 'written in assigned repository');
fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({directory:cwd,content:fs.readFileSync('worker-result.txt','utf8')}));
`;

test("a worker writes in the required repository and commits workspace-bound evidence", { timeout: 90_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  // Start Temporal first, then replace its worker with the controlled provider environment.
  await h.start();
  const repo = join(h.root, "repository with spaces");
  const bin = join(h.root, "bin");
  await mkdir(repo); await mkdir(bin);
  await writeFile(join(bin, "codex"), provider); await chmod(join(bin, "codex"), 0o755);
  const worker = h.children.pop()!;
  await new Promise<void>(done => { worker.once("exit", () => done()); worker.kill("SIGTERM"); });
  const env = h.env;
  h.env = { ...env, PATH: `${bin}:${process.env.PATH}`, STEWARD_TEST_WORKSPACE: await realpath(repo) };
  h.launch(process.execPath, ["--import", "tsx", "src/worker.ts"], "workspace-worker");
  h.env = env;
  const workflow = await h.fixture("write.yaml", `version: 1
name: repository-write
defaults:
  retry: {maximum_attempts: 1}
nodes:
  write:
    prompt: Write worker-result.txt in your assigned repository and return its content and directory.
    outputs: {directory: string, content: string}
`);
  const result = await h.cli("start", ["--workflow", workflow, "--mode", "codex", "--working-directory", repo]);
  const run = JSON.parse(result.stdout).runId;
  const state = await h.state(run, state => ["completed", "failed", "waiting_for_recovery"].includes(state.status));
  assert.equal(state.status, "completed", JSON.stringify(state));
  assert.equal(await readFile(join(repo, "worker-result.txt"), "utf8"), "written in assigned repository");
  const execution = { workingDirectory: await realpath(repo), sandbox: "workspace-write" };
  assert.deepEqual(await h.json(run, "execution.json"), execution);
  assert.deepEqual((state as any).execution, execution);
  const handle = h.client.workflow.getHandle(`yamlflow-${run}`);
  await until(async () => (await handle.describe()).status.name === "COMPLETED" ? true : undefined, "Temporal closure");
  assert.deepEqual(await handle.result(), state.finalOutputs);
});

test("restart and activity retry retain the canonical repository and committed work", { timeout: 120_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  const repo = join(h.root, "original"), other = join(h.root, "other"), alias = join(h.root, "alias"), bin = join(h.root, "bin");
  for (const dir of [repo, other, bin]) await mkdir(dir);
  await symlink(repo, alias);
  const log = join(h.root, "provider.jsonl");
  await writeFile(join(bin, "codex"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), prompt = args.at(-1);
const node = prompt.match(/workflow node ([^ ]+)/)[1];
const cwd = fs.realpathSync(process.cwd()), resumed = args.includes('resume');
const session = resumed ? args.at(-2) : 'session-' + node;
if (cwd !== process.env.STEWARD_TEST_WORKSPACE) throw new Error('Workspace drift');
if (args[args.indexOf('--sandbox') + 1] !== 'workspace-write') throw new Error('Permission drift');
fs.appendFileSync(process.env.STEWARD_TEST_LOG, JSON.stringify({node,cwd,resumed,session}) + '\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:session}));
if (node === 'finish' && !fs.existsSync('intent.txt')) {
  fs.writeFileSync('intent.txt', 'one edit before interruption');
  setTimeout(() => { console.error('network connection reset'); process.exit(1); }, 6000);
} else {
  if (node === 'finish' && !resumed) throw new Error('Retry lost its provider session');
  fs.writeFileSync(node + '.txt', node);
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({directory:cwd}));
}
`);
  await chmod(join(bin, "codex"), 0o755);
  const workerEnv = { ...h.env, PATH: `${bin}:${process.env.PATH}`, STEWARD_TEST_WORKSPACE: await realpath(repo), STEWARD_TEST_LOG: log };
  async function replaceWorker(cwd: string) {
    const worker = h.children.pop()!;
    await new Promise<void>(done => { worker.once("exit", () => done()); worker.kill("SIGKILL"); });
    const env = h.env; h.env = workerEnv;
    h.launch(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/worker.ts")], "replacement-worker", cwd);
    h.env = env;
  }
  await replaceWorker(process.cwd());
  const workflow = await h.fixture("restart.yaml", `version: 1
name: repository-recovery
defaults:
  retry: {maximum_attempts: 2}
nodes:
  seed:
    prompt: Write seed.txt.
    outputs: {directory: string}
  pause:
    kind: human
    needs: [seed]
    question: Continue after restart?
  finish:
    needs: [pause]
    prompt: Complete the interrupted edit without duplicating it.
    outputs: {directory: string}
`);
  const result = await h.cli("start", ["--workflow", workflow, "--mode", "codex", "--working-directory", alias]);
  const run = JSON.parse(result.stdout).runId;
  const first = await h.state(run, state => state.status === "waiting_for_human");
  const seed = await readFile(join(h.root, "runs", run, "nodes/seed/output.json"), "utf8");
  await unlink(alias); await symlink(other, alias);
  await replaceWorker(other);
  const handle = h.client.workflow.getHandle(`yamlflow-${run}`);
  await handle.executeUpdate("submitHumanInput", { args: [{ requestId: first.nodes.pause.humanRequest!.requestId, answer: "continue" }] });
  const state = await h.state(run, state => ["completed", "failed", "waiting_for_recovery"].includes(state.status));
  assert.equal(state.status, "completed", JSON.stringify(state));
  assert.equal(await readFile(join(h.root, "runs", run, "nodes/seed/output.json"), "utf8"), seed);
  assert.equal(await readFile(join(repo, "intent.txt"), "utf8"), "one edit before interruption");
  assert.deepEqual(await readdir(other), [], "Restart cwd and retargeted alias must receive no writes");
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => [call.node, call.resumed]), [["seed", false], ["finish", false], ["finish", true]]);
  assert.equal(calls[1].session, calls[2].session);
  const files = await readdir(join(h.root, "runs", run), { recursive: true });
  for (const file of files.filter(file => file.endsWith("completion-receipt.json"))) {
    const receipt = await h.json<AgentCompletionReceipt>(run, file);
    const { receiptSha256, ...body } = receipt;
    assert.equal(receiptSha256, sha256Json(body));
    assert.deepEqual(receipt.execution, { workingDirectory: await realpath(repo), sandbox: "workspace-write" });
  }
  await until(async () => (await handle.describe()).status.name === "COMPLETED" ? true : undefined, "Temporal closure");
  assert.deepEqual(await handle.result(), state.finalOutputs);
  await writeFile(join(h.root, "recovery-history.json"), JSON.stringify(await handle.fetchHistory()));
});

test("Console requires a directory and submits it with the run", { timeout: 90_000, skip: !process.env.STEWARD_PLAYWRIGHT_MODULE }, async t => {
  const { chromium } = require(process.env.STEWARD_PLAYWRIGHT_MODULE!);
  const h = new Harness(); t.after(() => h.stop()); await h.start();
  h.env.YAMLFLOW_WORKFLOW = await h.fixture("browser.yaml", "version: 1\nname: browser-directory\nnodes:\n  step:\n    prompt: Return the fixture.\n    outputs: {value: number}\n    demo_output: {value: 1}\n");
  h.launch(process.execPath, ["--import", "tsx", "--eval", `const s = require(${JSON.stringify(resolve("src/server/index.ts"))}).createDashboardServer(); s.listen(0, '127.0.0.1', () => console.log('PORT=' + s.address().port));`], "dashboard");
  const port = await until(async () => (await readFile(join(h.root, "dashboard.log"), "utf8").catch(() => "")).match(/PORT=(\d+)/)?.[1], "dashboard port");
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${port}`);
  const field = page.getByLabel("Working directory", { exact: true });
  assert.equal(await field.count(), 1);
  assert.equal(await field.getAttribute("required"), "");
  let submissions = 0;
  page.on("request", (request: any) => { if (request.method() === "POST" && request.url().endsWith("/api/runs")) submissions++; });
  await page.getByRole("button", { name: /Run again/ }).click();
  assert.equal(submissions, 0);
  await field.fill(h.root);
  const responsePromise = page.waitForResponse((response: any) => response.url().endsWith("/api/runs") && response.request().method() === "POST");
  await page.getByRole("button", { name: /Run again/ }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 202);
  assert.equal(response.request().postDataJSON().workingDirectory, h.root);
  const { runId } = await response.json();
  const state = await h.finished(runId);
  assert.equal(state.execution?.workingDirectory, await realpath(h.root));
  await page.screenshot({ path: join(h.root, "working-directory-console.png"), fullPage: true });
});
