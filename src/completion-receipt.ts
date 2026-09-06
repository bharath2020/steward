import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  AgentCompletionReceipt,
  AgentExecutionInputV2,
  AgentExecutionResult,
  JsonValue,
} from "./contracts";
import { runDirectory, writeJsonArtifact } from "./store";

type ReceiptBody = Omit<AgentCompletionReceipt, "receiptSha256">;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function iterationDirectory(execution: AgentExecutionInputV2): string {
  const nodeDirectory = join(runDirectory(execution.runId), "nodes", execution.node.id);
  return execution.node.loop
    ? join(nodeDirectory, "iterations", String(execution.iteration).padStart(2, "0"))
    : nodeDirectory;
}

function confined(runId: string, target: string): string {
  const root = resolve(runDirectory(runId));
  const resolved = resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error("Completion receipt path escaped the durable run directory.");
  }
  return resolved;
}

export function completionPaths(execution: AgentExecutionInputV2): {
  directory: string;
  outputPath: string;
  loopOutputPath?: string;
  primaryReceiptPath: string;
  mirrorReceiptPath: string;
} {
  const directory = iterationDirectory(execution);
  const nodeDirectory = join(runDirectory(execution.runId), "nodes", execution.node.id);
  return {
    directory: confined(execution.runId, directory),
    outputPath: confined(execution.runId, join(directory, "output.json")),
    ...(execution.node.loop
      ? { loopOutputPath: confined(execution.runId, join(nodeDirectory, "output.json")) }
      : {}),
    primaryReceiptPath: confined(execution.runId, join(directory, "completion-receipt.json")),
    mirrorReceiptPath: confined(
      execution.runId,
      join(runDirectory(execution.runId), "receipts", `${execution.node.id}-iteration-${String(execution.iteration).padStart(2, "0")}.json`),
    ),
  };
}

async function readReceipt(path: string): Promise<AgentCompletionReceipt | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as AgentCompletionReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Completion receipt could not be read: ${String(error)}`);
  }
}

async function writeJsonImmutably(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== serialized) {
      throw new Error("Immutable completion receipt already exists with different contents.");
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function buildCompletionReceipt(input: {
  execution: AgentExecutionInputV2;
  promptSha256: string;
  outputSchemaSha256: string;
  output: JsonValue;
  providerSessionId?: string;
  completedAt: string;
}): AgentCompletionReceipt {
  const outputSha256 = sha256Json(input.output);
  const body: ReceiptBody = {
    schema: "agent-completion-receipt.v1",
    receiptId: `${input.execution.temporalRunId}:${input.execution.node.id}:${input.execution.iteration}:${outputSha256.slice(0, 16)}`,
    runId: input.execution.runId,
    temporalRunId: input.execution.temporalRunId,
    nodeId: input.execution.node.id,
    iteration: input.execution.iteration,
    recoveryCycle: input.execution.recoveryCycle,
    provider: input.execution.mode,
    receiptToken: input.execution.receiptToken,
    promptSha256: input.promptSha256,
    outputSchemaSha256: input.outputSchemaSha256,
    outputSha256,
    completedAt: input.completedAt,
    output: input.output,
    ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
  };
  return { ...body, receiptSha256: sha256Json(body) };
}

export function validateCompletionReceipt(
  receipt: AgentCompletionReceipt,
  expected: {
    execution: AgentExecutionInputV2;
    promptSha256: string;
    outputSchemaSha256: string;
  },
): void {
  if (!receipt || typeof receipt !== "object" || receipt.schema !== "agent-completion-receipt.v1") {
    throw new Error("Unsupported completion receipt.");
  }
  const { receiptSha256, ...body } = receipt;
  if (
    receipt.runId !== expected.execution.runId
    || receipt.temporalRunId !== expected.execution.temporalRunId
    || receipt.nodeId !== expected.execution.node.id
    || receipt.iteration !== expected.execution.iteration
    || receipt.recoveryCycle !== expected.execution.recoveryCycle
    || receipt.provider !== expected.execution.mode
    || receipt.receiptToken !== expected.execution.receiptToken
    || receipt.promptSha256 !== expected.promptSha256
    || receipt.outputSchemaSha256 !== expected.outputSchemaSha256
  ) throw new Error("Completion receipt identity does not match the dispatched agent turn.");
  if (receipt.outputSha256 !== sha256Json(receipt.output)) {
    throw new Error("Completion receipt output hash does not match its embedded output.");
  }
  const expectedId = `${receipt.temporalRunId}:${receipt.nodeId}:${receipt.iteration}:${receipt.outputSha256.slice(0, 16)}`;
  if (receipt.receiptId !== expectedId) throw new Error("Completion receipt ID is invalid.");
  if (receiptSha256 !== sha256Json(body)) throw new Error("Completion receipt hash validation failed.");
}

export async function recoverCompletionReceipt(input: {
  execution: AgentExecutionInputV2;
  promptSha256: string;
  outputSchemaSha256: string;
}): Promise<AgentExecutionResult | undefined> {
  const paths = completionPaths(input.execution);
  const [primary, mirror] = await Promise.all([
    readReceipt(paths.primaryReceiptPath),
    readReceipt(paths.mirrorReceiptPath),
  ]);
  if (!primary && !mirror) return undefined;
  if (primary) validateCompletionReceipt(primary, input);
  if (mirror) validateCompletionReceipt(mirror, input);
  if (primary && mirror && primary.receiptSha256 !== mirror.receiptSha256) {
    throw new Error("Completion receipt copies disagree; refusing to choose a result.");
  }
  const receipt = primary ?? mirror!;
  if (!primary) await writeJsonImmutably(paths.primaryReceiptPath, receipt);
  if (!mirror) await writeJsonImmutably(paths.mirrorReceiptPath, receipt);
  await writeJsonArtifact(paths.outputPath, receipt.output);
  if (paths.loopOutputPath) await writeJsonArtifact(paths.loopOutputPath, receipt.output);
  return {
    output: receipt.output,
    ...(receipt.providerSessionId ? { providerSessionId: receipt.providerSessionId } : {}),
    recoveredFromReceipt: true,
    receiptSha256: receipt.receiptSha256,
  };
}

export async function commitCompletionReceipt(input: {
  execution: AgentExecutionInputV2;
  promptSha256: string;
  outputSchemaSha256: string;
  output: JsonValue;
  providerSessionId?: string;
  afterPrimary?: () => Promise<void>;
}): Promise<AgentCompletionReceipt> {
  const paths = completionPaths(input.execution);
  await writeJsonArtifact(paths.outputPath, input.output);
  if (paths.loopOutputPath) await writeJsonArtifact(paths.loopOutputPath, input.output);
  const receipt = buildCompletionReceipt({
    ...input,
    completedAt: new Date().toISOString(),
  });
  await writeJsonImmutably(paths.primaryReceiptPath, receipt);
  await input.afterPrimary?.();
  await writeJsonImmutably(paths.mirrorReceiptPath, receipt);
  return receipt;
}
