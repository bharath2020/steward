import { Connection } from "@temporalio/client";
import { hostname } from "node:os";
import { TASK_QUEUE, TEMPORAL_ADDRESS } from "../config";

export async function workerReady(): Promise<boolean> {
  let connection: Connection | undefined;
  try {
    connection = await Connection.connect({ address: TEMPORAL_ADDRESS, connectTimeout: "2 seconds" });
    return await connection.withDeadline(Date.now() + 3000, async () => {
      for (const taskQueueType of [1, 2]) {
        const queue = await connection!.workflowService.describeTaskQueue({
          namespace: "default", taskQueue: { name: TASK_QUEUE }, taskQueueType,
        });
        if (!queue.pollers?.some((poller) => {
          const seconds = Number(poller.lastAccessTime?.seconds ?? 0);
          if (Date.now() - seconds * 1000 >= 90_000) return false;
          const [pid, host] = (poller.identity ?? "").split("@");
          if (host === hostname() && /^\d+$/.test(pid)) {
            try { process.kill(Number(pid), 0); } catch { return false; }
          }
          return true;
        })) return false;
      }
      return true;
    });
  } catch { return false; }
  finally { await connection?.close(); }
}

export async function dashboardReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const health = await response.json() as { ok?: boolean; transport?: string; temporalAddress?: string };
    return response.ok && health.ok === true && health.transport === "sse" && health.temporalAddress === TEMPORAL_ADDRESS;
  } catch { return false; }
}
