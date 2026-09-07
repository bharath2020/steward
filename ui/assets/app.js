const SVG = "http://www.w3.org/2000/svg";
const ui = Object.fromEntries([
  "graph-shell", "graph-fit", "graph-zoom-in", "graph-zoom-out", "graph-zoom-reset",
  "connection", "summary-completed", "summary-wave", "summary-elapsed", "mode", "pace", "run-again",
  "run-count", "run-list", "graph-title", "workflow-file", "definition-hash", "graph", "empty-state",
  "inspector-title", "inspector-status", "inspector-content", "event-count", "durable-path", "timeline", "toast",
  "workspace-observe", "workspace-author",
  "authoring-node-detail", "authoring-node-title", "authoring-node-kind", "authoring-node-content", "authoring-node-close",
].map((id) => [id, document.getElementById(id)]));

let current = null;
let selectedRunId = null;
let selectedNodeId = null;
let stream = null;
let lastEventCount = 0;
let toastTimer = null;
let renderedGraphKey = null;
let renderedTimelineRunId = null;
let renderedTimelineEventIds = [];
let inspectorSignature = null;
const humanDrafts = new Map();
const graphNodes = new Map();
const graphEdges = [];
const graphLoops = new Map();
let graphGeometry = null;
let graphZoomMode = "auto";
let graphScale = 1;
let workspaceMode = "observe";
let authoringDraft = null;
const graphMeasureContext = document.createElement("canvas").getContext("2d");

function graphTextMeasure(className) {
  const probe = svg("text", { class: className, visibility: "hidden" });
  ui.graph.append(probe);
  const style = getComputedStyle(probe);
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const spacing = parseFloat(style.letterSpacing) || 0;
  const uppercase = style.textTransform === "uppercase";
  probe.remove();
  return (value) => {
    graphMeasureContext.font = font;
    const source = uppercase ? String(value).toUpperCase() : String(value);
    return graphMeasureContext.measureText(source).width + Math.max(0, [...source].length - 1) * spacing;
  };
}

function fitGraphText(element, value, width, measure) {
  const source = String(value ?? "");
  element.textContent = WorkflowGraphLayout.fitText(source, width, measure);
  if (element.textContent !== source) element.append(text(svg("title"), source));
}

function sizeGraph() {
  if (!graphGeometry?.width || !graphGeometry?.height) return;
  const shell = ui["graph-shell"];
  const fit = Math.min(1, Math.max(1, shell.clientWidth - 24) / graphGeometry.width,
    Math.max(1, shell.clientHeight - 24) / graphGeometry.height);
  if (graphZoomMode === "fit") graphScale = fit;
  else if (graphZoomMode === "auto") graphScale = Math.max(0.8, fit);
  const width = graphGeometry.width * graphScale;
  const height = graphGeometry.height * graphScale;
  ui.graph.style.width = `${width}px`;
  ui.graph.style.height = `${height}px`;
  ui.graph.style.marginLeft = `${Math.max(12, (shell.clientWidth - width) / 2)}px`;
  ui.graph.style.marginTop = `${Math.max(12, (shell.clientHeight - height) / 2)}px`;
  text(ui["graph-zoom-reset"], `${Math.round(graphScale * 100)}%`);
  ui["graph-zoom-in"].disabled = graphScale >= 1.6;
  ui["graph-zoom-out"].disabled = graphScale <= 0.3;
}

function zoomGraph(change) {
  graphZoomMode = "manual";
  graphScale = Math.max(0.3, Math.min(1.6, Math.round((graphScale + change) * 10) / 10));
  sizeGraph();
}

function svg(name, attributes = {}) {
  const element = document.createElementNS(SVG, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function text(element, value) {
  element.textContent = value ?? "—";
  return element;
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function elapsed(startedAt, completedAt) {
  if (!startedAt) return "—";
  const milliseconds = Math.max(0, new Date(completedAt ?? Date.now()).getTime() - new Date(startedAt).getTime());
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function shortId(value) {
  return value?.split("-").slice(-2).join("-") ?? "—";
}

function fileName(value) {
  return value?.split("/").pop() ?? "—";
}

const { definitionNode, scopeInstances, predicateLabel, loopLabel } = WorkflowGraphLayout;

function showToast(message) {
  text(ui.toast, message);
  ui.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("visible"), 2600);
}

function renderRuns(runs = []) {
  text(ui["run-count"], runs.length);
  const existing = new Map(
    [...ui["run-list"].children].map((button) => [button.dataset.runId, button]),
  );
  const activeIds = new Set(runs.map((run) => run.runId));
  existing.forEach((button, runId) => {
    if (!activeIds.has(runId)) button.remove();
  });
  runs.forEach((run) => {
    let button = existing.get(run.runId);
    if (!button) {
      button = document.createElement("button");
      button.dataset.runId = run.runId;
      const top = document.createElement("span");
      top.className = "run-item-top";
      top.append(document.createElement("strong"), document.createElement("i"));
      button.append(top, document.createElement("small"));
      button.addEventListener("click", () => {
        selectedRunId = button.dataset.runId;
        selectedNodeId = null;
        inspectorSignature = null;
        connect(button.dataset.runId);
      });
    }
    button.className = `run-item ${run.runId === current?.run?.runId ? "selected" : ""}`;
    text(button.querySelector("strong"), shortId(run.runId));
    const dot = button.querySelector("i");
    dot.className = `run-item-status ${run.status}`;
    text(button.querySelector("small"), `${run.completedCount}/${run.totalCount} · ${run.mode} · ${formatTime(run.updatedAt)}`);
    ui["run-list"].append(button);
  });
}

function renderGraph(definition, run) {
  if (!definition || !run) {
    if (renderedGraphKey !== null) ui.graph.replaceChildren();
    renderedGraphKey = null;
    graphGeometry = null;
    graphNodes.clear();
    graphEdges.length = 0;
    graphLoops.clear();
    ui["empty-state"].hidden = false;
    return;
  }
  ui["empty-state"].hidden = true;
  const graphKey = `${run.runId}:${definition.definitionHash}`;
  if (renderedGraphKey === graphKey) {
    updateGraph(definition, run);
    return;
  }

  ui.graph.replaceChildren();
  graphNodes.clear();
  graphEdges.length = 0;
  graphLoops.clear();
  renderedGraphKey = graphKey;
  const measureTitle = graphTextMeasure("node-title");
  const measureSubtitle = graphTextMeasure("node-subtitle");
  const measureMeta = graphTextMeasure("node-subtitle node-meta");
  const measureGroup = graphTextMeasure("group-label");
  const measureLoop = graphTextMeasure("loop-label");
  graphGeometry = WorkflowGraphLayout.layoutGraph(definition.nodes, measureTitle);
  const { width, height, boxes: positions } = graphGeometry;
  ui.graph.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const defs = svg("defs");
  const marker = svg("marker", { id: "arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 5, markerHeight: 5, orient: "auto" });
  marker.append(svg("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "var(--line-bright)" }));
  const loopMarker = svg("marker", { id: "loop-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" });
  loopMarker.append(svg("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "var(--accent)" }));
  defs.append(marker, loopMarker);
  ui.graph.append(defs);

  definition.groups.forEach((group) => {
    const members = definition.nodes.filter((node) => node.group === group.id);
    if (!members.length) return;
    const memberPositions = members.map((node) => positions[node.id]);
    const left = Math.min(...memberPositions.map((position) => position.x)) - 13;
    const top = Math.min(...memberPositions.map((position) => position.y)) - 32;
    const right = Math.max(...memberPositions.map((position) => position.x + position.width)) + 13;
    const bottom = Math.max(...members.map((node) => positions[node.id].y + positions[node.id].visualHeight)) + 14;
    const hasLoop = members.some((node) => node.loop);
    ui.graph.append(svg("rect", { class: `group-surface ${hasLoop ? "has-loop" : ""}`, x: left, y: top, width: right - left, height: bottom - top, rx: 3 }));
    const groupLabel = svg("text", { class: "group-label", x: left + 8, y: top + 19 });
    fitGraphText(groupLabel, `${group.title} · max ${group.max_parallelism ?? definition.defaults.max_parallelism}`, right - left - 16, measureGroup);
    ui.graph.append(groupLabel);
  });

  definition.nodes.forEach((node) => {
    node.needs.forEach((dependency) => {
      const source = positions[dependency];
      const target = positions[node.id];
      const startX = source.x + source.width;
      const startY = source.y + source.height / 2;
      const endX = target.x;
      const endY = target.y + target.height / 2;
      const bend = (endX - startX) * 0.48;
      const path = svg("path", {
        d: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
        class: "edge",
        "marker-end": "url(#arrow)",
      });
      graphEdges.push({ element: path, sourceId: dependency, targetId: node.id });
      ui.graph.append(path);
    });
  });

  definition.nodes.filter((node) => node.loop).forEach((node) => {
    const position = positions[node.id];
    const state = run.nodes[node.id];
    const startX = position.x + position.width - 28;
    const endX = position.x + 28;
    const startY = position.y + position.height;
    const returnY = startY + 35;
    const circuit = svg("g", { class: `loop-circuit ${state.status}` });
    const path = svg("path", {
      d: `M ${startX} ${startY} C ${startX} ${returnY}, ${endX} ${returnY}, ${endX} ${startY}`,
      class: "loop-edge",
      "marker-end": "url(#loop-arrow)",
    });
    const label = text(svg("text", {
      class: "loop-label",
      x: position.x + position.width / 2,
      y: startY + 30,
      "text-anchor": "middle",
    }), loopLabel(node, state));
    circuit.append(path, label);
    graphLoops.set(node.id, { element: circuit, label, width: position.width - 4, measure: measureLoop });
    ui.graph.append(circuit);
  });

  definition.nodes.forEach((node, index) => {
    const position = positions[node.id];
    const state = run.nodes[node.id];
    const nodeGroup = svg("g", {
      class: `node ${state.status} ${selectedNodeId === node.id ? "selected" : ""}`,
      transform: `translate(${position.x} ${position.y})`,
      tabindex: 0,
      role: "button",
      "aria-label": `${node.title}, ${state.status}`,
      style: `animation-delay:${Math.min(index * 22, 160)}ms`,
    });
    nodeGroup.append(text(svg("title"), node.title));
    nodeGroup.append(svg("rect", { class: "node-surface", width: position.width, height: position.height, rx: 3 }));
    nodeGroup.append(svg("circle", { class: "node-status-dot", cx: 17, cy: 21, r: 4.5 }));
    const titleNode = svg("text", { class: "node-title" });
    position.titleLines.forEach((line, index) => titleNode.append(
      text(svg("tspan", { x: 32, y: 27 + index * 20 }), line),
    ));
    const subtitle = svg("text", { class: "node-subtitle", x: 16, y: position.phaseY });
    const meta = svg("text", { class: "node-subtitle node-meta", x: 16, y: position.metaY });
    nodeGroup.append(titleNode, subtitle, meta);
    if (node.needs.length > 1) nodeGroup.append(text(svg("text", {
      class: "join-mark", x: position.width - 16, y: position.metaY, "text-anchor": "end",
    }), `JOIN ${node.needs.length}`));
    const select = () => {
      selectedNodeId = node.id;
      if (run.status === "draft") {
        updateGraph(definition, run);
        renderAuthoringNodeDetail(definition, node.id);
      } else render(current);
    };
    nodeGroup.addEventListener("click", select);
    nodeGroup.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
    });
    graphNodes.set(node.id, { element: nodeGroup, subtitle, meta, width: position.width,
      measureSubtitle, measureMeta, metaWidth: position.width - 32 - (node.needs.length > 1 ? 68 : 0) });
    ui.graph.append(nodeGroup);
  });
  updateGraph(definition, run);
  sizeGraph();
}

function updateGraph(definition, run) {
  graphEdges.forEach(({ element, sourceId, targetId }) => {
    const sourceState = run.nodes[sourceId];
    const targetState = run.nodes[targetId];
    element.setAttribute(
      "class",
      `edge ${sourceState.status === "completed" ? "committed" : ""} ${targetState.status === "running" ? "flowing" : ""}`,
    );
  });
  definition.nodes.filter((node) => node.loop).forEach((node) => {
    const rendered = graphLoops.get(node.id);
    if (!rendered) return;
    const state = run.nodes[node.id];
    rendered.element.setAttribute("class", `loop-circuit ${state.status}`);
    fitGraphText(rendered.label, loopLabel(node, state), rendered.width, rendered.measure);
  });
  definition.nodes.forEach((node) => {
    const rendered = graphNodes.get(node.id);
    if (!rendered) return;
    const state = run.nodes[node.id];
    rendered.element.setAttribute("class", `node ${state.status} ${selectedNodeId === node.id ? "selected" : ""}`);
    rendered.element.setAttribute("aria-label", `${node.title}, ${state.status}`);
    fitGraphText(rendered.subtitle, state.phase, rendered.width - 32, rendered.measureSubtitle);
    const provider = node.kind === "scope" ? "Scope" : node.kind === "human" ? "Human input" : state.agent === "codex" ? "Codex" : "Simulated agent";
    const metaValue = state.durationMs ? `${provider} · ${(state.durationMs / 1000).toFixed(1)}s` : provider;
    fitGraphText(rendered.meta, metaValue, rendered.metaWidth, rendered.measureMeta);
  });
}

function section(title, content) {
  const container = document.createElement("section");
  container.className = "inspect-section";
  container.append(text(document.createElement("h3"), title), content);
  return container;
}

function jsonBlock(value, output = false) {
  const pre = document.createElement("pre");
  pre.className = `json-block ${output ? "output" : ""}`;
  pre.textContent = value === undefined ? "Not committed yet" : JSON.stringify(value, null, 2);
  return pre;
}

function keyValueList(entries, className) {
  const list = document.createElement("ul");
  list.className = className;
  entries.forEach(([key, value]) => {
    const item = document.createElement("li");
    item.append(text(document.createElement("b"), key), text(document.createElement("code"), String(value)));
    list.append(item);
  });
  return list;
}

function hideAuthoringNodeDetail() {
  ui["authoring-node-detail"].hidden = true;
  ui["authoring-node-content"].replaceChildren();
}

function renderAuthoringNodeDetail(definition, nodeId) {
  const node = definitionNode(definition, nodeId);
  if (!node) {
    hideAuthoringNodeDetail();
    return;
  }
  const group = definition.groups.find((item) => item.id === node.group);
  const details = document.createElement("dl");
  details.className = "inspect-grid";
  [
    ["Node", node.id],
    ["Type", node.kind === "scope" ? "Scope" : node.kind === "human" ? "Human input" : node.agent],
    ["Group", group?.title ?? "—"],
    ["Needs", node.needs.join(", ") || "start"],
    ["Queue", node.for_each ? `${node.for_each.items} → ${node.for_each.as} · max ${node.for_each.max_parallelism}` : "—"],
  ].forEach(([key, value]) => {
    details.append(text(document.createElement("dt"), key), text(document.createElement("dd"), value));
  });
  const assignment = text(
    document.createElement("p"),
    node.kind === "human" ? String(node.inputs.question) : node.prompt,
  );
  assignment.className = "authoring-node-prompt";
  const inputs = Object.entries(node.inputs);
  const outputs = Object.entries(node.exports ?? node.outputs);
  ui["authoring-node-content"].replaceChildren(
    section("Configuration", details),
    ...(node.kind === "scope" ? [section("Scope steps", definitionChildren(definition, node, nodeId))] : [section(node.kind === "human" ? "Question" : "Prompt", assignment)]),
    ...(inputs.length ? [section("Input bindings", keyValueList(inputs, "binding-list"))] : []),
    section("Output variables", keyValueList(outputs, "output-list")),
  );
  if (nodeId.includes(".") && node.kind !== "scope") {
    ui["authoring-node-content"].append(definitionChildren(definition, node, nodeId));
  }
  text(ui["authoring-node-title"], node.title);
  text(ui["authoring-node-kind"], node.kind === "scope" ? "Scope" : node.kind === "human" ? "Human gate" : `${node.agent} agent`);
  ui["authoring-node-detail"].hidden = false;
}

function agentMessageStream(messages = [], isLegacy = false) {
  const container = document.createElement("div");
  container.className = "agent-stream";
  container.append(text(document.createElement("div"), "Filtered JSONL · human messages only"));
  container.firstElementChild.className = "agent-stream-source";
  if (!messages.length) {
    const empty = text(
      document.createElement("p"),
      isLegacy ? "No agent messages were recorded for this earlier run." : "Waiting for the agent’s first message…",
    );
    empty.className = "agent-stream-empty";
    container.append(empty);
    return container;
  }
  messages.forEach((message) => {
    const item = document.createElement("article");
    item.className = "agent-message";
    const iteration = message.iteration > 1 ? ` · iteration ${message.iteration}` : "";
    const meta = text(
      document.createElement("span"),
      `Message ${String(message.seq).padStart(2, "0")} · ${formatTime(message.at)}${iteration}`,
    );
    meta.className = "agent-message-meta";
    item.append(meta, text(document.createElement("p"), message.text));
    container.append(item);
  });
  return container;
}

async function submitRecoveryAction(requestId, action, container) {
  const buttons = [...container.querySelectorAll("button")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(current.run.runId)}/recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, action }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Recovery command was rejected");
    showToast(action === "retry_same_session"
      ? "Resuming recorded session"
      : action === "retry_fresh_session"
        ? "Starting a fresh session"
        : "Workflow abort accepted");
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    showToast(String(error));
  }
}

function recoveryPanel(recovery) {
  const container = document.createElement("div");
  container.className = "recovery-panel";
  const heading = text(document.createElement("strong"), "Agent recovery required");
  const detail = text(document.createElement("p"), recovery.failure.message);
  const meta = text(document.createElement("small"), `${recovery.failure.kind.replaceAll("_", " ")} · recovery ${recovery.recoveryCycle}`);
  const actions = document.createElement("div");
  actions.className = "recovery-actions";
  const choices = [
    ...(recovery.canResumeSession ? [["Resume session", "retry_same_session"]] : []),
    ["Fresh session", "retry_fresh_session"],
    ["Abort workflow", "abort_workflow"],
  ];
  choices.forEach(([label, action]) => {
    const button = text(document.createElement("button"), label);
    button.className = action === "abort_workflow" ? "recovery-button danger" : "recovery-button";
    button.addEventListener("click", () => submitRecoveryAction(recovery.requestId, action, container));
    actions.append(button);
  });
  container.append(heading, detail, meta, actions);
  return container;
}

function refreshHumanPanel(runId, requestId) {
  if (current?.run?.runId !== runId
    || current.run.nodes[selectedNodeId]?.humanRequest?.requestId !== requestId) return;
  inspectorSignature = null;
  renderInspector(current);
}

async function submitHumanInput(runId, requestId, answer, draft) {
  if (draft.status !== "idle") return;
  draft.status = "submitting";
  refreshHumanPanel(runId, requestId);
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, answer }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Answer was rejected");
    draft.status = "accepted";
    showToast("Answer accepted and committed");
  } catch (error) {
    draft.status = "idle";
    showToast(String(error));
  }
  refreshHumanPanel(runId, requestId);
}

function humanInputPanel(runId, request) {
  const key = JSON.stringify([runId, request.requestId]);
  let draft = humanDrafts.get(key);
  if (!draft || draft.question !== request.question) {
    draft = { question: request.question, choice: "", text: "", status: "idle" };
    humanDrafts.set(key, draft);
  }
  return WorkflowHumanInput.createPanel(request, draft,
    (answer) => submitHumanInput(runId, request.requestId, answer, draft));
}

function definitionChildren(definition, node, path) {
  const list = document.createElement("div");
  list.className = "scope-steps";
  for (const child of node.nodes ?? []) {
    const button = text(document.createElement("button"), `${child.title} · ${child.kind}`);
    button.type = "button";
    button.addEventListener("click", () => renderAuthoringNodeDetail(definition, `${path}.${child.id}`));
    list.append(button);
  }
  if (path.includes(".")) {
    const back = text(document.createElement("button"), "Back to parent scope");
    back.type = "button";
    back.className = "scope-back";
    back.addEventListener("click", () => renderAuthoringNodeDetail(definition, path.split(".").slice(0, -1).join(".")));
    list.append(back);
  }
  return list;
}

function executionChildren(run, parentId) {
  const list = document.createElement("div");
  list.className = "scope-steps";
  for (const child of scopeInstances(run, parentId)) {
    const button = text(document.createElement("button"), `${child.title} · ${child.status}\n${child.id}`);
    button.type = "button";
    button.addEventListener("click", () => { selectedNodeId = child.id; render(current); });
    list.append(button);
  }
  if (!list.childElementCount) list.append(text(document.createElement("p"), "No child instances have started yet."));
  return list;
}

function renderInspector(snapshot) {
  const { definition, run, initialInput } = snapshot;
  const nextSignature = JSON.stringify({
    runId: run?.runId,
    nodeId: selectedNodeId,
    runStatus: run?.status,
    node: selectedNodeId ? run?.nodes?.[selectedNodeId] : undefined,
    children: selectedNodeId ? scopeInstances(run, selectedNodeId) : undefined,
    messages: selectedNodeId ? snapshot.agentMessages?.[selectedNodeId] : undefined,
    initialInput: selectedNodeId ? undefined : initialInput,
  });
  if (nextSignature === inspectorSignature) return;
  inspectorSignature = nextSignature;
  ui["inspector-content"].replaceChildren();
  if (!definition || !run) {
    text(ui["inspector-title"], "Run contract");
    text(ui["inspector-status"], "—");
    ui["inspector-content"].append(text(document.createElement("p"), "Select a node to inspect its prompt, variable bindings, and committed output."));
    return;
  }
  const node = definitionNode(definition, selectedNodeId);
  if (!node) {
    text(ui["inspector-title"], "Run contract");
    text(ui["inspector-status"], run.status);
    const details = document.createElement("dl");
    details.className = "inspect-grid";
    [["Execution", run.runId], ["Temporal", run.temporalRunId], ["Mode", run.mode], ["Hash", definition.definitionHash.slice(0, 16)], ["Started", formatTime(run.startedAt)]].forEach(([key, value]) => {
      details.append(text(document.createElement("dt"), key), text(document.createElement("dd"), value));
    });
    ui["inspector-content"].append(section("Identity", details), section("Initial input", jsonBlock(initialInput)));
    return;
  }
  const state = run.nodes[selectedNodeId];
  if (!state) return;
  if (state.parentId) {
    const back = text(document.createElement("button"), "Back to parent scope");
    back.type = "button";
    back.className = "scope-back";
    back.addEventListener("click", () => { selectedNodeId = state.parentId; render(current); });
    ui["inspector-content"].append(back);
  }
  const pendingRecoveries = (state.recoveryRequests ?? []).filter((request) => request.status === "waiting");
  text(ui["inspector-title"], node.title);
  text(ui["inspector-status"], state.status);
  const details = document.createElement("dl");
  details.className = "inspect-grid";
  const group = definition.groups.find((item) => item.id === node.group);
  [["Node", state.id], ["Parent scope", state.parentId ?? "—"], ["Group", group?.title ?? "—"], ["Configured", node.kind === "scope" ? "scope" : node.kind === "human" ? "human input" : node.agent], ["Executing", state.agent], ["Needs", (state.needs ?? node.needs).join(", ") || "start"], ["Attempt", node.kind === "scope" ? "—" : state.attempt ?? "—"], ["Recovery", pendingRecoveries.length || "—"], ["Iteration", node.loop ? `${state.iteration ?? 0} / ${node.loop.max_iterations}` : "—"], ["Queue", node.for_each ? `${state.completedItems ?? 0} / ${state.totalItems ?? "?"} · max ${node.for_each.max_parallelism}` : "—"], ["Duration", state.durationMs ? `${(state.durationMs / 1000).toFixed(1)}s` : "—"]].forEach(([key, value]) => {
    details.append(text(document.createElement("dt"), key), text(document.createElement("dd"), value));
  });
  const prompt = text(document.createElement("p"), node.prompt);
  const bindings = keyValueList(Object.entries(node.inputs), "binding-list");
  const outputs = keyValueList(Object.entries(node.exports ?? node.outputs), "output-list");
  const messages = snapshot.agentMessages?.[selectedNodeId] ?? [];
  ui["inspector-content"].append(
    section("Execution", details),
    ...pendingRecoveries.map((recovery, index) =>
      section(pendingRecoveries.length === 1 ? "Recovery" : `Recovery ${index + 1}`, recoveryPanel(recovery))),
    ...(state.status === "awaiting_input" && state.humanRequest
      ? [section("Your input", humanInputPanel(run.runId, state.humanRequest))]
      : []),
    ...(node.kind !== "agent" ? [] : [section("Agent message stream", agentMessageStream(messages, snapshot.agentMessages === undefined))]),
    ...(node.kind === "scope" ? [section("Scope steps", executionChildren(run, selectedNodeId))] : [section(node.kind === "human" ? "Human gate" : "Prompt", prompt)]),
    section("Input bindings", bindings),
    section("Output variables", outputs),
    ...(node.loop ? [section("Loop gate", keyValueList([
      ["until", predicateLabel(node.loop.until)],
      ["outcome", state.loopOutcome ?? "unknown"],
      ...(node.kind === "scope" ? [["agent sessions", node.loop.agent_sessions ?? "fresh"], ["initial state", JSON.stringify(node.loop.initial)], ["next state", JSON.stringify(node.loop.next)]] : [["carry as", node.loop.carry_as]]),
      ["exhaustion", node.loop.on_exhaustion],
    ], "binding-list"))] : []),
    ...(node.for_each ? [section("Queue", keyValueList([
      ["items", node.for_each.items],
      ["item as", node.for_each.as],
      ["max parallelism", node.for_each.max_parallelism],
    ], "binding-list"))] : []),
    section("Resolved input", jsonBlock(state.input)),
    section("Committed output", jsonBlock(state.output, true)),
  );
}

function appendTimelineEvent(event, animate) {
  const item = document.createElement("li");
  const className = event.type.includes("failed")
    ? "failed"
    : event.type.startsWith("recovery.")
      ? "recovery"
      : event.type.includes("started") || event.type === "node.phase"
        ? "running"
        : "";
  item.className = `timeline-event ${className} ${animate ? "new" : ""}`;
  item.append(
    text(document.createElement("time"), `${String(event.seq).padStart(2, "0")} · ${formatTime(event.at)}`),
    text(document.createElement("strong"), event.nodeId ?? event.type.replace(".", " ")),
    text(document.createElement("p"), event.message),
  );
  if (event.nodeId) item.addEventListener("click", () => { selectedNodeId = event.nodeId; render(current); });
  ui.timeline.append(item);
}

function renderTimeline(events = [], runId) {
  const stillAppendOnly = renderedTimelineRunId === runId
    && renderedTimelineEventIds.every((id, index) => events[index]?.id === id);
  const additions = stillAppendOnly ? events.slice(renderedTimelineEventIds.length) : events;
  const shouldFollow = ui.timeline.scrollWidth - ui.timeline.clientWidth - ui.timeline.scrollLeft < 80 || additions.length > 0;
  text(ui["event-count"], `${events.length} event${events.length === 1 ? "" : "s"}`);
  if (!stillAppendOnly) ui.timeline.replaceChildren();
  additions.forEach((event) => appendTimelineEvent(event, stillAppendOnly));
  renderedTimelineRunId = runId;
  renderedTimelineEventIds = events.map((event) => event.id);
  lastEventCount = events.length;
  if (shouldFollow) {
    const follow = () => {
      if (document.documentElement.dataset.layout === "review") ui.timeline.scrollTop = ui.timeline.scrollHeight;
      else ui.timeline.scrollLeft = ui.timeline.scrollWidth;
    };
    follow();
    requestAnimationFrame(follow);
  }
}

function render(snapshot) {
  current = snapshot;
  renderRuns(snapshot?.runs);
  if (workspaceMode === "author") return;
  const run = snapshot?.run;
  const definition = snapshot?.definition;
  if (!run) {
    renderGraph(null, null);
    return;
  }
  if (!selectedNodeId || !run.nodes[selectedNodeId]) {
    selectedNodeId = Object.values(run.nodes).find((node) => ["awaiting_input", "awaiting_recovery"].includes(node.status))?.id
      ?? Object.values(run.nodes).find((node) => node.status === "running")?.id ?? null;
  }
  text(ui["summary-completed"], `${run.completedCount} / ${run.totalCount}`);
  text(ui["summary-wave"], run.currentWave || "—");
  text(ui["summary-elapsed"], elapsed(run.startedAt, run.completedAt));
  text(ui["graph-title"], definition.name);
  text(ui["workflow-file"], fileName(definition.sourcePath));
  text(ui["definition-hash"], definition.definitionHash.slice(0, 12));
  text(ui["durable-path"], snapshot.durablePath);
  renderGraph(definition, run);
  renderInspector(snapshot);
  renderTimeline(snapshot.events, run.runId);
}

function draftRun(definition) {
  return {
    runId: `draft:${definition.definitionHash}`,
    status: "draft",
    completedCount: 0,
    totalCount: definition.nodes.length,
    currentWave: 0,
    nodes: Object.fromEntries(definition.nodes.map((node) => [node.id, {
      id: node.id,
      status: "pending",
      phase: node.kind === "human" ? "Human decision" : "Ready to start",
      agent: node.agent,
      iteration: 0,
      iterationCount: 0,
    }])),
  };
}

function showAuthoringDraft(draft) {
  authoringDraft = draft;
  if (workspaceMode !== "author") return;
  selectedNodeId = null;
  hideAuthoringNodeDetail();
  renderedGraphKey = null;
  text(ui["graph-title"], draft.definition.name);
  text(ui["workflow-file"], "generated-workflow.yaml");
  text(ui["definition-hash"], draft.definition.definitionHash.slice(0, 12));
  text(ui["summary-completed"], `0 / ${draft.definition.nodes.length}`);
  text(ui["summary-wave"], "draft");
  text(ui["summary-elapsed"], "—");
  renderGraph(draft.definition, draftRun(draft.definition));
}

function setWorkspaceMode(mode) {
  workspaceMode = mode === "author" ? "author" : "observe";
  document.documentElement.dataset.workspace = workspaceMode;
  ui["workspace-observe"].setAttribute("aria-pressed", String(workspaceMode === "observe"));
  ui["workspace-author"].setAttribute("aria-pressed", String(workspaceMode === "author"));
  if (workspaceMode === "author") {
    if (authoringDraft) showAuthoringDraft(authoringDraft);
    else {
      hideAuthoringNodeDetail();
      renderGraph(null, null);
      text(ui["graph-title"], "Describe a workflow to begin");
      text(ui["workflow-file"], "generated-workflow.yaml");
      text(ui["definition-hash"], "not validated");
    }
  } else {
    hideAuthoringNodeDetail();
    render(current);
  }
  requestAnimationFrame(sizeGraph);
  window.dispatchEvent(new CustomEvent("workspacechange", { detail: { mode: workspaceMode } }));
}

ui["workspace-observe"].addEventListener("click", () => setWorkspaceMode("observe"));
ui["workspace-author"].addEventListener("click", () => setWorkspaceMode("author"));
ui["authoring-node-close"].addEventListener("click", () => {
  selectedNodeId = null;
  hideAuthoringNodeDetail();
  if (workspaceMode === "author" && authoringDraft) {
    updateGraph(authoringDraft.definition, draftRun(authoringDraft.definition));
  }
});
window.StewardConsole = { showAuthoringDraft, setWorkspaceMode };

function repaintActiveGraph() {
  renderedGraphKey = null;
  if (workspaceMode === "author") {
    if (authoringDraft) renderGraph(authoringDraft.definition, draftRun(authoringDraft.definition));
    else renderGraph(null, null);
    return;
  }
  if (current?.run) renderGraph(current.definition, current.run);
}

function setConnection(status) {
  ui.connection.className = `connection ${status}`;
  ui.connection.innerHTML = "<i></i>";
  ui.connection.append(document.createTextNode(status === "live" ? " Live" : status === "offline" ? " Reconnecting" : " Connecting"));
}

function connect(runId) {
  stream?.close();
  setConnection("connecting");
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  stream = new EventSource(`/api/stream${query}`);
  stream.addEventListener("open", () => setConnection("live"));
  stream.addEventListener("snapshot", (event) => render(JSON.parse(event.data)));
  stream.addEventListener("error", () => setConnection("offline"));
}

async function startRun() {
  if (ui["run-again"].disabled) return;
  ui["run-again"].disabled = true;
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: ui.mode.value, delayMs: Number(ui.pace.value) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Could not start run");
    selectedRunId = result.runId;
    selectedNodeId = null;
    inspectorSignature = null;
    lastEventCount = 0;
    showToast(`Started ${shortId(result.runId)}`);
    connect(result.runId);
  } catch (error) {
    showToast(String(error));
  } finally {
    ui["run-again"].disabled = false;
  }
}

ui["run-again"].addEventListener("click", startRun);
document.addEventListener("keydown", (event) => {
  if (WorkflowAppearance.shouldStartRun(event, document.activeElement, ui["run-again"].disabled)) startRun();
});

window.addEventListener("appearancechange", () => {
  // Repaint SVG markers and surfaces in browsers that cache inherited theme tokens.
  // The inspector stays mounted so unsent answers and focus survive appearance changes.
  repaintActiveGraph();
});

ui["graph-fit"].addEventListener("click", () => {
  graphZoomMode = "fit";
  sizeGraph();
  ui["graph-shell"].scrollTo(0, 0);
});
ui["graph-zoom-in"].addEventListener("click", () => zoomGraph(0.1));
ui["graph-zoom-out"].addEventListener("click", () => zoomGraph(-0.1));
ui["graph-zoom-reset"].addEventListener("click", () => {
  graphZoomMode = "manual";
  graphScale = 1;
  sizeGraph();
});
new ResizeObserver(sizeGraph).observe(ui["graph-shell"]);
document.fonts?.ready.then(() => {
  repaintActiveGraph();
});

connect();
