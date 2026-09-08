import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import type { JsonValue } from "./contracts";
import { parseWorkflow } from "./definition";
import { resolveWorkingDirectory } from "./repository-workspace";
import { resolveReference } from "./resolver";
import { runtimeRoot } from "./store";
import { sha256Json, writeJsonImmutably } from "./completion-receipt";
import { startWorkflow, type StartOptions } from "./client";

export class PreparationError extends Error {}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
interface Entry { id: string; name: string; workflow: string; input: string; allowedRoots: string[] }
async function catalog(): Promise<Entry[]> {
  const path = process.env.YAMLFLOW_CATALOG;
  const base = path ? dirname(resolve(path)) : process.cwd();
  const entries: Entry[] = path ? JSON.parse(await readFile(path, "utf8")).workflows : [{
    id: "configured", name: "Configured workflow", workflow: process.env.YAMLFLOW_WORKFLOW ?? "workflows/product-launch.yaml",
    input: process.env.YAMLFLOW_INPUT ?? "examples/product-input.json", allowedRoots: [dirname(resolve(process.env.YAMLFLOW_WORKFLOW ?? "workflows/product-launch.yaml")), dirname(resolve(process.env.YAMLFLOW_INPUT ?? "examples/product-input.json"))],
  }];
  if (!Array.isArray(entries) || entries.some(entry => !record(entry)
    || ![entry.id, entry.name, entry.workflow, entry.input].every(value => typeof value === "string" && value.trim())
    || !Array.isArray(entry.allowedRoots) || !entry.allowedRoots.length
    || !entry.allowedRoots.every(root => typeof root === "string" && root.trim()))
    || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new PreparationError("Invalid workflow catalog");
  return entries.map(entry => ({ ...entry, workflow: resolve(base, entry.workflow), input: resolve(base, entry.input), allowedRoots: entry.allowedRoots.map(root => resolve(base, root)) }));
}
async function allowed(path: string, entry: Entry): Promise<string> {
  const canonical = await realpath(path);
  const roots = await Promise.all(entry.allowedRoots.map(root => realpath(root)));
  if (!roots.some(root => { const part = relative(root, canonical); return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part)); })) throw new PreparationError("Workflow source is outside its catalog allowedRoots");
  return canonical;
}
export async function listWorkflows() {
  return { workflows: await Promise.all((await catalog()).map(async entry => ({ id: entry.id, name: entry.name, initialInput: JSON.parse(await readFile(await allowed(entry.input, entry), "utf8")) }))), catalogConfigured: Boolean(process.env.YAMLFLOW_CATALOG) };
}
export async function prepareRun(request: Record<string, unknown>) {
  let initialInput: JsonValue;
  try { if (typeof request.inputText !== "string") throw new Error(); initialInput = JSON.parse(request.inputText); }
  catch { throw new PreparationError("Input JSON must be valid JSON"); }
  if (!["simulated", "workflow", "codex"].includes(String(request.mode))) throw new PreparationError("Execution mode must be simulated, workflow, or codex");
  const workingDirectory = await resolveWorkingDirectory(request.workingDirectory);
  const entry = (await catalog()).find(entry => entry.id === request.workflowId);
  if (!entry) throw new PreparationError("Unknown workflow catalog selection");
  const path = await allowed(entry.workflow, entry);
  const source = await readFile(path, "utf8");
  const prompts = new Map<string, string>();
  const selectedEntry = entry;
  async function visit(nodes: unknown): Promise<void> {
    if (!record(nodes)) return;
    for (const node of Object.values(nodes)) {
      if (!record(node)) continue;
      if (typeof node.prompt_file === "string") prompts.set(node.prompt_file, await readFile(await allowed(resolve(dirname(path), node.prompt_file), selectedEntry), "utf8"));
      if (node.kind === "scope") await visit(node.nodes);
    }
  }
  let definition;
  try { await visit(YAML.parse(source)?.nodes); definition = parseWorkflow(source, path, prompts); }
  catch (error) { throw new PreparationError(`Invalid workflow: ${String(error)}`); }
  // Only external root input can be checked before dependency outputs exist.
  function check(value: unknown): void {
    if (typeof value === "string" && (value === "$input" || value.startsWith("$input."))) resolveReference(value, initialInput, {});
    else if (value && typeof value === "object") Object.values(value).forEach(check);
  }
  try { definition.nodes.forEach(node => { check(node.inputs); check(node.for_each?.items); }); }
  catch (error) { throw new PreparationError(`Invalid input: ${String(error)}`); }
  const preparedId = randomUUID();
  const prepared = { preparedId, runId: `prepared-${preparedId}`, workingDirectory, definition, initialInput, mode: request.mode as StartOptions["mode"] };
  await writeJsonImmutably(join(runtimeRoot, "prepared", `${preparedId}.json`), { ...prepared, sha256: sha256Json(prepared) });
  return prepared;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function startPreparedRun(request: Record<string, unknown>) {
  if (typeof request.preparedId !== "string" || !uuid.test(request.preparedId)) throw new PreparationError("Unknown prepared intent");
  if (typeof request.startId !== "string" || !uuid.test(request.startId)) throw new PreparationError("Prepared start requires a UUID startId");
  let saved;
  try { saved = JSON.parse(await readFile(join(runtimeRoot, "prepared", `${request.preparedId}.json`), "utf8")); }
  catch { throw new PreparationError("Unknown prepared intent; validate and preview again"); }
  const { sha256, ...prepared } = saved;
  if (sha256Json(prepared) !== sha256) throw new PreparationError("Prepared intent failed integrity validation");
  if (await resolveWorkingDirectory(prepared.workingDirectory) !== prepared.workingDirectory) throw new PreparationError("Prepared working directory changed; validate and preview again");
  try { await writeJsonImmutably(join(runtimeRoot, "prepared-starts", `${request.startId}.json`), { preparedId: request.preparedId }); }
  catch { throw new PreparationError("startId is already bound to another prepared intent"); }
  return startWorkflow({ ...prepared, idempotent: true } as StartOptions);
}
