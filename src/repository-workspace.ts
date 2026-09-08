import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Resolve operator input before connecting to Temporal. YAML cannot supply authority. */
export async function resolveWorkingDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A repository working directory is required (--working-directory).");
  }
  let canonical: string;
  try {
    canonical = await realpath(resolve(value));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Working directory must be an existing directory: ${value}`);
  }
  return canonical;
}
