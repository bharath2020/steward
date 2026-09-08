import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { randomBytes } from "node:crypto";
import type {
  RunMode,
  AgentRecoveryCommand,
  AgentRecoveryReceipt,
  HumanAnswerCommand,
  HumanAnswerReceipt,
  JsonValue,
  WorkflowDefinition,
  WorkflowRunInput,
} from "./contracts";
import { TASK_QUEUE, TEMPORAL_ADDRESS } from "./config";
import { resolveWorkingDirectory } from "./repository-workspace";

export interface StartOptions {
  workingDirectory: string;
  definition: WorkflowDefinition;
  initialInput: JsonValue;
  mode: RunMode;
  delayMs?: number;
  runId?: string;
  idempotent?: boolean;
}

export function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

export async function startWorkflow(options: StartOptions): Promise<{ runId: string; workflowId: string }> {
  const workingDirectory = await resolveWorkingDirectory(options.workingDirectory);
  const runId = options.runId ?? createRunId();
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: "default" });
  const input: WorkflowRunInput = {
    runId,
    execution: { workingDirectory, sandbox: "workspace-write" },
    definition: options.definition,
    initialInput: options.initialInput,
    mode: options.mode,
    delayMs: options.delayMs,
  };
  const workflowId = `yamlflow-${runId}`;
  try {
    // The saved intent owns the identity, including retries after completion.
    await client.workflow.start("stewardWorkflow", {
      workflowId,
      ...(options.idempotent ? { workflowIdReusePolicy: "REJECT_DUPLICATE" as const } : {}),
      taskQueue: TASK_QUEUE,
      args: [input],
    });
  } catch (error) {
    if (!options.idempotent || !(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  } finally {
    await connection.close();
  }
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
