import assert from "node:assert/strict";
import { test } from "node:test";

type Node = { id: string; title: string; needs: string[]; loop?: object };
type Box = {
  x: number; y: number; width: number; height: number; titleLines: string[];
  phaseY: number; metaY: number; visualHeight: number;
};
const { wrapText, fitText, layoutGraph } = require("../ui/assets/graph-layout.js") as {
  wrapText(value: string, width: number, measure: (value: string) => number, maxLines?: number): string[];
  fitText(value: string, width: number, measure: (value: string) => number): string;
  layoutGraph(nodes: Node[], measure: (value: string) => number): {
    width: number; height: number; layers: Node[][]; boxes: Record<string, Box>;
  };
};
const measure = (value: string) => Array.from(value).length * 8;
const node = (id: string, needs: string[] = [], title = id): Node => ({ id, title, needs });

test("question fan-out and final join preserve order with separated cards and usable edge anchors", () => {
  const nodes = [node("product"), node("technical"), node("audience", ["product"]),
    node("priority", ["product"]), node("platform", ["technical"]), node("storage", ["technical"]),
    node("brief", ["audience", "priority", "platform", "storage"])];
  const graph = layoutGraph(nodes, measure);
  assert.deepEqual(graph.layers.map((layer) => layer.map((item) => item.id)),
    [["product", "technical"], ["audience", "priority", "platform", "storage"], ["brief"]]);
  assert.equal(graph.width, 896);
  assert.equal(graph.height, 540);
  for (const layer of graph.layers) {
    for (let index = 1; index < layer.length; index++) {
      const previous = graph.boxes[layer[index - 1].id];
      const next = graph.boxes[layer[index].id];
      assert.equal(next.y - (previous.y + previous.visualHeight), 28);
    }
  }
  for (const item of nodes) for (const dependency of item.needs) {
    const source = graph.boxes[dependency];
    const target = graph.boxes[item.id];
    assert.equal(target.x - (source.x + source.width), 60);
    assert.ok(source.y + source.height / 2 < graph.height);
    assert.ok(target.y + target.height / 2 < graph.height);
  }
});

test("long titles wrap at words or characters and truncate within their measured width", () => {
  assert.deepEqual(wrapText("alpha beta gamma", 80, measure), ["alpha beta", "gamma"]);
  assert.deepEqual(wrapText("abcdefghijkl", 32, measure), ["abcd", "efgh", "ijkl"]);
  const title = "Technical agent platform answer " + "unbroken".repeat(20);
  const graph = layoutGraph([node("long", [], title)], measure);
  const box = graph.boxes.long;
  assert.equal(box.width, 300);
  assert.equal(box.titleLines.length, 3);
  assert.match(box.titleLines.at(-1)!, /…$/);
  for (const line of box.titleLines) assert.ok(measure(line) <= box.width - 48);
  assert.equal(box.height, 132);
  assert.equal(box.phaseY, 93);
  assert.equal(box.metaY, 113);
});

test("fitted metadata retains short labels and bounds ellipsis including tiny widths", () => {
  assert.equal(fitText("Ready", 40, measure), "Ready");
  assert.equal(fitText("Waiting for dependencies", 80, measure), "Waiting f…");
  assert.equal(fitText("Wide", 7, measure), "");
  assert.deepEqual(wrapText("", 80, measure), [""]);
  assert.deepEqual(wrapText("content", 0, measure), [""]);
  assert.deepEqual(wrapText("content", 80, measure, 0), []);
});

test("mixed title heights leave room for loops and center shorter layers", () => {
  const loop = { ...node("loop", [], "A moderately long looping agent title with useful details"), loop: {} };
  const graph = layoutGraph([loop, node("short"), node("join", ["loop", "short"])], measure);
  const loopBox = graph.boxes.loop;
  const shortBox = graph.boxes.short;
  assert.equal(loopBox.visualHeight - loopBox.height, 52);
  assert.equal(shortBox.y - (loopBox.y + loopBox.height), 80);
  assert.equal(loopBox.y, 44);
  assert.equal(shortBox.y + shortBox.visualHeight, graph.height - 44);
  assert.equal(graph.boxes.join.y + graph.boxes.join.height / 2, graph.height / 2);
});

test("dependency depths work with a reverse ordered DAG and exact canvas bounds", () => {
  const nodes = [node("end", ["middle", "start"]), node("middle", ["start"]), node("start")];
  const graph = layoutGraph(nodes, measure);
  assert.deepEqual(graph.layers.map((layer) => layer.map((item) => item.id)), [["start"], ["middle"], ["end"]]);
  assert.equal(graph.width, 896);
  assert.equal(graph.height, 180);
  assert.deepEqual(graph.boxes.start, { x: 28, y: 44, width: 240, height: 92,
    titleLines: ["start"], phaseY: 53, metaY: 73, visualHeight: 92 });
  assert.equal(graph.boxes.middle.x, 328);
  assert.equal(graph.boxes.end.x + graph.boxes.end.width, graph.width - 28);
});

test("an empty graph has finite zero bounds and no boxes", () => {
  assert.deepEqual(layoutGraph([], measure), { width: 0, height: 0, layers: [], boxes: {} });
});
