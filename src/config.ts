export const TASK_QUEUE = "yamlflow-agent-nodes";
export const DASHBOARD_PORT = Number(process.env.YAMLFLOW_PORT ?? 4310);
export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
