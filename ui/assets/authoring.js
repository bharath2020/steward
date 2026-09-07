(function () {
  "use strict";

  const form = document.getElementById("authoring-form");
  const prompt = document.getElementById("authoring-prompt");
  const provider = document.getElementById("authoring-provider");
  const send = document.getElementById("authoring-send");
  const messages = document.getElementById("authoring-messages");
  const status = document.getElementById("authoring-status");
  const history = [];
  let currentYaml = null;

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
      setBusy(false, `${result.definition.nodes.length} nodes · validated`);
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
