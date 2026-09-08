import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { temporal } from "@temporalio/proto";
import { Runtime, Worker } from "@temporalio/worker";

// pre-scope-predicate-history was produced by git b8fcaffa123b478aaeb5c5ffb53d5a598c6c3d5f,
// with a legacy missing-path not_equals predicate that completed under V1.
// pre-outcome-loop-history has two iterations and predates the outcome patch marker.
Runtime.install({ telemetryOptions: { logging: { filter: "WARN" } } });
// Repository history includes a worker restart at a human gate, a failed provider
// attempt and a same-session retry, captured by the repository execution E2E test.
for (const fixture of ["pre-scope-predicate-history.json", "pre-outcome-loop-history.json", "repository-execution-history.json"]) {
  test(`current interpreter replays supported ${fixture}`, { timeout: 60_000 }, async () => {
    const history = JSON.parse(await readFile(join(__dirname, "fixtures", fixture), "utf8"));
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, temporal.api.history.v1.History.fromObject(history));
  });
}
