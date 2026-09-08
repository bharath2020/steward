export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RunMode = AgentProvider | "workflow";

export type AgentProvider = "simulated" | "codex";
export type NodeKind = "agent" | "human" | "scope";
export type OutputType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "string[]"
  | "number[]"
  | "boolean[]"
  | "object[]";
export type LoopOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "contains"
  | "truthy";

export interface WorkflowGroup {
  id: string;
  title: string;
  description: string;
  max_parallelism?: number;
}

export type LoopPredicate =
  | { path: string; operator: LoopOperator; value?: JsonValue }
  | { all: LoopPredicate[] }
  | { any: LoopPredicate[] }
  | { not: LoopPredicate };

export interface NodeLoop {
  max_iterations: number;
  carry_as: string;
  on_exhaustion: "fail" | "accept_last";
  until: LoopPredicate;
  predicate_version?: 2;
  agent_sessions?: "fresh" | "resume";
  initial?: Record<string, JsonValue>;
  next?: Record<string, JsonValue>;
}

export interface NodeForEach {
  items: string;
  as: string;
  max_parallelism: number;
}

export interface RetryPolicy {
  maximum_attempts: number;
}

export interface WorkflowDefaults {
  provider: AgentProvider;
  max_parallelism: number;
  retry: RetryPolicy;
  delay_ms: number;
}

export interface WorkflowNode {
  id: string;
  title: string;
  kind: NodeKind;
  agent: AgentProvider;
  group?: string;
  needs: string[];
  prompt: string;
  /** Author's file reference and hash of the snapshotted UTF-8 content. */
  promptSource?: { path: string; sha256: string };
  inputs: Record<string, JsonValue>;
  outputs: Record<string, OutputType>;
  outputSchema: JsonSchema;
  nodes?: WorkflowNode[];
  exports?: Record<string, JsonValue>;
  demo_output?: JsonValue;
  demo_outputs?: JsonValue[];
  delay_ms?: number;
  loop?: NodeLoop;
  for_each?: NodeForEach;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, JsonValue>>;
  required: string[];
  additionalProperties: false;
}

export interface WorkflowDefinition {
  version: 1;
  name: string;
  description: string;
  sourcePath: string;
  definitionHash: string;
  defaults: WorkflowDefaults;
  groups: WorkflowGroup[];
  nodes: WorkflowNode[];
}

export interface RepositoryExecution {
  workingDirectory: string;
  sandbox: "workspace-write";
}

export interface WorkflowRunInput {
  /** Absent only on histories created before repository-bound execution. */
  execution?: RepositoryExecution;
  runId: string;
  definition: WorkflowDefinition;
  initialInput: JsonValue;
  mode: RunMode;
  delayMs?: number;
}

export type AgentFailureKind =
  | "network"
  | "context_exhausted"
  | "output_limit"
  | "invalid_output"
  | "provider_error"
  | "integrity_error"
  | "unknown";

export interface ProviderSessionAffinity {
  provider: AgentProvider;
  canonicalWorkspace: string;
  sessionId: string;
}

export interface AgentFailureSummary {
  schema: "agent-failure.v1";
  kind: AgentFailureKind;
  message: string;
  providerSessionId?: string;
  sessionAffinity?: ProviderSessionAffinity;
}

export type AgentRecoveryAction = "retry_same_session" | "retry_fresh_session" | "abort_workflow";

export interface AgentRecoveryCommand {
  requestId: string;
  action: AgentRecoveryAction;
}

export interface AgentRecoveryRequest {
  requestId: string;
  nodeId: string;
  iteration: number;
  recoveryCycle: number;
  status: "waiting" | "received";
  failure: AgentFailureSummary;
  canResumeSession: boolean;
  requestedAt: string;
  receivedAt?: string;
  command?: AgentRecoveryCommand;
}

export interface AgentRecoveryReceipt {
  requestId: string;
  action: AgentRecoveryAction;
  accepted: true;
  acceptedAt: string;
}

export interface HumanInputRequest {
  requestId: string;
  nodeId: string;
  question: string;
  status: "waiting" | "received";
  requestedAt: string;
  receivedAt?: string;
  answer?: string;
}

export interface HumanAnswerCommand {
  requestId: string;
  answer: string;
}

export interface HumanAnswerReceipt {
  requestId: string;
  accepted: true;
  acceptedAt: string;
}

export type NodeStatus = "pending" | "running" | "awaiting_input" | "awaiting_recovery" | "completed" | "failed";
export type RunStatus = "running" | "waiting_for_human" | "waiting_for_recovery" | "completed" | "failed";

export interface TimelineEvent {
  id: string;
  seq: number;
  at: string;
  type: string;
  runId: string;
  nodeId?: string;
  wave?: number;
  message: string;
  data?: JsonValue;
}

export interface AgentMessage {
  id: string;
  seq: number;
  at: string;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  provider: AgentProvider;
  text: string;
}

export type AgentMessageInput = Omit<AgentMessage, "seq" | "at">;

export interface NodeRunState {
  id: string;
  title: string;
  agent: AgentProvider | "human" | "scope";
  definitionId?: string;
  parentId?: string;
  loopOutcome?: "condition_met" | "exhausted_accepted" | "exhausted_failed";
  group?: string;
  status: NodeStatus;
  phase: string;
  needs: string[];
  startedAt?: string;
  completedAt?: string;
  attempt?: number;
  iteration?: number;
  iterationCount?: number;
  completedItems?: number;
  totalItems?: number;
  durationMs?: number;
  input?: JsonValue;
  output?: JsonValue;
  error?: string;
  recoveryRequests?: AgentRecoveryRequest[];
  humanRequest?: HumanInputRequest;
}

export interface RunState {
  /** Absent only on histories created before repository-bound execution. */
  execution?: RepositoryExecution;
  runId: string;
  temporalRunId: string;
  workflowName: string;
  definitionHash: string;
  sourcePath: string;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  currentWave: number;
  completedCount: number;
  totalCount: number;
  finalOutputs?: Record<string, JsonValue>;
  failure?: string;
  nodes: Record<string, NodeRunState>;
}

export interface TransitionInput {
  /** Absent only on histories created before repository-bound execution. */
  execution?: RepositoryExecution;
  id: string;
  runId: string;
  temporalRunId: string;
  definition: WorkflowDefinition;
  mode: RunMode;
  initialInput: JsonValue;
  type: string;
  nodeId?: string;
  wave?: number;
  message: string;
  data?: JsonValue;
}

export interface AgentExecutionInput {
  /** Absent only on histories created before repository-bound execution. */
  execution?: RepositoryExecution;
  runId: string;
  temporalRunId: string;
  definition: WorkflowDefinition;
  node: WorkflowNode;
  input: Record<string, JsonValue>;
  mode: AgentProvider;
  delayMs?: number;
  wave: number;
  iteration: number;
  simulationIteration?: number;
  captureSessionAffinity?: true;
  queueItem?: {
    index: number;
    count: number;
  };
  recoveryCycle: number;
  receiptToken: string;
  providerSessionId?: string;
  sessionAffinity?: ProviderSessionAffinity;
  recovery?: {
    action: Exclude<AgentRecoveryAction, "abort_workflow">;
    failureKind: AgentFailureKind;
    message: string;
  };
}

export interface AgentExecutionResult {
  output: JsonValue;
  providerSessionId?: string;
  sessionAffinity?: ProviderSessionAffinity;
  recoveredFromReceipt: boolean;
  receiptSha256: string;
}

export interface AgentHeartbeatCheckpoint {
  schema: "agent-heartbeat.v1";
  runId: string;
  temporalRunId: string;
  nodeId: string;
  provider: AgentProvider;
  iteration: number;
  recoveryCycle: number;
  attempt: number;
  phase: "starting" | "working";
  startedAt: string;
  lastProviderEventAt?: string;
  providerSessionId?: string;
  sessionAffinity?: ProviderSessionAffinity;
  processId?: number;
}

export interface AgentCompletionReceipt {
  /** Absent only on histories created before repository-bound execution. */
  execution?: RepositoryExecution;
  schema: "agent-completion-receipt.v1";
  receiptId: string;
  runId: string;
  temporalRunId: string;
  nodeId: string;
  iteration: number;
  recoveryCycle: number;
  provider: AgentProvider;
  receiptToken: string;
  promptSha256: string;
  outputSchemaSha256: string;
  outputSha256: string;
  completedAt: string;
  output: JsonValue;
  providerSessionId?: string;
  sessionAffinity?: ProviderSessionAffinity;
  receiptSha256: string;
}
