(function (root) {
  "use strict";

  // Presentation for the explicit V1 example format. Ambiguous prose stays text.
  // The question and submitted answer remain unchanged in the runtime contract.
  function parseChoiceQuestion(source) {
    if (typeof source !== "string") return null;
    const footer = /\s+Reply\s+([A-Z](?:,\s*[A-Z])+),\s*or your own answer\.?\s*$/.exec(source);
    if (!footer) return null;
    const values = footer[1].split(/,\s*/);
    if (values.length < 2 || values.length > 6
      || values.some((value, index) => value !== String.fromCharCode(65 + index))) return null;
    const body = source.slice(0, footer.index).trim();
    const start = /^([\s\S]+?\?)\s+(A\)\s+[\s\S]+)$/.exec(body);
    if (!start) return null;
    const parts = start[2].split(/;\s*(?=[A-Z]\)\s)/);
    if (parts.length !== values.length) return null;
    const options = parts.map((part, index) => {
      const match = /^([A-Z])\)\s+([\s\S]+)$/.exec(part.trim());
      if (!match || match[1] !== values[index] || !match[2].trim()) return null;
      // Extra inline labels are ambiguous; never silently hide part of a question.
      if (/(?:^|\s)[A-Z]\)\s/.test(match[2])) return null;
      return { value: match[1], label: match[2].trim() };
    });
    if (options.some((option) => option === null)) return null;
    return { question: start[1].trim(), options };
  }

  function resolveAnswer(parsed, draft) {
    if (!parsed || draft.choice === "__custom__") return draft.text.trim();
    return parsed.options.some((option) => option.value === draft.choice) ? draft.choice : "";
  }

  function createPanel(request, draft, onSubmit) {
    const parsed = parseChoiceQuestion(request.question);
    const form = document.createElement("form");
    form.className = "human-input-panel";
    const heading = document.createElement("strong");
    heading.textContent = parsed ? "Choose an answer" : "Agent question";
    const fields = document.createElement("fieldset");
    fields.className = "human-answer-fields";
    const legend = document.createElement("legend");
    legend.textContent = parsed?.question ?? request.question;
    fields.append(legend);

    const custom = document.createElement("label");
    custom.className = "human-custom-answer";
    const customLabel = document.createElement("span");
    customLabel.textContent = "Your answer";
    const answer = document.createElement("textarea");
    answer.name = "answer";
    answer.rows = 3;
    answer.value = draft.text;
    answer.placeholder = parsed ? "Write your own answer…" : "Type your answer…";
    custom.append(customLabel, answer);

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "recovery-button";
    function update() {
      const customActive = !parsed || draft.choice === "__custom__";
      custom.hidden = !customActive;
      answer.disabled = !customActive;
      answer.required = customActive;
      fields.disabled = draft.status !== "idle";
      button.disabled = draft.status !== "idle" || !resolveAnswer(parsed, draft);
      button.textContent = draft.status === "submitting" ? "Submitting…"
        : draft.status === "accepted" ? "Answer submitted" : "Submit answer";
    }
    if (parsed) {
      const choices = document.createElement("div");
      choices.className = "human-choices";
      [...parsed.options, { value: "__custom__", label: "Write my own answer" }].forEach((option) => {
        const label = document.createElement("label");
        label.className = "human-choice";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "choice";
        radio.value = option.value;
        radio.required = true;
        radio.checked = draft.choice === option.value;
        const caption = document.createElement("span");
        caption.textContent = option.value === "__custom__" ? option.label : `${option.value}) ${option.label}`;
        radio.addEventListener("change", () => {
          draft.choice = radio.value;
          update();
          if (draft.choice === "__custom__") answer.focus();
        });
        label.append(radio, caption);
        choices.append(label);
      });
      fields.append(choices);
    }
    answer.addEventListener("input", () => { draft.text = answer.value; update(); });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = resolveAnswer(parsed, draft);
      if (draft.status === "idle" && value && form.reportValidity()) onSubmit(value);
    });
    fields.append(custom);
    form.append(heading, fields, button);
    update();
    return form;
  }

  const api = { parseChoiceQuestion, resolveAnswer, createPanel };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkflowHumanInput = api;
})(typeof window === "undefined" ? globalThis : window);
