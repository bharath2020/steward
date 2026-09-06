import assert from "node:assert/strict";
import test from "node:test";
import { extractHumanAgentMessage, humanizeAgentText } from "../src/agent-stream";

test("extracts only completed Codex agent messages", () => {
  assert.deepEqual(
    extractHumanAgentMessage(JSON.stringify({
      type: "item.completed",
      item: { id: "item-7", type: "agent_message", text: "The evidence supports a focused launch." },
    })),
    { id: "item-7", text: "The evidence supports a focused launch." },
  );
  assert.equal(extractHumanAgentMessage(JSON.stringify({
    type: "item.completed",
    item: { id: "item-8", type: "command_execution", command: "pwd" },
  })), undefined);
  assert.equal(extractHumanAgentMessage(JSON.stringify({
    type: "item.started",
    item: { id: "item-9", type: "reasoning", text: "internal" },
  })), undefined);
  assert.equal(extractHumanAgentMessage("provider stderr"), undefined);
});

test("turns structured final output into readable text", () => {
  assert.equal(
    humanizeAgentText(JSON.stringify({ decision: "Proceed", risks: ["Timing", "Scope"], confidence: 0.82 })),
    "Decision: Proceed\nRisks: Timing; Scope\nConfidence: 0.82",
  );
});
