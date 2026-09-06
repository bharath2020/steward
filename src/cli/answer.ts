import { submitHumanAnswer } from "../client";

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv = process.argv): Promise<void> {
  const runId = argument(argv, "--run");
  const requestId = argument(argv, "--request");
  const answer = argument(argv, "--answer");
  if (!runId || !requestId || !answer?.trim()) {
    throw new Error("Usage: npm run answer -- --run <run-id> --request <request-id> --answer <text>");
  }
  console.log(JSON.stringify(await submitHumanAnswer(runId, { requestId, answer })));
}
