import { Client, Connection } from "@temporalio/client";
import { randomBytes } from "node:crypto";
import type {
  AgentProvider,
  AgentRecoveryCommand,
  AgentRecoveryReceipt,
  HumanAnswerCommand,
  HumanAnswerReceipt,
  JsonValue,
  WorkflowDefinition,
  WorkflowRunInput,
} from "./contracts";
import { TASK_QUEUE, TEMPORAL_ADDRESS } from "./config";

export interface StartOptions {
  definition: WorkflowDefinition;
  initialInput: JsonValue;
  mode: AgentProvider;
  delayMs?: number;
  runId?: string;
}

export function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

export async function startWorkflow(options: StartOptions): Promise<{ runId: string; workflowId: string }> {
  const runId = options.runId ?? createRunId();
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: "default" });
  const input: WorkflowRunInput = {
    runId,
    definition: options.definition,
    initialInput: options.initialInput,
    mode: options.mode,
    delayMs: options.delayMs,
  };
  const workflowId = `yamlflow-${runId}`;
  await client.workflow.start("yamlAgentWorkflowV2", {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
  await connection.close();
  return { runId, workflowId };
}

export async function submitAgentRecovery(
  runId: string,
  command: AgentRecoveryCommand,
): Promise<AgentRecoveryReceipt> {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  try {
    const client = new Client({ connection, namespace: "default" });
    return await client.workflow
      .getHandle(`yamlflow-${runId}`)
      .executeUpdate<AgentRecoveryReceipt, [AgentRecoveryCommand]>("submitAgentRecovery", { args: [command] });
  } finally {
    await connection.close();
  }
}

export async function submitHumanAnswer(
  runId: string,
  command: HumanAnswerCommand,
): Promise<HumanAnswerReceipt> {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  try {
    const client = new Client({ connection, namespace: "default" });
    return await client.workflow
      .getHandle(`yamlflow-${runId}`)
      .executeUpdate<HumanAnswerReceipt, [HumanAnswerCommand]>("submitHumanInput", { args: [command] });
  } finally {
    await connection.close();
  }
}
