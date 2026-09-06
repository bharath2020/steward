(function (root) {
  "use strict";

  function normalizePreferences(value) {
    const input = value && typeof value === "object" ? value : {};
    return {
      layout: ["board", "review"].includes(input.layout) ? input.layout : "board",
      theme: ["dark", "light", "system"].includes(input.theme) ? input.theme : "dark",
    };
  }

  function resolveTheme(preference, systemDark) {
    const theme = normalizePreferences({ theme: preference }).theme;
    return theme === "system" ? (systemDark ? "dark" : "light") : theme;
  }

  function isEditable(element) {
    for (let current = element; current; current = current.parentElement) {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(current.tagName?.toUpperCase())) return true;
      if (current.isContentEditable) return true;
      const editable = current.getAttribute?.("contenteditable");
      if (editable !== undefined && editable !== null && editable !== "false") return true;
    }
    return false;
  }

  function shouldStartRun(event, activeElement, disabled) {
    return !disabled && !event.defaultPrevented && !event.repeat
      && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      && event.key === "r"
      && !isEditable(event.target) && !isEditable(activeElement);
  }

  const api = { normalizePreferences, resolveTheme, shouldStartRun };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }
  root.WorkflowAppearance = api;
  const storageKey = "agent-workflow:appearance:v1";
  let saved;
  try { saved = JSON.parse(root.localStorage.getItem(storageKey)); } catch {}
  let preferences = normalizePreferences(saved);
  const media = root.matchMedia("(prefers-color-scheme: dark)");

  function apply() {
    document.documentElement.dataset.layout = preferences.layout;
    document.documentElement.dataset.theme = resolveTheme(preferences.theme, media.matches);
    document.documentElement.dataset.themePreference = preferences.theme;
  }

  // Runs in <head>, before CSS and the first paint. No server command is sent.
  apply();
  media.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", () => {
    const layout = document.getElementById("layout-select");
    const theme = document.getElementById("theme-select");
    layout.value = preferences.layout;
    theme.value = preferences.theme;
    const change = () => {
      preferences = normalizePreferences({ layout: layout.value, theme: theme.value });
      try { root.localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch {}
      apply();
      root.dispatchEvent(new CustomEvent("appearancechange", { detail: { ...preferences } }));
    };
    layout.addEventListener("change", change);
    theme.addEventListener("change", change);
  });
})(typeof window === "undefined" ? globalThis : window);
