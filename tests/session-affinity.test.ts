import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@temporalio/activity";
import { parseWorkflow } from "../src/definition";
import type { AgentExecutionInput, AgentHeartbeatCheckpoint, ProviderSessionAffinity } from "../src/contracts";

test("opt-in session identity is checked at the Activity boundary", async t => {
  const root = await mkdtemp(join(tmpdir(), "steward-session-affinity-"));
  const priorEnvironment = { path: process.env.PATH, runtime: process.env.YAMLFLOW_RUNTIME_DIR, log: process.env.STEWARD_AFFINITY_LOG };
  process.env.YAMLFLOW_RUNTIME_DIR = root;
  process.env.PATH = `${root}:${process.env.PATH}`;
  process.env.STEWARD_AFFINITY_LOG = join(root, "calls.jsonl");
  await writeFile(join(root, "codex"), `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.STEWARD_AFFINITY_LOG, JSON.stringify(args)+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:args.includes('resume')?args.at(-2):'fresh-session'}));
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({success:true}));
`);
  await chmod(join(root, "codex"), 0o755);
  const { executeAgent } = await import("../src/activities");
  const originalCurrent = Context.current;
  t.after(() => {
    Context.current = originalCurrent;
    for (const [key, value] of Object.entries({ PATH: priorEnvironment.path, YAMLFLOW_RUNTIME_DIR: priorEnvironment.runtime, STEWARD_AFFINITY_LOG: priorEnvironment.log })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const definition = parseWorkflow(`version: 1\nname: Session identity test\nnodes:\n  leaf:\n    prompt: Return fixture\n    outputs: {success: boolean}\n`);
  const workspace = await realpath(process.cwd());
  let count = 0;
  const affinity = (sessionId = "prior-session"): ProviderSessionAffinity => ({ provider: "codex", canonicalWorkspace: workspace, sessionId });
  const fixture = (sessionAffinity = affinity()) => {
    const execution: AgentExecutionInput = {
      runId: `affinity-${++count}`, temporalRunId: "temporal-test", definition, node: definition.nodes[0], input: {}, mode: "codex", wave: 1,
      iteration: 1, recoveryCycle: 0, receiptToken: "dispatch", captureSessionAffinity: true, providerSessionId: sessionAffinity.sessionId, sessionAffinity,
    };
    const heartbeats: AgentHeartbeatCheckpoint[] = [];
    const setContext = (checkpoint?: AgentHeartbeatCheckpoint) => {
      Context.current = () => ({
        info: { attempt: checkpoint ? 2 : 1, heartbeatDetails: checkpoint ? [checkpoint] : [] },
        heartbeat: (value: AgentHeartbeatCheckpoint) => heartbeats.push(value),
        cancellationSignal: new AbortController().signal, cancelled: new Promise(() => {}),
      } as unknown as Context);
    };
    setContext();
    return { execution, heartbeats, setContext };
  };
  const calls = async () => readFile(join(root, "calls.jsonl"), "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
  for (const kind of ["workspace", "provider", "session"] as const) {
    await t.test(`reject mismatched ${kind} identity without invoking provider or rebinding heartbeat`, async () => {
      const f = fixture();
      if (kind === "workspace") f.execution.sessionAffinity!.canonicalWorkspace = `${workspace}/different`;
      if (kind === "provider") f.execution.sessionAffinity!.provider = "simulated";
      if (kind === "session") f.execution.providerSessionId = "different-session";
      const before = await calls();
      await assert.rejects(executeAgent(f.execution), (error: any) => error.details?.[0]?.kind === "integrity_error");
      assert.equal(await calls(), before);
      assert.equal(f.heartbeats.length, 0, "Reject invalid identity before publishing a resume checkpoint");
    });
  }
  await t.test("latest matching dispatch checkpoint takes precedence over prior iteration seed", async () => {
    const f = fixture();
    f.setContext({
      schema: "agent-heartbeat.v1", runId: f.execution.runId, temporalRunId: f.execution.temporalRunId, nodeId: "leaf", provider: "codex",
      iteration: 1, recoveryCycle: 0, attempt: 1, phase: "working", startedAt: new Date(0).toISOString(),
      providerSessionId: "checkpoint-session", sessionAffinity: affinity("checkpoint-session"),
    });
    const result = await executeAgent(f.execution);
    assert.equal(result.providerSessionId, "checkpoint-session");
    assert.deepEqual(result.sessionAffinity, affinity("checkpoint-session"));
    const invocation = JSON.parse((await calls()).trim().split("\n").at(-1)!);
    assert(invocation.includes("resume"));
    assert.equal(invocation.at(-2), "checkpoint-session");
  });
  await t.test("accepted receipt recovery restores the bound session without another provider call", async () => {
    const f = fixture();
    const accepted = await executeAgent(f.execution);
    const before = await calls();
    f.setContext();
    const recovered = await executeAgent(f.execution);
    assert.equal(recovered.recoveredFromReceipt, true);
    assert.deepEqual(recovered.sessionAffinity, accepted.sessionAffinity);
    assert.equal(await calls(), before);
  });

});
