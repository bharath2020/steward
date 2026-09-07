import { loadInitialInput, loadWorkflow } from "../definition";
import { resolveReference } from "../resolver";
import type { JsonValue } from "../contracts";

export const examples = {
  questions: { workflow: "workflows/two-agent-multiple-choice.yaml", input: "examples/two-agent-multiple-choice-input.json" },
  product: { workflow: "workflows/product-launch.yaml", input: "examples/product-input.json" },
  privacy: { workflow: "workflows/privacy-launch-with-questions.yaml", input: "examples/product-input.json" },
  file: { workflow: "workflows/file-prompt.yaml", input: "examples/product-input.json" },
  queue: { workflow: "workflows/queued-fan-out.yaml", input: "examples/queued-fan-out-input.json" },
} as const;

export function exampleNamed(name: string) {
  if (!Object.hasOwn(examples, name)) throw new Error(`Unknown example ${name}. Choose ${Object.keys(examples).join(", ")}.`);
  return examples[name as keyof typeof examples];
}

export async function validateExamples() {
  for (const example of Object.values(examples)) {
    const definition = await loadWorkflow(example.workflow);
    const input = await loadInitialInput(example.input);
    // Resolve external input bindings before a provider or runtime is started.
    const visit = (value: JsonValue): void => {
      if (typeof value === "string" && value.startsWith("$input")) resolveReference(value, input, {});
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    for (const node of definition.nodes) {
      visit(node.inputs);
      if (node.for_each?.items.startsWith("$input")) visit(node.for_each.items);
    }
  }
}
