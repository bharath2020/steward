import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("CLI modules can be imported without issuing commands or starting local services", () => {
  const modules = ["../src/cli/start", "../src/cli/answer", "../src/cli/launcher", "../src/cli/setup"].map(
    (module) => require.resolve(module),
  );
  const script = `
    const assert = require("node:assert/strict");
    const client = require(${JSON.stringify(require.resolve("../src/client"))});
    require(${JSON.stringify(require.resolve("../src/definition"))});
    require(${JSON.stringify(require.resolve("../src/config"))});
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const forbidden = () => { throw new Error("CLI import attempted runtime work"); };
    client.startWorkflow = forbidden;
    client.submitHumanAnswer = forbidden;
    require("node:fs").mkdirSync = forbidden;
    require("node:fs").createWriteStream = forbidden;
    require("node:child_process").spawn = forbidden;
    require("node:net").createConnection = forbidden;
    globalThis.fetch = forbidden;
    for (const module of ${JSON.stringify(modules)}) {
      assert.equal(typeof require(module).main, "function");
    }
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "importing a CLI module must not produce command output");
});
