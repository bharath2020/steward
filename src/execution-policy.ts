import type {
  AgentFailureSummary,
  AgentHeartbeatCheckpoint,
  AgentProvider,
} from "./contracts";

export const AGENT_HEARTBEAT_TIMEOUT = "10 seconds";
export const AGENT_HEARTBEAT_INTERVAL_MS = 4_000;
export const MAX_PROVIDER_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_STDERR_TAIL_BYTES = 32 * 1024;
export const PUBLIC_AGENT_FAILURE = "The agent turn ended unexpectedly. Temporal will retry it according to policy.";

const failureMessages: Record<AgentFailureSummary["kind"], string> = {
  network: "The provider connection ended before a valid handoff was returned.",
  context_exhausted: "The provider session exhausted its context window and cannot be resumed safely.",
  output_limit: "The provider emitted more data than the structured-response safety limit.",
  invalid_output: "The provider finished without a valid structured handoff.",
  provider_error: "The provider ended the turn with an error.",
  integrity_error: "The durable completion evidence failed identity or hash validation.",
  unknown: "The agent turn failed after its automatic recovery attempts.",
};

function rawErrorMessage(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value ?? "");
}

export function classifyAgentFailure(value: unknown, providerSessionId?: string): AgentFailureSummary {
  const message = rawErrorMessage(value);
  const kind: AgentFailureSummary["kind"] = /receipt|identity|hash validation|completion evidence/i.test(message)
    ? "integrity_error"
    : /context.window|context_window_exceeded|ran out of room|context exhausted/i.test(message)
      ? "context_exhausted"
      : /output exceeded|output.limit|more data than.*limit/i.test(message)
        ? "output_limit"
        : /output schema|structured handoff|invalid json|unexpected end of json/i.test(message)
          ? "invalid_output"
          : /\bECONN|\bENET|\bEHOST|\bENOTFOUND|\bETIMEDOUT|network|socket|connection (?:closed|reset|lost)|fetch failed/i.test(message)
            ? "network"
            : message && !message.includes(PUBLIC_AGENT_FAILURE)
              ? "provider_error"
              : "unknown";
  return {
    schema: "agent-failure.v1",
    kind,
    message: failureMessages[kind],
    ...(providerSessionId ? { providerSessionId } : {}),
  };
}

export function providerFailureMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Record<string, any>;
  if (event.type !== "turn.failed" && event.type !== "error") return undefined;
  if (typeof event.error?.message === "string") return event.error.message;
  if (typeof event.message === "string") return event.message;
  if (typeof event.error === "string") return event.error;
  return "Codex ended the turn with an error.";
}

export function codexExecutionArgs(input: {
  prompt: string;
  schemaPath: string;
  outputPath: string;
  cwd: string;
  priorSessionId?: string;
}): string[] {
  const common = [
    "--json",
    "--skip-git-repo-check",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath,
  ];
  return input.priorSessionId
    ? [
        "--sandbox",
        "read-only",
        "exec",
        "resume",
        ...common,
        input.priorSessionId,
        input.prompt,
      ]
    : [
        "exec",
        "--sandbox",
        "read-only",
        ...common,
        "--cd",
        input.cwd,
        input.prompt,
      ];
}

export function readHeartbeatCheckpoint(details: unknown): AgentHeartbeatCheckpoint | undefined {
  const candidate = Array.isArray(details) ? details.at(-1) : details;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = candidate as Partial<AgentHeartbeatCheckpoint>;
  if (
    value.schema !== "agent-heartbeat.v1"
    || typeof value.runId !== "string"
    || typeof value.temporalRunId !== "string"
    || typeof value.nodeId !== "string"
    || (value.provider !== "codex" && value.provider !== "simulated")
    || typeof value.iteration !== "number"
    || typeof value.recoveryCycle !== "number"
    || typeof value.attempt !== "number"
    || (value.phase !== "starting" && value.phase !== "working")
    || typeof value.startedAt !== "string"
  ) return undefined;
  return value as AgentHeartbeatCheckpoint;
}

export function matchingHeartbeatCheckpoint(
  details: unknown,
  identity: {
    runId: string;
    temporalRunId: string;
    nodeId: string;
    provider: AgentProvider;
    iteration: number;
    recoveryCycle: number;
  },
): AgentHeartbeatCheckpoint | undefined {
  const checkpoint = readHeartbeatCheckpoint(details);
  return checkpoint
    && checkpoint.runId === identity.runId
    && checkpoint.temporalRunId === identity.temporalRunId
    && checkpoint.nodeId === identity.nodeId
    && checkpoint.provider === identity.provider
    && checkpoint.iteration === identity.iteration
    && checkpoint.recoveryCycle === identity.recoveryCycle
    ? checkpoint
    : undefined;
}
