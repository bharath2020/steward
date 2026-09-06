import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { TASK_QUEUE, TEMPORAL_ADDRESS } from "./config";

async function main(): Promise<void> {
  Runtime.install({ telemetryOptions: { logging: { filter: "WARN" } } });
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    activities,
    maxConcurrentActivityTaskExecutions: 8,
  });
  console.log("Steward worker ready");
  await worker.run();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
