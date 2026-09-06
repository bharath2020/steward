import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DASHBOARD_PORT, TEMPORAL_ADDRESS } from "../config";
import { exampleNamed, validateExamples } from "./examples";
import { dashboardReady, workerReady } from "./readiness";
import { loadInitialInput, loadWorkflow } from "../definition";
import { createRunId, startWorkflow } from "../client";

export function setupOptions(argv: string[]) {
  let example = "questions";
  let newRun = false, check = false, noOpen = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--example") example = argv[++index] ?? "";
    else if (arg === "--new-run") newRun = true;
    else if (arg === "--check") check = true;
    else if (arg === "--no-open") noOpen = true;
    else throw new Error(`Unknown setup option: ${arg}`);
  }
  return { example: exampleNamed(example), newRun, check, noOpen };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = setupOptions(argv);
  if (TEMPORAL_ADDRESS !== "127.0.0.1:7233" || process.env.YAMLFLOW_RUNTIME_DIR) {
    throw new Error("One-click setup uses the repository's local runtime and Temporal at 127.0.0.1:7233. Unset custom runtime/address overrides first.");
  }
  await validateExamples();
  console.log("Validated all four bundled workflows and their input bindings.");
  if (options.check) return;

  await mkdir("runtime/services", { recursive: true });
  const lockPath = "runtime/services/setup.lock";
  // Exclusive setup lock prevents concurrent clicks from submitting two starts.
  try {
    const pid = Number(await readFile(lockPath, "utf8"));
    try { process.kill(pid, 0); throw new Error("Setup is already running. Wait for its window to finish."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await unlink(lockPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock = await open(lockPath, "wx");
  await lock.writeFile(String(process.pid));
  try {
    if (!(await workerReady()) || !(await dashboardReady(DASHBOARD_PORT))) {
      console.log("Starting Temporal, worker, and dashboard; keeping saved runs…");
      const log = openSync("runtime/services/setup-launcher.log", "a");
      const child = spawn(process.execPath, ["--import", "tsx", "src/launcher.ts", "--no-start"], {
        cwd: process.cwd(), detached: true, stdio: ["ignore", log, log],
        env: { ...process.env, YAMLFLOW_WORKFLOW: options.example.workflow, YAMLFLOW_INPUT: options.example.input },
      });
      closeSync(log);
      await new Promise<void>((done, fail) => { child.once("spawn", done); child.once("error", fail); });
      child.unref();
      console.log(`Background supervisor PID: ${child.pid}; logs: runtime/services/setup-launcher.log`);
      const deadline = Date.now() + 60_000;
      while (!(await workerReady()) || !(await dashboardReady(DASHBOARD_PORT))) {
        if (Date.now() > deadline) throw new Error("Services did not become ready. Inspect runtime/services/*.log before retrying.");
        await new Promise((done) => setTimeout(done, 700));
      }
    }
    const runs = await readdir("runtime/runs").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const priorAttempt = await readFile("runtime/services/setup-start.json", "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (options.newRun || (runs.length === 0 && !priorAttempt)) {
      const runId = createRunId();
      // Record intent before the network call. An uncertain start is never
      // silently retried merely because its disk projection has not arrived.
      await writeFile("runtime/services/setup-start.json", JSON.stringify({ runId, workflowId: `yamlflow-${runId}`, example: options.example, attemptedAt: new Date().toISOString() }, null, 2));
      const result = await startWorkflow({
        definition: await loadWorkflow(options.example.workflow),
        initialInput: await loadInitialInput(options.example.input), mode: "simulated", delayMs: 500, runId,
      });
      console.log(`Example submitted: ${result.runId}. Completion is reported by Temporal and committed artifacts.`);
    } else if (runs.length === 0) console.log("A prior start attempt is recorded in runtime/services/setup-start.json. Inspect its Workflow ID in Temporal; no duplicate was submitted.");
    else console.log("Reconnected to saved runs. Use --new-run to start another example.");
    const url = `http://127.0.0.1:${DASHBOARD_PORT}`;
    console.log(`Steward ready: ${url}\nTemporal history: http://127.0.0.1:8233\nData: ${resolve("runtime")}`);
    if (!options.noOpen && process.platform === "darwin") {
      const browser = spawn("open", [url], { stdio: "ignore" });
      browser.on("error", () => console.log(`Open ${url} in your browser.`));
    }
  } finally { await lock.close(); await unlink(lockPath); }
}
