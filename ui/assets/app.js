const SVG = "http://www.w3.org/2000/svg";
const ui = Object.fromEntries([
  "connection", "summary-completed", "summary-wave", "summary-elapsed", "mode", "pace", "run-again",
  "run-count", "run-list", "graph-title", "workflow-file", "definition-hash", "graph", "empty-state",
  "inspector-title", "inspector-status", "inspector-content", "event-count", "durable-path", "timeline", "toast",
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
const graphNodes = new Map();
const graphEdges = [];
const graphLoops = new Map();

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

function readPath(value, path) {
  return path.split(".").filter(Boolean).reduce((currentValue, segment) => {
    if (!currentValue || typeof currentValue !== "object" || Array.isArray(currentValue)) return undefined;
    return currentValue[segment];
  }, value);
}

function loopConditionMet(loop, output) {
  const actual = readPath(output, loop.until.path);
  const expected = loop.until.value;
  switch (loop.until.operator) {
    case "equals": return actual === expected;
    case "not_equals": return actual !== expected;
    case "greater_than": return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "greater_than_or_equal": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "less_than": return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "less_than_or_equal": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    default: return false;
  }
}

function loopOperator(operator) {
  return ({
    equals: "=",
    not_equals: "≠",
    greater_than: ">",
    greater_than_or_equal: "≥",
    less_than: "<",
    less_than_or_equal: "≤",
  })[operator] ?? operator;
}

function loopLabel(node, state) {
  const current = Math.max(state.iterationCount ?? state.iteration ?? 0, state.status === "pending" ? 0 : 1);
  const maximum = node.loop.max_iterations;
  const field = node.loop.until.path.split(".").pop().replaceAll("_", " ").toUpperCase();
  const condition = `${field} ${loopOperator(node.loop.until.operator)} ${String(node.loop.until.value)}`;
  if (state.status === "running") return `ITERATION ${current} / ${maximum} · ${condition}`;
  if (state.status === "awaiting_recovery") return `PAUSED ${current} / ${maximum} · RECOVERY`;
  if (state.status === "failed") return `${current} / ${maximum} · LIMIT FAILED`;
  if (state.status === "completed") {
    return loopConditionMet(node.loop, state.output)
      ? `${current} / ${maximum} · ${condition} · PASSED`
      : `${current} / ${maximum} · LIMIT ACCEPTED`;
  }
  return `UP TO ${maximum} ITERATIONS · ${condition}`;
}

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

function nodeLayers(nodes) {
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const memo = new Map();
  const depth = (node) => {
    if (memo.has(node.id)) return memo.get(node.id);
    const value = node.needs.length ? 1 + Math.max(...node.needs.map((id) => depth(byId[id]))) : 0;
    memo.set(node.id, value);
    return value;
  };
  const layers = [];
  nodes.forEach((node) => {
    const index = depth(node);
    if (!layers[index]) layers[index] = [];
    layers[index].push(node);
  });
  return layers;
}

function renderGraph(definition, run) {
  if (!definition || !run) {
    if (renderedGraphKey !== null) ui.graph.replaceChildren();
    renderedGraphKey = null;
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
  const layers = nodeLayers(definition.nodes);
  const nodeWidth = 214;
  const nodeHeight = 92;
  const loopSpace = 48;
  const columnGap = 44;
  const rowGap = 32;
  const paddingX = 38;
  const paddingY = 52;
  const visualHeight = (node) => nodeHeight + (node.loop ? loopSpace : 0);
  const layerHeights = layers.map((layer) => layer.reduce((sum, node) => sum + visualHeight(node), 0) + (layer.length - 1) * rowGap);
  const width = Math.max(900, paddingX * 2 + layers.length * nodeWidth + (layers.length - 1) * columnGap);
  const height = Math.max(470, paddingY * 2 + Math.max(...layerHeights));
  ui.graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const positions = {};
  layers.forEach((layer, column) => {
    const blockHeight = layerHeights[column];
    const startY = (height - blockHeight) / 2;
    let offsetY = 0;
    layer.forEach((node, row) => {
      positions[node.id] = { x: paddingX + column * (nodeWidth + columnGap), y: startY + offsetY };
      offsetY += visualHeight(node) + (row < layer.length - 1 ? rowGap : 0);
    });
  });

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
    const right = Math.max(...memberPositions.map((position) => position.x + nodeWidth)) + 13;
    const bottom = Math.max(...members.map((node) => positions[node.id].y + visualHeight(node))) + 14;
    const hasLoop = members.some((node) => node.loop);
    ui.graph.append(svg("rect", { class: `group-surface ${hasLoop ? "has-loop" : ""}`, x: left, y: top, width: right - left, height: bottom - top, rx: 3 }));
    ui.graph.append(text(svg("text", { class: "group-label", x: left + 8, y: top + 19 }), `${group.title} · max ${group.max_parallelism ?? definition.defaults.max_parallelism}`));
  });

  definition.nodes.forEach((node) => {
    node.needs.forEach((dependency) => {
      const source = positions[dependency];
      const target = positions[node.id];
      const startX = source.x + nodeWidth;
      const startY = source.y + nodeHeight / 2;
      const endX = target.x;
      const endY = target.y + nodeHeight / 2;
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
    const startX = position.x + nodeWidth - 28;
    const endX = position.x + 28;
    const startY = position.y + nodeHeight;
    const returnY = startY + 35;
    const circuit = svg("g", { class: `loop-circuit ${state.status}` });
    const path = svg("path", {
      d: `M ${startX} ${startY} C ${startX} ${returnY}, ${endX} ${returnY}, ${endX} ${startY}`,
      class: "loop-edge",
      "marker-end": "url(#loop-arrow)",
    });
    const label = text(svg("text", {
      class: "loop-label",
      x: position.x + nodeWidth / 2,
      y: startY + 30,
      "text-anchor": "middle",
    }), loopLabel(node, state));
    circuit.append(path, label);
    graphLoops.set(node.id, { element: circuit, label });
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
    nodeGroup.append(svg("rect", { class: "node-surface", width: nodeWidth, height: nodeHeight, rx: 2 }));
    nodeGroup.append(svg("circle", { class: "node-status-dot", cx: 17, cy: 21, r: 4.5 }));
    const titleNode = text(svg("text", { class: "node-title", x: 31, y: 27 }), node.title);
    const subtitle = text(svg("text", { class: "node-subtitle", x: 17, y: 57 }), state.phase);
    const logicalGroup = definition.groups.find((item) => item.id === node.group);
    const meta = text(svg("text", { class: "node-subtitle node-meta", x: 17, y: 77 }), `${logicalGroup?.title ?? state.agent} · ${state.status}`);
    if (state.durationMs) meta.textContent = `${logicalGroup?.title ?? state.agent} · ${(state.durationMs / 1000).toFixed(1)}s`;
    nodeGroup.append(titleNode, subtitle, meta);
    if (node.needs.length > 1) nodeGroup.append(text(svg("text", { class: "join-mark", x: nodeWidth - 55, y: 77 }), `JOIN ${node.needs.length}`));
    const select = () => {
      selectedNodeId = node.id;
      render(current);
    };
    nodeGroup.addEventListener("click", select);
    nodeGroup.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") select();
    });
    graphNodes.set(node.id, { element: nodeGroup, subtitle, meta, logicalGroup });
    ui.graph.append(nodeGroup);
  });
  updateGraph(definition, run);
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
    text(rendered.label, loopLabel(node, state));
  });
  definition.nodes.forEach((node) => {
    const rendered = graphNodes.get(node.id);
    if (!rendered) return;
    const state = run.nodes[node.id];
    rendered.element.setAttribute("class", `node ${state.status} ${selectedNodeId === node.id ? "selected" : ""}`);
    rendered.element.setAttribute("aria-label", `${node.title}, ${state.status}`);
    text(rendered.subtitle, state.phase);
    text(
      rendered.meta,
      state.durationMs
        ? `${rendered.logicalGroup?.title ?? state.agent} · ${(state.durationMs / 1000).toFixed(1)}s`
        : `${rendered.logicalGroup?.title ?? state.agent} · ${state.status}`,
    );
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

async function submitHumanInput(requestId, answer, container) {
  const button = container.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(current.run.runId)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, answer }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Answer was rejected");
    showToast("Answer accepted and committed");
  } catch (error) {
    button.disabled = false;
    showToast(String(error));
  }
}

function humanInputPanel(request) {
  const form = document.createElement("form");
  form.className = "human-input-panel";
  const heading = text(document.createElement("strong"), "Agent question");
  const question = text(document.createElement("p"), request.question);
  const answer = document.createElement("textarea");
  answer.name = "answer";
  answer.rows = 4;
  answer.required = true;
  answer.placeholder = "Type your answer…";
  const button = text(document.createElement("button"), "Submit answer");
  button.type = "submit";
  button.className = "recovery-button";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (answer.value.trim()) submitHumanInput(request.requestId, answer.value.trim(), form);
  });
  form.append(heading, question, answer, button);
  return form;
}

function renderInspector(snapshot) {
  const { definition, run, initialInput } = snapshot;
  const nextSignature = JSON.stringify({
    runId: run?.runId,
    nodeId: selectedNodeId,
    runStatus: run?.status,
    node: selectedNodeId ? run?.nodes?.[selectedNodeId] : undefined,
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
  const node = definition.nodes.find((item) => item.id === selectedNodeId);
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
  const state = run.nodes[node.id];
  text(ui["inspector-title"], node.title);
  text(ui["inspector-status"], state.status);
  const details = document.createElement("dl");
  details.className = "inspect-grid";
  const group = definition.groups.find((item) => item.id === node.group);
  [["Node", node.id], ["Group", group?.title ?? "—"], ["Configured", node.kind === "human" ? "human input" : node.agent], ["Executing", state.agent], ["Needs", node.needs.join(", ") || "start"], ["Attempt", state.attempt ?? "—"], ["Recovery", state.recovery?.recoveryCycle ?? "—"], ["Iteration", node.loop ? `${state.iteration ?? 0} / ${node.loop.max_iterations}` : "—"], ["Duration", state.durationMs ? `${(state.durationMs / 1000).toFixed(1)}s` : "—"]].forEach(([key, value]) => {
    details.append(text(document.createElement("dt"), key), text(document.createElement("dd"), value));
  });
  const prompt = text(document.createElement("p"), node.prompt);
  const bindings = keyValueList(Object.entries(node.inputs), "binding-list");
  const outputs = keyValueList(Object.entries(node.outputs), "output-list");
  const messages = snapshot.agentMessages?.[node.id] ?? [];
  ui["inspector-content"].append(
    section("Execution", details),
    ...(state.status === "awaiting_recovery" && state.recovery
      ? [section("Recovery", recoveryPanel(state.recovery))]
      : []),
    ...(state.status === "awaiting_input" && state.humanRequest
      ? [section("Your input", humanInputPanel(state.humanRequest))]
      : []),
    ...(node.kind === "human" ? [] : [section("Agent message stream", agentMessageStream(messages, snapshot.agentMessages === undefined))]),
    section(node.kind === "human" ? "Human gate" : "Prompt", prompt),
    section("Input bindings", bindings),
    section("Output variables", outputs),
    ...(node.loop ? [section("Loop gate", keyValueList([
      ["until", `${node.loop.until.path} ${node.loop.until.operator} ${String(node.loop.until.value ?? "")}`],
      ["carry as", node.loop.carry_as],
      ["exhaustion", node.loop.on_exhaustion],
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
  const run = snapshot?.run;
  const definition = snapshot?.definition;
  if (!run) {
    renderGraph(null, null);
    return;
  }
  if (!selectedNodeId || !definition.nodes.some((node) => node.id === selectedNodeId)) {
    selectedNodeId = definition.nodes.find((node) => ["awaiting_input", "awaiting_recovery", "running"].includes(run.nodes[node.id]?.status))?.id ?? selectedNodeId;
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
  if (!current?.run) return;
  // Repaint SVG markers and surfaces in browsers that cache inherited theme tokens.
  // The inspector stays mounted so unsent answers and focus survive appearance changes.
  renderedGraphKey = null;
  renderGraph(current.definition, current.run);
});

connect();
