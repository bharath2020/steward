import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Client, Connection } from "@temporalio/client";
import Ajv from "ajv";
import type { AgentCompletionReceipt, RunState, TimelineEvent, WorkflowDefinition } from "../../src/contracts";
import { sha256Json } from "../../src/completion-receipt";

export async function until<T>(read: () => Promise<T | undefined>, label: string, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

export class Harness {
  root = "";
  env: NodeJS.ProcessEnv = {};
  children: ChildProcess[] = [];
  connection?: Connection;
  client!: Client;
  async start() {
    this.root = await mkdtemp(join(tmpdir(), "steward-cli-e2e-"));
    console.log(`E2E evidence: ${this.root}`);
    const port = await new Promise<number>((done, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        server.close(() => done(port));
      });
    });
    this.env = { ...process.env, TEMPORAL_ADDRESS: `127.0.0.1:${port}`, YAMLFLOW_RUNTIME_DIR: this.root };
    for (const key of Object.keys(this.env)) if (key.startsWith("YAMLFLOW_TEST_")) delete this.env[key];
    this.launch("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(port), "--db-filename", join(this.root, "temporal.db")], "temporal");
    this.connection = await until(async () => {
      try { return await Connection.connect({ address: this.env.TEMPORAL_ADDRESS, connectTimeout: 1000 }); }
      catch { this.assertAlive(); return undefined; }
    }, "Temporal readiness");
    this.client = new Client({ connection: this.connection });
    this.launch(process.execPath, ["--import", "tsx", "src/worker.ts"], "worker");
  }
  assertAlive() {
    for (const child of this.children) assert(child.exitCode === null && child.signalCode === null, `Service exited; inspect ${this.root}`);
  }
  launch(command: string, args: string[], name: string) {
    const child = spawn(command, args, { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    const log = createWriteStream(join(this.root, `${name}.log`));
    child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
    child.on("error", error => { log.write(String(error)); });
    child.once("close", () => log.end());
    this.children.push(child);
  }
  async cli(command: string, args: string[] = [], expected = 0) {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", `src/${command}.ts`, ...args], { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`CLI timeout: ${command} ${args.join(" ")}`)); }, 20_000);
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    });
    assert.equal(result.code, expected, JSON.stringify(result));
    return result;
  }
  async run(workflow: string, input = "examples/product-input.json") {
    const result = await this.cli("start", ["--workflow", workflow, "--input", input, "--mode", "simulated", "--delay-ms", "5"]);
    const identity = JSON.parse(result.stdout);
    assert.equal(identity.workflowId, `yamlflow-${identity.runId}`);
    return identity.runId as string;
  }
  async json<T>(run: string, file: string): Promise<T> {
    return JSON.parse(await readFile(join(this.root, "runs", run, file), "utf8"));
  }
  async state(run: string, predicate: (state: RunState) => boolean) {
    return until(async () => {
      this.assertAlive();
      let state: RunState;
      try { state = await this.json(run, "state.json"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      return predicate(state) ? state : undefined;
    }, `run ${run}; evidence ${this.root}`);
  }
  async events(run: string): Promise<TimelineEvent[]> {
    return (await readFile(join(this.root, "runs", run, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  }
  async finished(run: string, status = "completed") {
    const state = await this.state(run, state => state.status === status);
    const handle = this.client.workflow.getHandle(`yamlflow-${run}`);
    await until(async () => (await handle.describe()).status.name === status.toUpperCase() ? true : undefined, "Temporal closure");
    if (status === "completed") {
      assert.equal(state.completedCount, state.totalCount);
      assert.deepEqual(await handle.result(), state.finalOutputs);
      const definition = await this.json<WorkflowDefinition>(run, "definition.json");
      const events = await this.events(run);
      const ajv = new Ajv({ strict: false });
      for (const node of definition.nodes) {
        const committed = events.filter(event => event.nodeId === node.id && event.type === "node.completed").at(-1);
        assert(committed, `Missing completion event for ${node.id}`);
        assert.deepEqual((committed.data as { output: unknown }).output, state.nodes[node.id].output);
        if (node.kind === "agent" && !node.for_each) {
          assert.deepEqual(await this.json(run, `nodes/${node.id}/output.json`), state.nodes[node.id].output);
        }
        const start = events.findIndex(event => event.nodeId === node.id && (event.type === "node.started" || event.type === "human.required"));
        for (const dependency of node.needs) {
          const completed = events.reduce((last, event, index) => event.nodeId === dependency && event.type === "node.completed" ? index : last, -1);
          if (start >= 0) assert(completed >= 0 && completed < start, `${node.id} started before ${dependency} committed`);
        }
      }
      const files = await readdir(join(this.root, "runs", run), { recursive: true });
      const receipts = files.filter(file => file.endsWith("completion-receipt.json"));
      for (const file of receipts) {
        const receipt = await this.json<AgentCompletionReceipt>(run, file);
        const { receiptSha256, ...body } = receipt;
        assert.equal(receiptSha256, sha256Json(body));
        assert.equal(receipt.outputSha256, sha256Json(receipt.output));
        assert.equal(receipt.runId, run);
        assert.equal(receipt.provider, "simulated");
        assert.equal(receipt.temporalRunId, state.temporalRunId);
        assert.deepEqual(await this.json(run, file.replace("completion-receipt.json", "output.json")), receipt.output);
        const node = definition.nodes.find(node => node.id === receipt.nodeId)!;
        assert(ajv.validate(node.outputSchema, receipt.output), ajv.errorsText());
      }
      for (const node of definition.nodes.filter(node => node.kind === "agent" && !node.for_each)) {
        assert(receipts.some(file => file.startsWith(`nodes/${node.id}/`)), `Missing receipt for ${node.id}`);
      }
      for (const node of definition.nodes.filter(node => node.for_each)) {
        const outputs = state.nodes[node.id].output as unknown[];
        const itemReceipts = await Promise.all(receipts.filter(file => file.startsWith(`nodes/${node.id}/`)).map(file => this.json<AgentCompletionReceipt>(run, file)));
        assert.equal(itemReceipts.length, outputs.length, `Receipt count for ${node.id}`);
        for (const receipt of itemReceipts) assert.deepEqual(receipt.output, outputs[receipt.iteration - 1]);
      }
    }
    return state;
  }
  async fixture(name: string, source: string) {
    const path = resolve(this.root, name);
    await writeFile(path, source);
    return path;
  }
  async stop() {
    await this.connection?.close();
    for (const child of this.children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise<void>(done => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => { clearTimeout(timer); done(); });
        child.kill("SIGTERM");
      });
    }
  }
}
