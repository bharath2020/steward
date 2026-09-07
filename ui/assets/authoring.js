(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WorkflowAuthoring = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function workflowFilename(name) {
    const slug = String(name ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${slug || "workflow"}.yaml`;
  }

  return { workflowFilename };
});

(function () {
  "use strict";

  if (typeof document === "undefined") return;

  const form = document.getElementById("authoring-form");
  const prompt = document.getElementById("authoring-prompt");
  const provider = document.getElementById("authoring-provider");
  const send = document.getElementById("authoring-send");
  const exportButton = document.getElementById("authoring-export");
  const messages = document.getElementById("authoring-messages");
  const status = document.getElementById("authoring-status");
  const history = [];
  let currentYaml = null;
  let currentName = null;
  let validatedStatus = "Ready";

  function addMessage(role, value, detail) {
    const item = document.createElement("article");
    item.className = `authoring-message ${role}`;
    const label = document.createElement("span");
    label.textContent = role === "user" ? "You" : detail || "Steward";
    const body = document.createElement("p");
    body.textContent = value;
    item.append(label, body);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    return item;
  }

  function setBusy(busy, label) {
    send.disabled = busy;
    provider.disabled = busy;
    prompt.disabled = busy;
    status.textContent = label;
    status.className = `authoring-status${busy ? " working" : ""}`;
    send.querySelector("span").textContent = busy ? "Drafting…" : "Generate";
  }

  function exportYaml() {
    if (!currentYaml) return;
    const filename = WorkflowAuthoring.workflowFilename(currentName);
    const url = URL.createObjectURL(new Blob([currentYaml], { type: "application/yaml;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    exportButton.textContent = "Exported";
    setTimeout(() => {
      exportButton.textContent = "Export YAML";
    }, 1800);
  }

  async function submit() {
    const message = prompt.value.trim();
    if (!message || send.disabled) return;
    addMessage("user", message);
    prompt.value = "";
    setBusy(true, `${provider.options[provider.selectedIndex].text} is drafting`);
    try {
      const response = await fetch("/api/authoring/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.value, message, history, ...(currentYaml ? { currentYaml } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The authoring agent could not produce a valid workflow");
      history.push({ role: "user", text: message }, { role: "assistant", text: result.reply });
      if (history.length > 12) history.splice(0, history.length - 12);
      currentYaml = result.yaml;
      currentName = result.definition.name;
      exportButton.disabled = false;
      const answer = addMessage("assistant", result.reply, provider.options[provider.selectedIndex].text);
      const source = document.createElement("details");
      source.className = "authoring-yaml";
      const summary = document.createElement("summary");
      summary.textContent = "View validated YAML";
      const yaml = document.createElement("pre");
      yaml.textContent = result.yaml;
      source.append(summary, yaml);
      answer.append(source);
      window.StewardConsole.showAuthoringDraft(result);
      validatedStatus = `${result.definition.nodes.length} nodes · validated`;
      setBusy(false, validatedStatus);
    } catch (error) {
      addMessage("assistant", error instanceof Error ? error.message : String(error), "Validation stopped");
      prompt.value = message;
      setBusy(false, "Needs revision");
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  exportButton.addEventListener("click", exportYaml);
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  });
  window.addEventListener("workspacechange", (event) => {
    if (event.detail?.mode === "author") requestAnimationFrame(() => prompt.focus());
  });
})();
