import { loadInitialInput, loadWorkflow } from "../src/definition";
import { resolveReference } from "../src/resolver";
import type { JsonValue } from "../src/contracts";

async function main(): Promise<void> {
  const [workflowPath, inputPath, ...extra] = process.argv.slice(2);
  if (!workflowPath || extra.length) throw new Error("Usage: npm run validate:workflow -- workflow.yaml [input.json]");
  const definition = await loadWorkflow(workflowPath);
  if (inputPath) {
    const input = await loadInitialInput(inputPath);
    const check = (value: JsonValue): void => {
      if (typeof value === "string" && (value === "$input" || value.startsWith("$input."))) {
        resolveReference(value, input, {});
      } else if (Array.isArray(value)) value.forEach(check);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(check);
    };
    for (const node of definition.nodes) {
      check(node.inputs);
      if (node.for_each?.items.startsWith("$input")) {
        const items = resolveReference(node.for_each.items, input, {});
        if (!Array.isArray(items)) throw new Error(`${node.id}.for_each.items must resolve to an array`);
      }
    }
  }
  console.log(`Valid V1 workflow: ${definition.name} (${definition.nodes.length} nodes).${inputPath ? " Initial input references checked." : " Initial input not checked."}`);
  console.log("No run started. Review node output references and nested object contracts separately.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
