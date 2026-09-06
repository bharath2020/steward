import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// UI resources belong to the application, independently of the run's cwd.
const uiRoot = resolve(__dirname, "../../ui");
const components = ["toolbar", "runs", "graph", "inspector", "timeline"] as const;
const assets: Readonly<Record<string, { file: string; contentType: string }>> = {
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/graph-layout.js": { file: "graph-layout.js", contentType: "text/javascript; charset=utf-8" },
  "/human-input.js": { file: "human-input.js", contentType: "text/javascript; charset=utf-8" },
  "/appearance.js": { file: "appearance.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/themes.css": { file: "themes.css", contentType: "text/css; charset=utf-8" },
  "/layouts.css": { file: "layouts.css", contentType: "text/css; charset=utf-8" },
  "/icon.png": { file: "icon.png", contentType: "image/png" },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export async function renderDashboard(): Promise<string> {
  const [shell, brandSource, fragments] = await Promise.all([
    readFile(resolve(uiRoot, "templates/shell.html"), "utf8"),
    readFile(resolve(uiRoot, "brand.json"), "utf8"),
    Promise.all(components.map(async (name) => [name,
      await readFile(resolve(uiRoot, `templates/components/${name}.html`), "utf8"),
    ] as const)),
  ]);
  const brand = JSON.parse(brandSource) as Record<string, unknown>;
  const partials = Object.fromEntries(fragments);
  const page = shell.replace(/\{\{>\s*([a-z]+)\s*\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(partials, name)) throw new Error(`Unknown UI component: ${name}`);
    return partials[name];
  }).replace(/\{\{brand\.([a-z]+)\}\}/g, (_, key: string) => {
    if (!["name", "tagline", "description"].includes(key) || typeof brand[key] !== "string") {
      throw new Error(`Invalid UI brand field: ${key}`);
    }
    return escapeHtml(brand[key] as string);
  });
  if (/\{\{[^}]+\}\}/.test(page)) throw new Error("Unresolved UI template token");
  return page;
}

export async function readUiAsset(pathname: string): Promise<{ body: Buffer; contentType: string } | undefined> {
  if (!Object.hasOwn(assets, pathname)) return undefined;
  const asset = assets[pathname];
  return { body: await readFile(resolve(uiRoot, "assets", asset.file)), contentType: asset.contentType };
}
