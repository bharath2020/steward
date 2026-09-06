import { startWorkflow } from "../client";
import type { AgentProvider } from "../contracts";
import { loadInitialInput, loadWorkflow } from "../definition";

function argument(argv: string[], name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv): Promise<void> {
  const workflowPath = argument(argv, "--workflow", "workflows/product-launch.yaml")!;
  const inputPath = argument(argv, "--input", "examples/product-input.json")!;
  const mode = argument(argv, "--mode", "simulated") as AgentProvider;
  const delayRaw = argument(argv, "--delay-ms");
  if (mode !== "simulated" && mode !== "codex") throw new Error("--mode must be simulated or codex");
  const result = await startWorkflow({
    definition: await loadWorkflow(workflowPath),
    initialInput: await loadInitialInput(inputPath),
    mode,
    delayMs: delayRaw === undefined ? undefined : Number(delayRaw),
  });
  console.log(JSON.stringify(result));
}
