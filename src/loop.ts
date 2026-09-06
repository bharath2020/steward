import type { JsonValue, NodeLoop } from "./contracts";

function read(value: JsonValue, path: string): JsonValue | undefined {
  let cursor: JsonValue | undefined = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor) || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

export function loopSatisfied(loop: NodeLoop, output: JsonValue): boolean {
  const actual = read(output, loop.until.path);
  const expected = loop.until.value;
  switch (loop.until.operator) {
    case "equals": return actual === expected;
    case "not_equals": return actual !== expected;
    case "greater_than": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "greater_than_or_equal": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "less_than": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "less_than_or_equal": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains": return (typeof actual === "string" && typeof expected === "string" && actual.includes(expected)) || (Array.isArray(actual) && actual.includes(expected as never));
    case "truthy": return Boolean(actual);
  }
}
