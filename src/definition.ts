import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import Ajv from "ajv";
import type {
  AgentProvider,
  JsonSchema,
  JsonValue,
  OutputType,
  WorkflowDefinition,
  WorkflowGroup,
  NodeLoop,
  NodeForEach,
  WorkflowNode,
} from "./contracts";

const OUTPUT_TYPES = new Set<OutputType>([
  "string",
  "number",
  "boolean",
  "object",
  "string[]",
  "number[]",
  "boolean[]",
  "object[]",
]);
const ajv = new Ajv({ allErrors: true, strict: false });

function fail(message: string): never {
  throw new Error(`Invalid workflow: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function provider(value: unknown, label: string): AgentProvider {
  if (value !== "simulated" && value !== "codex") fail(`${label} must be simulated or codex`);
  return value;
}

function schemaFor(outputs: Record<string, OutputType>): JsonSchema {
  const properties: JsonSchema["properties"] = {};
  for (const [key, outputType] of Object.entries(outputs)) {
    if (outputType.endsWith("[]")) {
      properties[key] = { type: "array", items: { type: outputType.slice(0, -2) } as unknown as JsonValue };
    } else {
      properties[key] = { type: outputType };
    }
  }
  return { type: "object", properties, required: Object.keys(outputs), additionalProperties: false };
}

function normalizeLoop(id: string, raw: unknown): NodeLoop | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isRecord(raw.until)) fail(`node ${id}.loop requires an until condition`);
  const maxIterations = raw.max_iterations ?? 3;
  if (!Number.isInteger(maxIterations) || Number(maxIterations) < 1 || Number(maxIterations) > 20) {
    fail(`node ${id}.loop.max_iterations must be between 1 and 20`);
  }
  if (typeof raw.until.path !== "string" || !raw.until.path) fail(`node ${id}.loop.until.path is required`);
  const operators = ["equals", "not_equals", "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal", "contains", "truthy"];
  if (!operators.includes(String(raw.until.operator))) fail(`node ${id}.loop.until.operator is unsupported`);
  const onExhaustion = raw.on_exhaustion ?? "fail";
  if (onExhaustion !== "fail" && onExhaustion !== "accept_last") fail(`node ${id}.loop.on_exhaustion is invalid`);
  return {
    max_iterations: Number(maxIterations),
    carry_as: typeof raw.carry_as === "string" && raw.carry_as ? raw.carry_as : "previous_output",
    on_exhaustion: onExhaustion,
    until: {
      path: raw.until.path,
      operator: raw.until.operator as NodeLoop["until"]["operator"],
      value: raw.until.value as JsonValue | undefined,
    },
  };
}

function normalizeForEach(id: string, raw: unknown, defaultMaxParallelism: number): NodeForEach | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail(`node ${id}.for_each must be an object`);
  if (
    typeof raw.items !== "string"
    || !(raw.items === "$input" || raw.items.startsWith("$input.") || raw.items.startsWith("$nodes."))
  ) {
    fail(`node ${id}.for_each.items must be an input or node output reference`);
  }
  if (typeof raw.as !== "string" || !/^[a-z][a-z0-9_]*$/.test(raw.as)) {
    fail(`node ${id}.for_each.as must use lowercase letters, numbers, or underscores`);
  }
  const maxParallelism = raw.max_parallelism ?? defaultMaxParallelism;
  if (!Number.isInteger(maxParallelism) || Number(maxParallelism) < 1) {
    fail(`node ${id}.for_each.max_parallelism must be a positive integer`);
  }
  return {
    items: raw.items,
    as: raw.as,
    max_parallelism: Number(maxParallelism),
  };
}

function validatePromptSource(id: string, raw: Record<string, unknown>): void {
  const hasFile = Object.hasOwn(raw, "prompt_file");
  if (raw.kind === "human") {
    if (hasFile) fail(`node ${id}.prompt_file is not supported for human input; use question`);
    return;
  }
  if (hasFile && Object.hasOwn(raw, "prompt")) fail(`node ${id} must specify exactly one of prompt or prompt_file`);
  if (hasFile) {
    if (typeof raw.prompt_file !== "string" || !raw.prompt_file.trim() || raw.prompt_file.includes("\0")) {
      fail(`node ${id}.prompt_file must be a non-empty file path without null bytes`);
    }
  } else if (typeof raw.prompt !== "string" || !raw.prompt.trim()) {
    fail(`node ${id} requires exactly one of prompt or prompt_file`);
  }
}

function normalizeNode(
  id: string,
  raw: unknown,
  defaultProvider: AgentProvider,
  defaultMaxParallelism: number,
  promptFiles: ReadonlyMap<string, string>,
): WorkflowNode {
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) fail(`node id ${id} must use lowercase letters, numbers, - or _`);
  if (!isRecord(raw)) fail(`node ${id} must be an object`);
  const kind = raw.kind === undefined ? "agent" : raw.kind;
  if (kind !== "agent" && kind !== "human") fail(`node ${id}.kind must be agent or human`);
  validatePromptSource(id, raw);
  const filePath = typeof raw.prompt_file === "string" ? raw.prompt_file : undefined;
  const prompt = filePath === undefined ? raw.prompt : promptFiles.get(filePath);
  if (filePath !== undefined && prompt === undefined) {
    fail(`node ${id}.prompt_file ${JSON.stringify(filePath)} has not been loaded; use loadWorkflow or supply promptFiles to parseWorkflow`);
  }
  if (filePath !== undefined && (typeof prompt !== "string" || !prompt.trim())) {
    fail(`node ${id}.prompt_file ${JSON.stringify(filePath)} must contain a non-empty prompt`);
  }
  if (kind === "human" && (typeof raw.question !== "string" || !raw.question.trim())) fail(`node ${id}.question is required`);
  if (kind === "human" && raw.loop !== undefined) fail(`node ${id}.loop is not supported for human input`);
  if (kind === "human" && raw.for_each !== undefined) fail(`node ${id}.for_each is not supported for human input`);
  if (raw.loop !== undefined && raw.for_each !== undefined) fail(`node ${id} cannot combine loop and for_each`);
  if (kind === "human" && raw.inputs !== undefined) fail(`node ${id}.inputs is derived from question and must be omitted`);

  const declaredOutputs = kind === "human" ? { answer: "string" } : raw.outputs;
  if (!isRecord(declaredOutputs) || Object.keys(declaredOutputs).length === 0) fail(`node ${id}.outputs is required`);

  const outputs: Record<string, OutputType> = {};
  for (const [name, type] of Object.entries(declaredOutputs)) {
    if (typeof type !== "string" || !OUTPUT_TYPES.has(type as OutputType)) {
      fail(`node ${id}.outputs.${name} has unsupported type ${String(type)}`);
    }
    outputs[name] = type as OutputType;
  }

  const needs = raw.needs === undefined ? [] : raw.needs;
  if (!Array.isArray(needs) || needs.some((item) => typeof item !== "string")) fail(`node ${id}.needs must be a list`);
  const inputs = kind === "human" ? { question: raw.question } : raw.inputs === undefined ? {} : raw.inputs;
  if (!isRecord(inputs)) fail(`node ${id}.inputs must be an object`);
  const forEach = kind === "agent" ? normalizeForEach(id, raw.for_each, defaultMaxParallelism) : undefined;
  if (forEach && Object.hasOwn(inputs, forEach.as)) {
    fail(`node ${id}.inputs.${forEach.as} conflicts with for_each.as`);
  }

  const node: WorkflowNode = {
    id,
    title: typeof raw.title === "string" ? raw.title : id,
    kind,
    agent: raw.agent === undefined ? defaultProvider : provider(raw.agent, `node ${id}.agent`),
    group: typeof raw.group === "string" ? raw.group : undefined,
    needs: [...new Set(needs as string[])],
    prompt: kind === "human" ? "Wait for the operator's answer." : prompt as string,
    ...(filePath === undefined ? {} : {
      promptSource: { path: filePath, sha256: createHash("sha256").update(prompt as string).digest("hex") },
    }),
    inputs: inputs as Record<string, JsonValue>,
    outputs,
    outputSchema: schemaFor(outputs),
    demo_output: kind === "agent" ? raw.demo_output as JsonValue | undefined : undefined,
    demo_outputs: kind === "agent" && Array.isArray(raw.demo_outputs) ? (raw.demo_outputs as JsonValue[]) : undefined,
    delay_ms: typeof raw.delay_ms === "number" ? raw.delay_ms : undefined,
    loop: kind === "agent" ? normalizeLoop(id, raw.loop) : undefined,
    for_each: forEach,
  };
  const validate = ajv.compile(node.outputSchema);
  const examples = node.demo_outputs ?? (node.demo_output === undefined ? [] : [node.demo_output]);
  examples.forEach((example, index) => {
    if (!validate(example)) fail(`node ${id} demo output ${index + 1} does not match outputs: ${ajv.errorsText(validate.errors)}`);
  });
  return node;
}

function validateGraph(nodes: WorkflowNode[]): void {
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    for (const dependency of node.needs) {
      if (!ids.has(dependency)) fail(`node ${node.id} needs unknown node ${dependency}`);
      if (dependency === node.id) fail(`node ${node.id} cannot depend on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(`cycle detected at node ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    byId[id].needs.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  nodes.forEach((node) => visit(node.id));

  for (const node of nodes) {
    if (!node.for_each || node.for_each.items.startsWith("$input")) continue;
    const match = /^\$nodes\.([a-zA-Z0-9_-]+)\.output(?:\.([a-zA-Z0-9_-]+))?$/.exec(node.for_each.items);
    if (!match) {
      fail(`node ${node.id}.for_each.items must reference $input, $input.path, or one declared array output`);
    }
    const [, dependencyId, outputName] = match;
    if (!node.needs.includes(dependencyId)) {
      fail(`node ${node.id}.for_each.items references ${dependencyId}, which must be listed in needs`);
    }
    const dependency = byId[dependencyId];
    if (dependency?.for_each) {
      if (outputName !== undefined) {
        fail(`node ${node.id}.for_each.items must reference the complete mapped output of ${dependencyId}`);
      }
      continue;
    }
    if (!dependency || outputName === undefined || !dependency.outputs[outputName]?.endsWith("[]")) {
      fail(`node ${node.id}.for_each.items must reference an array output`);
    }
  }
}

function parseDocument(source: string): Record<string, unknown> & { nodes: Record<string, unknown>; name: string } {
  const raw = YAML.parse(source) as unknown;
  if (!isRecord(raw)) fail("document must be an object");
  if (raw.version !== 1) fail("version must be 1");
  if (typeof raw.name !== "string" || !raw.name.trim()) fail("name is required");
  if (!isRecord(raw.nodes) || Object.keys(raw.nodes).length === 0) fail("nodes must be a non-empty object");
  return raw as Record<string, unknown> & { nodes: Record<string, unknown>; name: string };
}

/** Pure parsing: file contents must be supplied by the caller, never read here. */
export function parseWorkflow(
  source: string,
  sourcePath = "workflow.yaml",
  promptFiles: ReadonlyMap<string, string> = new Map(),
): WorkflowDefinition {
  return compileWorkflow(parseDocument(source), sourcePath, promptFiles);
}

function compileWorkflow(
  raw: ReturnType<typeof parseDocument>,
  sourcePath: string,
  promptFiles: ReadonlyMap<string, string>,
): WorkflowDefinition {

  const defaultsRaw = isRecord(raw.defaults) ? raw.defaults : {};
  const defaultProvider = defaultsRaw.provider === undefined ? "simulated" : provider(defaultsRaw.provider, "defaults.provider");
  const maxParallelism = defaultsRaw.max_parallelism ?? 4;
  const maximumAttempts = isRecord(defaultsRaw.retry) ? defaultsRaw.retry.maximum_attempts ?? 2 : 2;
  const delayMs = defaultsRaw.delay_ms ?? 1200;
  if (!Number.isInteger(maxParallelism) || Number(maxParallelism) < 1) fail("defaults.max_parallelism must be a positive integer");
  if (!Number.isInteger(maximumAttempts) || Number(maximumAttempts) < 1) fail("defaults.retry.maximum_attempts must be a positive integer");
  if (Number(maximumAttempts) > 5) fail("defaults.retry.maximum_attempts cannot exceed 5");
  if (typeof delayMs !== "number" || delayMs < 0) fail("defaults.delay_ms must be a non-negative number");

  const nodes = Object.entries(raw.nodes).map(([id, value]) =>
    normalizeNode(id, value, defaultProvider, Number(maxParallelism), promptFiles));
  const groupsRaw = raw.groups === undefined ? {} : raw.groups;
  if (!isRecord(groupsRaw)) fail("groups must be an object");
  const groups: WorkflowGroup[] = Object.entries(groupsRaw).map(([id, value]) => {
    if (!isRecord(value)) fail(`group ${id} must be an object`);
    const groupMax = value.max_parallelism;
    if (groupMax !== undefined && (!Number.isInteger(groupMax) || Number(groupMax) < 1)) {
      fail(`group ${id}.max_parallelism must be a positive integer`);
    }
    return {
      id,
      title: typeof value.title === "string" ? value.title : id,
      description: typeof value.description === "string" ? value.description : "",
      max_parallelism: groupMax === undefined ? undefined : Number(groupMax),
    };
  });
  const groupIds = new Set(groups.map((group) => group.id));
  nodes.forEach((node) => {
    if (node.group && !groupIds.has(node.group)) fail(`node ${node.id} references unknown group ${node.group}`);
  });
  validateGraph(nodes);

  const resolvedPrompts = nodes.filter((node) => node.promptSource).map((node) => ({ id: node.id, prompt: node.prompt }));
  // Keep inline definition identity stable while binding file contents when present.
  const canonical = JSON.stringify({ ...raw, sourcePath: undefined, ...(resolvedPrompts.length ? { resolvedPrompts } : {}) });
  return {
    version: 1,
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    sourcePath,
    definitionHash: createHash("sha256").update(canonical).digest("hex"),
    defaults: {
      provider: defaultProvider,
      max_parallelism: Number(maxParallelism),
      retry: { maximum_attempts: Number(maximumAttempts) },
      delay_ms: delayMs,
    },
    groups,
    nodes,
  };
}

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const absolute = resolve(filePath);
  const raw = parseDocument(await readFile(absolute, "utf8"));
  const promptFiles = new Map<string, string>();
  const contentByPath = new Map<string, string>();
  // Check every source declaration before reading any referenced file.
  for (const [id, value] of Object.entries(raw.nodes)) {
    if (!isRecord(value)) fail(`node ${id} must be an object`);
    validatePromptSource(id, value);
  }
  for (const [id, value] of Object.entries(raw.nodes)) {
    const node = value as Record<string, unknown>;
    if (typeof node.prompt_file !== "string") continue;
    const promptPath = resolve(dirname(absolute), node.prompt_file);
    let content = contentByPath.get(promptPath);
    if (content === undefined) {
      try {
        const bytes = await readFile(promptPath);
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        fail(`node ${id}.prompt_file ${JSON.stringify(node.prompt_file)} cannot be read as UTF-8: ${reason}`);
      }
      contentByPath.set(promptPath, content);
    }
    promptFiles.set(node.prompt_file, content);
  }
  return compileWorkflow(raw, absolute, promptFiles);
}

export async function loadInitialInput(filePath: string): Promise<JsonValue> {
  const value = JSON.parse(await readFile(resolve(filePath), "utf8")) as JsonValue;
  return value;
}
