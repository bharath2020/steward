(function (root) {
  "use strict";

  function fitText(value, width, measure) {
    const content = String(value ?? "");
    if (measure(content) <= width) return content;
    const ellipsis = "…";
    if (measure(ellipsis) > width) return "";
    const characters = Array.from(content);
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (measure(characters.slice(0, middle).join("") + ellipsis) <= width) low = middle;
      else high = middle - 1;
    }
    return characters.slice(0, low).join("").trimEnd() + ellipsis;
  }

  function wrapText(value, width, measure, maxLines = 3) {
    const content = String(value ?? "").trim().replace(/\s+/g, " ");
    if (maxLines <= 0) return [];
    if (!content || width <= 0) return [""];
    const lines = [];
    let line = "";
    for (const word of content.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const character of Array.from(word)) {
        if (line && measure(line + character) > width) {
          lines.push(line);
          line = "";
        }
        // An unusually wide glyph still consumes input and cannot escape the box.
        line += measure(character) <= width ? character : fitText(character, width, measure);
      }
    }
    if (line || !lines.length) lines.push(line);
    if (lines.length <= maxLines) return lines;
    const visible = lines.slice(0, maxLines);
    visible[maxLines - 1] = fitText(`${visible[maxLines - 1]}…`, width, measure);
    return visible;
  }

  function layoutGraph(nodes, measureTitle) {
    if (!nodes.length) return { width: 0, height: 0, layers: [], boxes: {} };
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const depths = new Map();
    const depth = (node) => {
      if (depths.has(node.id)) return depths.get(node.id);
      const dependencies = node.needs ?? [];
      const result = dependencies.length ? 1 + Math.max(...dependencies.map((id) => depth(byId.get(id)))) : 0;
      depths.set(node.id, result);
      return result;
    };
    const layers = [];
    nodes.forEach((node) => (layers[depth(node)] ??= []).push(node));
    const boxes = {};
    const layerWidths = layers.map((layer) => Math.max(240, Math.min(300,
      Math.max(...layer.map((node) => measureTitle(String(node.title ?? "")) + 48)),
    )));
    const layerHeights = layers.map((layer, column) => {
      layer.forEach((node) => {
        const width = layerWidths[column];
        const titleLines = wrapText(node.title, width - 48, measureTitle);
        const height = titleLines.length * 20 + 72;
        const phaseY = 27 + (titleLines.length - 1) * 20 + 26;
        boxes[node.id] = {
          x: 0, y: 0, width, height, titleLines, phaseY,
          metaY: phaseY + 20, visualHeight: height + (node.loop ? 52 : 0),
        };
      });
      return layer.reduce((total, node) => total + boxes[node.id].visualHeight, 0) + (layer.length - 1) * 28;
    });
    const width = 56 + layerWidths.reduce((total, item) => total + item, 0) + (layers.length - 1) * 60;
    const height = 88 + Math.max(...layerHeights);
    let x = 28;
    layers.forEach((layer, column) => {
      let y = (height - layerHeights[column]) / 2;
      layer.forEach((node) => {
        Object.assign(boxes[node.id], { x, y });
        y += boxes[node.id].visualHeight + 28;
      });
      x += layerWidths[column] + 60;
    });
    return { width, height, layers, boxes };
  }

  const api = { wrapText, fitText, layoutGraph };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkflowGraphLayout = api;
})(typeof window === "undefined" ? globalThis : window);
