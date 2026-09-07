import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import type { AgentCompletionReceipt, AgentRecoveryRequest } from "../../src/contracts";
import { sha256Json } from "../../src/completion-receipt";
import { Harness, until } from "./harness";

// A controlled external provider CLI: the real Activity adapter must actually
// issue exec/resume and propagate the observed session into committed receipts.
// It intentionally does not emulate an LLM or assert provider task quality.
const provider = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const prompt = args.at(-1);
const input = JSON.parse(prompt.split("RESOLVED INPUTS\\n").at(-1));
const outputPath = args[args.indexOf("--output-last-message") + 1];
const resumed = args.includes("resume");
const sessionId = resumed ? args.at(-2) : crypto.randomUUID();
const nodeId = prompt.match(/workflow node ([^ ]+)/)[1];
const failed = input.fail_on_resume && resumed && !prompt.includes("RECOVERY CONTEXT") && input.round === 1;
fs.appendFileSync(process.env.STEWARD_SESSION_TEST_LOG, JSON.stringify({nodeId, role: input.role, round: input.round + 1, resumed, sessionId, failed, omittedSession: Boolean(input.omit_session), queueIndex: input.__queue_index}) + "\\n");
if (!input.omit_session) console.log(JSON.stringify({type: "thread.started", thread_id: sessionId}));
if (failed) { console.error("network connection lost during resumed turn"); process.exit(1); }
fs.writeFileSync(outputPath, JSON.stringify({success: input.round >= (input.target ?? 2) - 1, round: input.round + 1}));
`;

const source = (policy?: string) => ({
  version: 1, name: "Scope session acceptance", defaults: { max_parallelism: 2, retry: { maximum_attempts: 1 } },
  nodes: {
    repair: {
      kind: "scope",
      loop: {
        max_iterations: 3, ...(policy ? { agent_sessions: policy } : {}),
        initial: { round: 0 }, next: { round: "$output.left.round" },
        until: { all: [
          { path: "left.success", operator: "equals", value: true },
          { path: "right.success", operator: "equals", value: true },
        ] },
      },
      nodes: Object.fromEntries(["left", "right"].map(role => [role, {
        kind: "agent", prompt: "Return the declared fixture.",
        inputs: { role, round: "$state.round" }, outputs: { success: "boolean", round: "number" },
      }])),
      outputs: { left: "$nodes.left.output", right: "$nodes.right.output" },
    },
  },
});

type Call = { nodeId: string; role: string; round: number; resumed: boolean; sessionId: string; failed?: boolean; omittedSession?: boolean; queueIndex?: number };

test("scope session policy reaches the external provider through real Temporal", { timeout: 180_000 }, async t => {
  const bin = await mkdtemp(join(tmpdir(), "steward-session-provider-"));
  const log = join(bin, "invocations.jsonl");
  await writeFile(join(bin, "codex"), provider);
  await chmod(join(bin, "codex"), 0o755);
  const h = new Harness();
  t.after(() => h.stop());
  const workerEnv = { PATH: `${bin}:${process.env.PATH}`, STEWARD_SESSION_TEST_LOG: log };
  await h.start(workerEnv);

  async function execute(policy?: string, definition: object = source(policy), expectedCalls = 4, during?: (run: string) => Promise<void>, expectedReceipts = expectedCalls) {
    await writeFile(log, "");
    const result = await h.cli("start", ["--workflow", await h.fixture(`sessions-${policy ?? "default"}.yaml`, YAML.stringify(definition)), "--mode", "codex"]);
    const run = JSON.parse(result.stdout).runId as string;
    await during?.(run);
    const state = await h.state(run, state => ["completed", "failed"].includes(state.status));
    assert.equal(state.status, "completed", JSON.stringify(state));
    const handle = h.client.workflow.getHandle(`yamlflow-${run}`);
    await until(async () => (await handle.describe()).status.name === "COMPLETED" ? true : undefined, "Temporal closure");
    assert.deepEqual(await handle.result(), state.finalOutputs);
    const calls: Call[] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, expectedCalls, "Every expected provider dispatch must be observable");
    const files = await readdir(join(h.root, "runs", run), { recursive: true });
    const receipts = await Promise.all(files.filter(file => file.endsWith("completion-receipt.json")).map(file => h.json<AgentCompletionReceipt>(run, file)));
    assert.equal(receipts.length, expectedReceipts);
    assert.equal(new Set(receipts.map(receipt => `${receipt.nodeId}:${receipt.iteration}`)).size, expectedReceipts, "Session continuity must not collapse distinct execution identities");
    for (const receipt of receipts) {
      const { receiptSha256, ...body } = receipt;
      assert.equal(receiptSha256, sha256Json(body));
      assert.equal(receipt.provider, "codex");
      assert.equal(receipt.temporalRunId, state.temporalRunId);
      const call = calls.find(call => call.nodeId === receipt.nodeId && !call.failed && (call.queueIndex === undefined || call.queueIndex + 1 === receipt.iteration));
      assert(call);
      assert.equal(receipt.providerSessionId, call.omittedSession ? undefined : call.sessionId);
    }
    return calls;
  }

  await t.test("omitting the policy starts fresh sessions for every iteration", async () => {
    const calls = await execute();
    assert(calls.every(call => !call.resumed));
    assert.equal(new Set(calls.map(call => call.sessionId)).size, 4);
  });

  await t.test("resume preserves each parallel leaf session across iterations without sharing siblings", async () => {
    const calls = await execute("resume");
    for (const role of ["left", "right"]) {
      const first = calls.find(call => call.role === role && call.round === 1)!;
      const second = calls.find(call => call.role === role && call.round === 2)!;
      assert.equal(first.resumed, false);
      assert.equal(second.resumed, true, "The second iteration must invoke codex exec resume");
      assert.equal(second.sessionId, first.sessionId);
      assert.notEqual(second.nodeId, first.nodeId);
    }
    assert.equal(new Set(calls.map(call => call.sessionId)).size, 2, "Parallel siblings must never share sessions");
  });

  await t.test("explicit fresh keeps each iteration independent", async () => {
    const calls = await execute("fresh");
    assert(calls.every(call => !call.resumed));
    assert.equal(new Set(calls.map(call => call.sessionId)).size, 4);
  });

  await t.test("loop-free groups inherit sessions while nested repeats own isolated activation sessions", async () => {
    const agent = (role: string) => ({ kind: "agent", prompt: "Return fixture", inputs: { role, round: "$state.round" }, outputs: { success: "boolean", round: "number" } });
    const nested = (resume: boolean) => ({ kind: "scope", loop: {
      max_iterations: 2, ...(resume ? { agent_sessions: "resume" } : {}),
      initial: { round: 0 }, next: { round: "$output.result.round" },
      until: { path: "result.success", operator: "equals", value: true },
    }, nodes: { leaf: agent(resume ? "inner_resume" : "inner_fresh") }, outputs: { result: "$nodes.leaf.output" } });
    const definition = { version: 1, name: "Session ownership", defaults: { max_parallelism: 4 }, nodes: {
      outer: { kind: "scope", loop: { max_iterations: 2, agent_sessions: "resume", initial: { round: 0 }, next: { round: "$output.driver.round" }, until: { path: "driver.success", operator: "equals", value: true } },
        nodes: {
          driver: agent("driver"),
          group: { kind: "scope", nodes: { leaf: agent("wrapped") }, outputs: { result: "$nodes.leaf.output" } },
          inner_resume: nested(true), inner_fresh: nested(false),
        }, outputs: { driver: "$nodes.driver.output" },
      },
    } };
    const calls = await execute("nested", definition, 12);
    for (const role of ["driver", "wrapped"]) {
      const group = calls.filter(call => call.role === role);
      assert.deepEqual(group.map(call => call.resumed), [false, true]);
      assert.equal(new Set(group.map(call => call.sessionId)).size, 1);
    }
    const fresh = calls.filter(call => call.role === "inner_fresh");
    assert.equal(fresh.length, 4);
    assert(fresh.every(call => !call.resumed), "Default inner policy shadows outer resume");
    assert.equal(new Set(fresh.map(call => call.sessionId)).size, 4);
    const resumed = calls.filter(call => call.role === "inner_resume");
    assert.equal(new Set(resumed.map(call => call.sessionId)).size, 2, "New outer iteration creates a new inner activation");
    for (const iteration of [1, 2]) {
      const activation = resumed.filter(call => call.nodeId.startsWith(`outer~${iteration}.`));
      assert.deepEqual(activation.map(call => call.resumed), [false, true]);
      assert.equal(activation[0].sessionId, activation[1].sessionId);
    }
  });

  await t.test("worker restart at a human gate preserves accepted session affinity without rerunning leaves", async () => {
    const definition: any = source("resume");
    definition.nodes.repair.nodes.gate = { kind: "human", needs: ["left", "right"], question: "Continue?" };
    const calls = await execute("restart", definition, 4, async run => {
      const first = await h.state(run, state => Object.values(state.nodes).some(node => node.humanRequest?.status === "waiting"));
      const request = Object.values(first.nodes).find(node => node.humanRequest?.status === "waiting")!.humanRequest!;
      const worker = h.children.pop()!;
      await new Promise<void>(resolve => { worker.once("exit", () => resolve()); worker.kill("SIGKILL"); });
      const env = h.env;
      h.env = { ...env, ...workerEnv };
      h.launch(process.execPath, ["--import", "tsx", "src/worker.ts"], "worker-restarted");
      h.env = env;
      const handle = h.client.workflow.getHandle(`yamlflow-${run}`);
      await handle.executeUpdate("submitHumanInput", { args: [{ requestId: request.requestId, answer: "continue" }] });
      const second = await h.state(run, state => Object.values(state.nodes).some(node => node.humanRequest?.status === "waiting" && node.humanRequest.requestId !== request.requestId));
      assert.equal(second.temporalRunId, first.temporalRunId);
      const next = Object.values(second.nodes).find(node => node.humanRequest?.status === "waiting" && node.humanRequest.requestId !== request.requestId)!.humanRequest!;
      await handle.executeUpdate("submitHumanInput", { args: [{ requestId: next.requestId, answer: "continue" }] });
    });
    for (const role of ["left", "right"]) {
      const group = calls.filter(call => call.role === role);
      assert.deepEqual(group.map(call => call.resumed), [false, true]);
      assert.equal(group[0].sessionId, group[1].sessionId);
    }
  });

  await t.test("failed resume waits for recovery and fresh recovery replaces the next iteration session", async () => {
    const definition: any = source("resume");
    for (const role of ["left", "right"]) definition.nodes.repair.nodes[role].inputs.target = 3;
    definition.nodes.repair.nodes.left.inputs.fail_on_resume = true;
    const calls = await execute("recovery", definition, 7, async run => {
      const waiting = await h.state(run, state => state.status === "waiting_for_recovery");
      const request = Object.values(waiting.nodes).flatMap(node => node.recoveryRequests ?? []).find(request => request.status === "waiting") as AgentRecoveryRequest;
      assert(request);
      assert.equal(request.canResumeSession, true);
      const observed: Call[] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(observed.filter(call => call.role === "left").length, 2, "No silent fresh fallback after failed resume");
      await h.client.workflow.getHandle(`yamlflow-${run}`).executeUpdate("submitAgentRecovery", { args: [{ requestId: request.requestId, action: "retry_fresh_session" }] });
    }, 6);
    const left = calls.filter(call => call.role === "left");
    assert.deepEqual(left.map(call => call.resumed), [false, true, false, true]);
    assert.equal(left[0].sessionId, left[1].sessionId);
    assert.notEqual(left[2].sessionId, left[1].sessionId);
    assert.equal(left[3].sessionId, left[2].sessionId, "The successful fresh recovery becomes the new affinity");
  });

  await t.test("mapped leaves retain separate position sessions across scope iterations", async () => {
    const definition: any = source("resume");
    definition.nodes.repair.inputs = { items: ["same", "same"] };
    definition.nodes.repair.nodes.left.for_each = { items: "$input.items", as: "item", max_parallelism: 2 };
    definition.nodes.repair.loop.next = { round: "$output.right.round" };
    definition.nodes.repair.loop.until = { path: "right.success", operator: "equals", value: true };
    const calls = await execute("mapped", definition, 6);
    const mapped = calls.filter(call => call.role === "left");
    assert.equal(mapped.length, 4);
    for (const position of [0, 1]) {
      const item = mapped.filter(call => call.queueIndex === position);
      assert.deepEqual(item.map(call => call.resumed), [false, true]);
      assert.equal(item[0].sessionId, item[1].sessionId);
    }
    assert.equal(new Set(mapped.map(call => call.sessionId)).size, 2, "Equal item values cannot collapse positional session identity");
  });

  await t.test("missing provider session IDs explicitly fall back to fresh turns", async () => {
    const definition: any = source("resume");
    for (const role of ["left", "right"]) definition.nodes.repair.nodes[role].inputs.omit_session = true;
    let runId = "";
    const calls = await execute("missing", definition, 4, async run => { runId = run; });
    assert(calls.every(call => !call.resumed));
    assert.equal(new Set(calls.map(call => call.sessionId)).size, 4);
    const events = await h.events(runId);
    for (const role of ["left", "right"]) {
      const second = calls.find(call => call.role === role && call.round === 2)!;
      assert(events.some(event => event.type === "node.session" && event.nodeId === second.nodeId && (event.data as any)?.reason === "no_recorded_session"), "Fresh fallback must be explicit in persisted events");
    }
  });
});
