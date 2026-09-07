import type { JsonValue, WorkflowNode } from "./contracts";

function readPath(value: JsonValue | undefined, path: string, reference: string): JsonValue {
  const parts = path.split(".").filter(Boolean);
  let cursor: JsonValue | undefined = value;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor) || !Object.hasOwn(cursor, part)) {
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
  state?: JsonValue,
  output?: JsonValue,
): JsonValue {
  for (const [prefix, value] of [["$state", state], ["$output", output]] as const) {
    if (value !== undefined && (reference === prefix || reference.startsWith(`${prefix}.`))) {
      return readPath(value, reference === prefix ? "" : reference.slice(prefix.length + 1), reference);
    }
  }
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

export function resolveValue(value: JsonValue, initialInput: JsonValue, outputs: Record<string, JsonValue>, state?: JsonValue, output?: JsonValue): JsonValue {
  if (typeof value === "string" && value.startsWith("$")) {
    return resolveReference(value, initialInput, outputs, state, output);
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, initialInput, outputs, state, output));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, initialInput, outputs, state, output)]),
    );
  }
  return value;
}

export function resolveNodeInputs(
  node: WorkflowNode,
  initialInput: JsonValue,
  outputs: Record<string, JsonValue>,
  state?: JsonValue,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(node.inputs).map(([key, value]) => [key, resolveValue(value, initialInput, outputs, state)]),
  );
}

export function resolveForEachItems(
  node: WorkflowNode,
  initialInput: JsonValue,
  outputs: Record<string, JsonValue>,
): JsonValue[] {
  if (!node.for_each) throw new Error(`Node ${node.id} does not declare for_each`);
  const value = resolveReference(node.for_each.items, initialInput, outputs);
  if (!Array.isArray(value)) {
    throw new Error(`Reference ${node.for_each.items} for node ${node.id} did not resolve to an array`);
  }
  return value;
}
