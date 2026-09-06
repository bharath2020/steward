import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { DASHBOARD_PORT } from "../config";
import { workerReady, dashboardReady } from "./readiness";

function canConnect(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(400);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canConnect(port)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function argument(argv: string[], name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv): Promise<void> {
  const children: ChildProcess[] = [];
  let stopping = false;
  // Preserve the existing local-launcher paths. The durable store's runtime
  // override does not yet control this launcher's Temporal database or logs.
  const serviceDirectory = resolve("runtime/services");
  mkdirSync(serviceDirectory, { recursive: true });

  function launch(name: string, command: string, args: string[], restart = false): ChildProcess {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const log = createWriteStream(resolve(serviceDirectory, `${name}.log`), { flags: "a" });
    child.once("error", (error) => { console.error(`${name}: ${error.message}`); log.end(); });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    child.once("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") console.error(`${name} exited with ${String(code ?? signal)}`);
      if (restart && !stopping) setTimeout(() => launch(name, command, args, true), 900);
    });
    children.push(child);
    return child;
  }

  function shutdown(): void {
    stopping = true;
    children.reverse().forEach((child) => child.kill("SIGTERM"));
  }

  const onSignal = () => {
    shutdown();
    process.exit(0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    if (!(await canConnect(7233))) {
      launch("temporal", "temporal", [
        "server",
        "start-dev",
        "--db-filename",
        resolve("runtime/temporal.db"),
        "--ip",
        "127.0.0.1",
        "--port",
        "7233",
        "--ui-port",
        "8233",
        "--ui-disable-news-fetch",
      ]);
    }
    await waitForPort(7233);
    if (!(await workerReady())) launch("worker", process.execPath, ["--import", "tsx", "src/worker.ts"], true);
    if (!(await canConnect(DASHBOARD_PORT))) {
      launch("dashboard", process.execPath, ["--import", "tsx", "src/server.ts"]);
    }
    await waitForPort(DASHBOARD_PORT);
    const readyDeadline = Date.now() + 45_000;
    while (!(await workerReady())) {
      if (Date.now() > readyDeadline) throw new Error(`Worker did not become ready. See ${serviceDirectory}/worker.log`);
      await new Promise((done) => setTimeout(done, 500));
    }
    if (!(await dashboardReady(DASHBOARD_PORT))) throw new Error(`Port ${DASHBOARD_PORT} is not a ready Steward dashboard for this Temporal address.`);

    if (!argv.includes("--no-start")) {
      const mode = argument(argv, "--mode", "simulated");
      const delayMs = Number(argument(argv, "--delay-ms", "1800"));
      const response = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, delayMs }),
      });
      if (!response.ok) throw new Error(`Could not start demo: ${await response.text()}`);
      const result = (await response.json()) as { runId: string };
      console.log(`Demo run started: ${result.runId}`);
    }
    console.log(`Steward Console: http://127.0.0.1:${DASHBOARD_PORT}`);
    console.log("Temporal history: http://127.0.0.1:8233");
    await new Promise(() => undefined);
  } catch (error) {
    shutdown();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    throw error;
  }
}
