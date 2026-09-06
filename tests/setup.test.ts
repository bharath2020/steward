import assert from "node:assert/strict";
import test from "node:test";
import { setupOptions } from "../src/cli/setup";
import { examples, validateExamples } from "../src/cli/examples";

test("all shipped examples have valid definitions, demo outputs, prompt files, and input bindings", async () => {
  await validateExamples();
});

test("setup defaults to reconnecting and requires an explicit new-run flag", () => {
  assert.deepEqual(setupOptions([]), { example: examples.questions, newRun: false, check: false, noOpen: false });
  assert.deepEqual(setupOptions(["--example", "file", "--new-run", "--no-open"]), {
    example: examples.file, newRun: true, noOpen: true, check: false,
  });
  for (const args of [["--example"], ["--example", "../private.yaml"], ["--mode", "codex"], ["--unknown"]]) {
    assert.throws(() => setupOptions(args));
  }
});
