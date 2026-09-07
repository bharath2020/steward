import type { JsonValue, NodeLoop, LoopPredicate } from "./contracts";

function read(value: JsonValue, path: string): JsonValue | undefined {
  let cursor: JsonValue | undefined = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

export function loopSatisfied(loop: NodeLoop, output: JsonValue): boolean {
  if (loop.predicate_version === 2 || !("path" in loop.until)) return predicateSatisfied(loop.until, output);
  // Histories compiled before predicate version 2 retain their original evaluator.
  let actual: JsonValue | undefined = output;
  for (const segment of loop.until.path.split(".").filter(Boolean)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual) || !(segment in actual)) { actual = undefined; break; }
    actual = actual[segment];
  }
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

export function predicateSatisfied(predicate: LoopPredicate, output: JsonValue): boolean {
  if ("all" in predicate) return predicate.all.map(child => predicateSatisfied(child, output)).every(Boolean);
  if ("any" in predicate) return predicate.any.map(child => predicateSatisfied(child, output)).some(Boolean);
  if ("not" in predicate) return !predicateSatisfied(predicate.not, output);
  const actual = read(output, predicate.path);
  if (actual === undefined) throw new Error(`Loop predicate path ${predicate.path} is unavailable`);
  const expected = predicate.value;
  if (["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(predicate.operator) && (typeof actual !== "number" || typeof expected !== "number")) throw new Error(`Loop predicate ${predicate.path} requires numeric operands`);
  if (predicate.operator === "contains" && !((typeof actual === "string" && typeof expected === "string") || Array.isArray(actual))) throw new Error(`Loop predicate ${predicate.path} requires matching contains operands`);
  switch (predicate.operator) {
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
