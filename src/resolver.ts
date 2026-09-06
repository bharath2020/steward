import type { JsonValue, WorkflowNode } from "./contracts";

function readPath(value: JsonValue | undefined, path: string, reference: string): JsonValue {
  const parts = path.split(".").filter(Boolean);
  let cursor: JsonValue | undefined = value;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor) || !(part in cursor)) {
      throw new Error(`Reference ${reference} could not resolve segment ${part}`);
    }
    cursor = cursor[part];
  }
  if (cursor === undefined) throw new Error(`Reference ${reference} resolved to undefined`);
  return cursor;
}

export function resolveReference(
  reference: string,
  initialInput: JsonValue,
  outputs: Record<string, JsonValue>,
): JsonValue {
  if (reference === "$input") return initialInput;
  if (reference.startsWith("$input.")) {
    return readPath(initialInput, reference.slice("$input.".length), reference);
  }

  const nodeMatch = /^\$nodes\.([a-zA-Z0-9_-]+)\.output(?:\.(.+))?$/.exec(reference);
  if (nodeMatch) {
    const [, nodeId, path = ""] = nodeMatch;
    if (!(nodeId in outputs)) throw new Error(`Reference ${reference} points to unavailable node ${nodeId}`);
    return path ? readPath(outputs[nodeId], path, reference) : outputs[nodeId];
  }

  return reference;
}

function resolveValue(value: JsonValue, initialInput: JsonValue, outputs: Record<string, JsonValue>): JsonValue {
  if (typeof value === "string" && value.startsWith("$")) {
    return resolveReference(value, initialInput, outputs);
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, initialInput, outputs));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, initialInput, outputs)]),
    );
  }
  return value;
}

export function resolveNodeInputs(
  node: WorkflowNode,
  initialInput: JsonValue,
  outputs: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(node.inputs).map(([key, value]) => [key, resolveValue(value, initialInput, outputs)]),
  );
}
