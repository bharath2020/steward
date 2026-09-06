import type { JsonValue } from "./contracts";

export interface HumanAgentMessage {
  id: string;
  text: string;
}

function label(key: string): string {
  const value = key.replaceAll("_", " ");
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function display(value: JsonValue): string {
  if (value === null) return "None";
  if (Array.isArray(value)) return value.map(display).join("; ");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, child]) => `${label(key)}: ${display(child)}`)
      .join("; ");
  }
  return String(value);
}

export function humanizeAgentText(source: string): string {
  const value = source.trim();
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as JsonValue;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed)
        .map(([key, child]) => `${label(key)}: ${display(child)}`)
        .join("\n");
    }
    return display(parsed);
  } catch {
    return value;
  }
}

export function extractHumanAgentMessage(line: string): HumanAgentMessage | undefined {
  try {
    const event = JSON.parse(line) as {
      type?: unknown;
      item?: { id?: unknown; type?: unknown; text?: unknown };
    };
    if (event.type !== "item.completed" || event.item?.type !== "agent_message") return undefined;
    if (typeof event.item.text !== "string") return undefined;
    const text = humanizeAgentText(event.item.text);
    if (!text) return undefined;
    return {
      id: typeof event.item.id === "string" ? event.item.id : `agent-message:${text}`,
      text,
    };
  } catch {
    return undefined;
  }
}

export function summarizeOutput(output: JsonValue): string {
  return humanizeAgentText(JSON.stringify(output));
}
