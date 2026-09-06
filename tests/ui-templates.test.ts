import assert from "node:assert/strict";
import { test } from "node:test";
import { readUiAsset, renderDashboard } from "../src/server/templates";

type Preferences = { layout: "board" | "review"; theme: "dark" | "light" | "system" };
type Target = {
  tagName: string;
  isContentEditable: boolean;
  parentElement: Target | null;
  getAttribute(name: string): string | null;
  closest(selector: string): Target | null;
};
type ShortcutEvent = {
  key: string;
  repeat?: boolean;
  defaultPrevented?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: Target | null;
};
const { normalizePreferences, resolveTheme, shouldStartRun } = require("../ui/assets/appearance.js") as {
  normalizePreferences(value: unknown): Preferences;
  resolveTheme(preference: Preferences["theme"], systemDark: boolean): "dark" | "light";
  shouldStartRun(event: ShortcutEvent, activeElement: Target | null, disabled: boolean): boolean;
};

// A DOM-shaped target keeps keyboard policy tests independent of a browser or DOM package.
function target(tagName: string, parentElement: Target | null = null, editable = false): Target {
  const element: Target = {
    tagName: tagName.toUpperCase(),
    isContentEditable: editable || Boolean(parentElement?.isContentEditable),
    parentElement,
    getAttribute: (name) => name === "contenteditable" && editable ? "true" : null,
    closest(selector) {
      for (let current: Target | null = element; current; current = current.parentElement) {
        const matchesTag = selector.split(",").some((part) => part.trim().toUpperCase() === current!.tagName);
        if (matchesTag || (selector.includes("[contenteditable") && current.getAttribute("contenteditable") === "true")) {
          return current;
        }
      }
      return null;
    },
  };
  return element;
}

test("dashboard composition preserves each application mount point exactly once", async () => {
  const html = await renderDashboard();
  const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const requiredIds = [
    "graph-fit", "graph-zoom-in", "graph-zoom-out", "graph-zoom-reset",
    "connection", "summary-completed", "summary-wave", "summary-elapsed", "mode", "pace", "run-again",
    "run-count", "run-list", "graph-title", "workflow-file", "definition-hash", "graph-shell", "graph", "empty-state",
    "inspector-title", "inspector-status", "inspector-content", "timeline-title", "event-count", "durable-path",
    "timeline", "toast", "layout-select", "theme-select",
  ];
  for (const id of requiredIds) {
    assert.equal(ids.filter((candidate) => candidate === id).length, 1, `${id} must appear exactly once`);
  }
  assert.doesNotMatch(html, /\{\{[\s\S]*?\}\}/, "template placeholders must be resolved");
  assert.match(html, /<script\b[^>]*\bsrc=["']\/appearance\.js["']/);
  assert.match(html, /<script\b[^>]*\bsrc=["']\/app\.js["']/);
  for (const [id, options] of [
    ["layout-select", ["board", "review"]],
    ["theme-select", ["dark", "light", "system"]],
  ] as const) {
    const select = html.match(new RegExp(`<select\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/select>`));
    assert.ok(select, `${id} must be a select control`);
    for (const value of options) assert.match(select[1], new RegExp(`\\bvalue=["']${value}["']`));
  }
});

test("UI asset lookup serves only the explicit public asset allowlist", async () => {
  const knownAssets = [
    ["/app.js", /^(?:application|text)\/javascript\b/],
    ["/graph-layout.js", /^(?:application|text)\/javascript\b/],
    ["/human-input.js", /^(?:application|text)\/javascript\b/],
    ["/appearance.js", /^(?:application|text)\/javascript\b/],
    ["/styles.css", /^text\/css\b/],
    ["/themes.css", /^text\/css\b/],
    ["/layouts.css", /^text\/css\b/],
    ["/icon.png", /^image\/png\b/],
  ] as const;
  for (const [pathname, contentType] of knownAssets) {
    const asset = await readUiAsset(pathname);
    assert.ok(asset, `${pathname} should be served`);
    assert.ok(Buffer.isBuffer(asset.body));
    assert.ok(asset.body.length > 0, `${pathname} must not be empty`);
    assert.match(asset.contentType, contentType);
    if (pathname === "/icon.png") assert.deepEqual([...asset.body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  for (const pathname of [
    "/", "/index.html", "/unknown.js", "/app.js.map", "/assets/app.js", "app.js",
    "/../package.json", "/../../src/server.ts", "/%2e%2e/package.json", "/assets/../app.js",
    "/app.js/../styles.css", "/app.js?raw=1", "/app.js\0", "\\..\\package.json",
  ]) {
    assert.equal(await readUiAsset(pathname), undefined, `${JSON.stringify(pathname)} must not be served`);
  }
});

test("appearance preferences retain supported choices and fall back independently", () => {
  for (const value of [undefined, null, false, 1, "review", [], {}, { layout: "grid", theme: "sepia" }]) {
    assert.deepEqual(normalizePreferences(value), { layout: "board", theme: "dark" });
  }
  for (const layout of ["board", "review"] as const) {
    for (const theme of ["dark", "light", "system"] as const) {
      assert.deepEqual(normalizePreferences({ layout, theme }), { layout, theme });
    }
  }
  assert.deepEqual(normalizePreferences({ layout: "review", theme: null }), { layout: "review", theme: "dark" });
  assert.deepEqual(normalizePreferences({ layout: "unknown", theme: "system" }), { layout: "board", theme: "system" });
  assert.deepEqual(normalizePreferences({ layout: ["review"], theme: ["light"] }), { layout: "board", theme: "dark" });
});

test("explicit themes ignore the operating system and system theme follows it", () => {
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("system", true), "dark");
});

test("run shortcut requires a fresh unmodified lowercase r and an enabled action", () => {
  const body = target("body");
  assert.equal(shouldStartRun({ key: "r", target: body }, body, false), true);
  assert.equal(shouldStartRun({ key: "r" }, null, false), true);
  assert.equal(shouldStartRun({ key: "r", target: body }, body, true), false);
  for (const key of ["R", "Enter", "Escape", "", "ArrowRight"]) {
    assert.equal(shouldStartRun({ key, target: body }, body, false), false, `key ${JSON.stringify(key)}`);
  }
  for (const modifier of ["repeat", "defaultPrevented", "altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
    assert.equal(shouldStartRun({ key: "r", [modifier]: true, target: body }, body, false), false, modifier);
  }
});

test("run shortcut preserves typing in form controls and editable descendants", () => {
  const body = target("body");
  const editables = [target("input"), target("textarea"), target("select"), target("div", null, true)];
  for (const editable of editables) {
    for (const focused of [editable, target("span", editable)]) {
      assert.equal(shouldStartRun({ key: "r", target: focused }, body, false), false, `${editable.tagName} event target`);
      assert.equal(shouldStartRun({ key: "r", target: body }, focused, false), false, `${editable.tagName} active element`);
    }
  }
});
