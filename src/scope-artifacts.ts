import Ajv from "ajv";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCompletionReceipt, JsonValue, TransitionInput, WorkflowDefinition, WorkflowNode } from "./contracts";
import { sha256Json, writeJsonImmutably } from "./completion-receipt";
import { readEvents, recordTransition, runDirectory } from "./store";
import { resolveValue } from "./resolver";

const ajv = new Ajv({ strict: false, allErrors: true });
export function instanceDefinition(definition: WorkflowDefinition, id: string): WorkflowNode {
  if (!/^[a-z][a-z0-9_-]*(?:~[1-9][0-9]*\.[a-z][a-z0-9_-]*)*$/.test(id)) throw new Error("Invalid scope instance identity");
  let nodes = definition.nodes;
  let found: WorkflowNode | undefined;
  for (const segment of id.split(".")) {
    found = nodes.find(node => node.id === segment.replace(/~\d+$/, ""));
    if (!found) throw new Error(`Unknown instance ${id}`);
    nodes = found.nodes ?? [];
  }
  return found!;
}
const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, "utf8"));
function validOutput(node: WorkflowNode, output: JsonValue): void {
  const schema = node.for_each ? { type: "array", items: node.outputSchema } : node.outputSchema;
  if (!ajv.validate(schema, output)) throw new Error(`Invalid committed output for ${node.id}: ${ajv.errorsText()}`);
}
function verifiedArtifact(artifact: any, input: TransitionInput, nodeId: string, output: JsonValue): string {
  if (artifact.runId !== input.runId || artifact.temporalRunId !== input.temporalRunId || artifact.nodeId !== nodeId
    || artifact.outputSha256 !== sha256Json(output) || sha256Json(artifact.output) !== sha256Json(output)) throw new Error(`Committed evidence does not match ${nodeId}`);
  return sha256Json(artifact);
}

export async function commitHumanAnswer(input: TransitionInput) {
  const node = instanceDefinition(input.definition, input.nodeId!);
  if (node.kind !== "human") throw new Error("Human commit requires a human definition");
  const data = input.data as { output: JsonValue; requestId: string };
  validOutput(node, data.output);
  const accepted = (await readEvents(input.runId)).find(event => event.type === "human.accepted" && event.nodeId === input.nodeId
    && (event.data as any)?.requestId === data.requestId);
  if (!accepted || sha256Json(data.output) !== sha256Json({ answer: (accepted.data as any).answer })) throw new Error("Human answer has no matching accepted command");
  const artifact = {
    schema: "human-output.v1", runId: input.runId, temporalRunId: input.temporalRunId, nodeId: input.nodeId,
    requestId: data.requestId, output: data.output, outputSha256: sha256Json(data.output), outputSchemaSha256: sha256Json(node.outputSchema),
  };
  await writeJsonImmutably(join(runDirectory(input.runId), "nodes", input.nodeId!, "human-output.json"), artifact);
  return recordTransition({ ...input, data: { ...data, artifactSha256: sha256Json(artifact) } });
}

/** Commit exported bindings only after every child has matching accepted evidence. */
export async function commitScopeIteration(input: TransitionInput) {
  const node = instanceDefinition(input.definition, input.nodeId!);
  if (node.kind !== "scope") throw new Error("Scope commit requires a scope definition");
  const data = input.data as { iteration: number; output: JsonValue; children: string[]; scopeInput: JsonValue; state?: JsonValue };
  if (!Number.isInteger(data.iteration) || data.iteration < 1 || data.iteration > (node.loop?.max_iterations ?? 1)) throw new Error("Invalid scope iteration");
  const expectedChildren = node.nodes!.map(child => `${input.nodeId}~${data.iteration}.${child.id}`);
  if (sha256Json(expectedChildren) !== sha256Json(data.children)) throw new Error("Scope commit does not contain its complete declared child set");
  validOutput(node, data.output);
  const events = await readEvents(input.runId);
  const localOutputs: Record<string, JsonValue> = {};
  const children = [];
  for (const [index, id] of expectedChildren.entries()) {
    const child = node.nodes![index];
    const completed = [...events].reverse().find(event => event.nodeId === id && event.type === "node.completed");
    if (!completed) throw new Error(`Scope child ${id} has no committed completion`);
    const output = (completed.data as any).output as JsonValue;
    validOutput(child, output);
    localOutputs[child.id] = output;
    const directory = join(runDirectory(input.runId), "nodes", id);
    const evidence: string[] = [];
    if (child.kind === "human") {
      const artifact = await json(join(directory, "human-output.json"));
      if (artifact.outputSchemaSha256 !== sha256Json(child.outputSchema) || sha256Json(artifact) !== (completed.data as any).artifactSha256) throw new Error(`Corrupt child artifact ${id}`);
      evidence.push(verifiedArtifact(artifact, input, id, output));
    }
    else if (child.kind === "scope") {
      const committed = [...events].reverse().find(event => event.nodeId === id && event.type === "scope.iteration_committed");
      const artifact = await json(join(directory, "scope-iterations", String((committed?.data as any)?.iteration), "output.json"));
      if (artifact.outputSchemaSha256 !== sha256Json(child.outputSchema) || sha256Json(artifact) !== (committed?.data as any)?.artifactSha256) throw new Error(`Corrupt child artifact ${id}`);
      evidence.push(verifiedArtifact(artifact, input, id, output));
    } else {
      const expected = child.for_each ? output as JsonValue[] : [output];
      const terminals = expected.map((_, item) => child.for_each
        ? [...events].reverse().find(event => event.nodeId === id && event.type === "node.item_completed" && (event.data as any)?.iteration === item + 1)
        : completed);
      const acceptedHashes = new Set(terminals.map(event => (event?.data as any)?.receiptSha256));
      const files = await readdir(directory, { recursive: true });
      const receipts: AgentCompletionReceipt[] = [];
      for (const file of files.filter(file => file.endsWith("completion-receipt.json"))) {
        let receipt: AgentCompletionReceipt;
        try { receipt = await json(join(directory, file)) as AgentCompletionReceipt; }
        catch { continue; } // An unreadable accepted receipt will fail the required match below.
        if (!receipt || !acceptedHashes.has(receipt.receiptSha256)) continue;
        const { receiptSha256, ...body } = receipt;
        if (receipt.schema !== "agent-completion-receipt.v1" || receiptSha256 !== sha256Json(body) || receipt.outputSchemaSha256 !== sha256Json(child.outputSchema)) throw new Error(`Corrupt child receipt ${id}`);
        verifiedArtifact(receipt, input, id, receipt.output);
        if (sha256Json(await json(join(directory, file.replace("completion-receipt.json", "output.json")))) !== receipt.outputSha256) throw new Error(`Corrupt child output ${id}`);
        receipts.push(receipt);
      }
      for (const [item, value] of expected.entries()) {
        const terminal = terminals[item];
        const receipt = receipts.find(receipt => receipt.outputSha256 === sha256Json(value)
          && receipt.receiptSha256 === (terminal?.data as any)?.receiptSha256
          && receipt.iteration === (terminal?.data as any)?.iteration);
        if (!receipt) throw new Error(`Scope child ${id} has no matching accepted receipt`);
        evidence.push(receipt.receiptSha256);
      }
    }
    children.push({ nodeId: id, outputSha256: sha256Json(output), evidence });
  }
  const exported = resolveValue(node.exports!, data.scopeInput, localOutputs, data.state);
  if (sha256Json(exported) !== sha256Json(data.output)) throw new Error("Scope output disagrees with declared export bindings");
  const artifact = {
    schema: "scope-output.v1", runId: input.runId, temporalRunId: input.temporalRunId,
    nodeId: input.nodeId, iteration: data.iteration, children,
    output: data.output, outputSha256: sha256Json(data.output), outputSchemaSha256: sha256Json(node.outputSchema),
  };
  await writeJsonImmutably(join(runDirectory(input.runId), "nodes", input.nodeId!, "scope-iterations", String(data.iteration), "output.json"), artifact);
  return recordTransition({ ...input, data: { ...data, artifactSha256: sha256Json(artifact) } });
}
