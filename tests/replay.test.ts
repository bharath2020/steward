import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { temporal } from "@temporalio/proto";
import { Runtime, Worker } from "@temporalio/worker";

// pre-scope-predicate-history was produced by git b8fcaffa123b478aaeb5c5ffb53d5a598c6c3d5f,
// with a legacy missing-path not_equals predicate that completed under V1.
// pre-outcome-loop-history has two iterations and predates the outcome patch marker.
Runtime.install({ telemetryOptions: { logging: { filter: "WARN" } } });
for (const fixture of ["pre-scope-predicate-history.json", "pre-outcome-loop-history.json"]) {
  test(`current interpreter replays supported ${fixture}`, { timeout: 60_000 }, async () => {
    const history = JSON.parse(await readFile(join(__dirname, "fixtures", fixture), "utf8"));
    await Worker.runReplayHistory({ workflowsPath: require.resolve("../src/workflows") }, temporal.api.history.v1.History.fromObject(history));
  });
}
