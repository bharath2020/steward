import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import YAML from "yaml";
import { Harness, until } from "./harness";
import type { HumanInputRequest } from "../../src/contracts";
import { sha256Json } from "../../src/completion-receipt";

// This test crosses worker process boundaries, retaining the same Temporal
// execution and checking accepted evidence instead of counting console messages.
test("nested human gates survive worker restart with iteration-qualified requests and committed answers", { timeout: 120_000 }, async t => {
  const h = new Harness();
  t.after(() => h.stop());
  await h.start();
  const source = {
    version: 1, name: "Human scope recovery", defaults: { max_parallelism: 1 },
    nodes: {
      repeat: {
        kind: "scope", loop: { max_iterations: 2, until: { path: "answer", operator: "equals", value: "approve" } },
        nodes: {
          draft: { kind: "agent", prompt: "Return fixture", outputs: { text: "string" }, demo_output: { text: "Review this draft" } },
          group: {
            kind: "scope", needs: ["draft"], inputs: { question: "$nodes.draft.output.text" },
            nodes: { gate: { kind: "human", question: "$input.question" } },
            outputs: { answer: "$nodes.gate.output.answer" },
          },
        }, outputs: { answer: "$nodes.group.output.answer" },
      },
      after: { kind: "agent", needs: ["repeat"], prompt: "Return fixture", outputs: { done: "boolean" }, demo_output: { done: true } },
    },
  };
  const run = await h.run(await h.fixture("human-scope.yaml", YAML.stringify(source)));
  const waiting = async (exclude?: string) => {
    const state = await h.state(run, state => Object.values(state.nodes).some(node => node.humanRequest?.status === "waiting" && node.humanRequest.requestId !== exclude));
    return { state, request: Object.values(state.nodes).find(node => node.humanRequest?.status === "waiting" && node.humanRequest.requestId !== exclude)!.humanRequest as HumanInputRequest };
  };
  const first = await waiting();
  const worker = h.children.pop()!;
  await new Promise<void>(resolve => { worker.once("exit", () => resolve()); worker.kill("SIGKILL"); });
  h.launch(process.execPath, ["--import", "tsx", "src/worker.ts"], "worker-restarted");
  const handle = h.client.workflow.getHandle(`yamlflow-${run}`);
  await handle.executeUpdate("submitHumanInput", { args: [{ requestId: first.request.requestId, answer: "revise" }] });
  const second = await waiting(first.request.requestId);
  assert.notEqual(second.request.requestId, first.request.requestId);
  assert.equal(second.state.temporalRunId, first.state.temporalRunId);
  await assert.rejects(handle.executeUpdate("submitHumanInput", { args: [{ requestId: first.request.requestId, answer: "approve" }] }));
  await handle.executeUpdate("submitHumanInput", { args: [{ requestId: second.request.requestId, answer: "approve" }] });
  const state = await h.state(run, state => state.status === "completed" || state.status === "failed");
  assert.equal(state.status, "completed", JSON.stringify(state));
  await until(async () => (await handle.describe()).status.name === "COMPLETED" ? true : undefined, "Temporal closure");
  assert.deepEqual(await handle.result(), state.finalOutputs);
  assert.equal(state.nodes.repeat.loopOutcome, "condition_met");
  const events = await h.events(run);
  for (const request of [first.request, second.request]) {
    assert.equal(events.filter(event => event.type === "human.required" && event.nodeId === request.nodeId).length, 1);
    const artifact = await h.json<{ output: object; outputSha256: string; requestId: string }>(run, `nodes/${request.nodeId}/human-output.json`);
    assert.equal(artifact.requestId, request.requestId);
    assert.equal(artifact.outputSha256, sha256Json(artifact.output));
    assert.deepEqual(artifact.output, { answer: request === first.request ? "revise" : "approve" });
  }
  const files = await readdir(`${h.root}/runs/${run}`, { recursive: true });
  assert.equal(files.filter(file => file.endsWith("completion-receipt.json")).length, 3, "Restart must not rerun an accepted draft");
  assert.equal(events.filter(event => event.nodeId === "after" && event.type === "node.completed").length, 1);
  await writeFile(`${h.root}/scope-history.json`, JSON.stringify(await handle.fetchHistory()));
});
