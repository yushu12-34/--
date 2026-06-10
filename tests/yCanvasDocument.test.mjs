import assert from "node:assert/strict";
import test from "node:test";
import {
  applySnapshotToYDoc,
  applyYCanvasUpdate,
  canRedoYCanvas,
  canUndoYCanvas,
  createYCanvasDocument,
  encodeYCanvasUpdate,
  getYCanvasNodePromptText,
  redoYCanvas,
  removeYCanvasNode,
  snapshotFromYDoc,
  undoYCanvas,
  patchYCanvasGroup,
  patchYCanvasNode,
  upsertYCanvasEdge,
  upsertYCanvasGroup,
  upsertYCanvasNode,
  Y_CANVAS_LOAD_ORIGIN,
  Y_CANVAS_LOCAL_ORIGIN,
  Y_CANVAS_REMOTE_ORIGIN,
} from "../apps/web/src/yCanvasDocument.ts";

function makeSnapshot() {
  return {
    nodes: [
      {
        id: "node:text",
        type: "text.input",
        title: "文本",
        position: { x: 120, y: 160 },
        data: { prompt: "角色设定", refs: [{ name: "ref", url: "local://ref" }] },
        runtime: { status: "idle", progress: 0 },
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
      },
      {
        id: "node:image",
        type: "image.generate",
        title: "图片生成",
        position: { x: 520, y: 160 },
        data: { prompt: "anime", params: { width: 1024, height: 1024 } },
        runtime: { status: "succeeded", progress: 100, inputSignature: "sig" },
        createdAt: "2026-06-08T00:00:00.000Z",
        updatedAt: "2026-06-08T00:00:00.000Z",
      },
    ],
    edges: [
      {
        id: "edge:1",
        sourceNodeId: "node:text",
        sourcePortId: "out",
        targetNodeId: "node:image",
        targetPortId: "in",
      },
    ],
    groups: [
      {
        id: "group:1",
        title: "组合 1",
        nodeIds: ["node:text", "node:image"],
        bounds: { x: 80, y: 120, width: 760, height: 320 },
        runtime: { status: "idle", total: 0 },
        createdAt: "2026-06-08T00:00:00.000Z",
      },
    ],
    viewport: { x: 8, y: 16, zoom: 0.75 },
  };
}

test("Y canvas converts CanvasSnapshot without losing node edge group data", () => {
  const yCanvas = createYCanvasDocument();
  const snapshot = makeSnapshot();
  applySnapshotToYDoc(yCanvas, snapshot, Y_CANVAS_LOCAL_ORIGIN);

  assert.deepEqual(snapshotFromYDoc(yCanvas), snapshot);
  yCanvas.destroy();
});

test("Y canvas update can be applied to another document", () => {
  const source = createYCanvasDocument();
  const target = createYCanvasDocument();
  const snapshot = makeSnapshot();

  applySnapshotToYDoc(source, snapshot, Y_CANVAS_LOCAL_ORIGIN);
  applyYCanvasUpdate(target, encodeYCanvasUpdate(source), Y_CANVAS_REMOTE_ORIGIN);

  assert.deepEqual(snapshotFromYDoc(target), snapshot);
  source.destroy();
  target.destroy();
});

test("Y canvas undo and redo restore local snapshot changes", () => {
  const yCanvas = createYCanvasDocument();
  const initial = makeSnapshot();
  const changed = {
    ...initial,
    nodes: initial.nodes.map((node) =>
      node.id === "node:text"
        ? { ...node, data: { ...node.data, prompt: "更新后的角色设定" } }
        : node,
    ),
  };

  applySnapshotToYDoc(yCanvas, initial, Y_CANVAS_LOAD_ORIGIN);
  applySnapshotToYDoc(yCanvas, changed, Y_CANVAS_LOCAL_ORIGIN);

  assert.equal(canUndoYCanvas(yCanvas), true);
  undoYCanvas(yCanvas);
  assert.equal(snapshotFromYDoc(yCanvas).nodes[0].data.prompt, "角色设定");

  assert.equal(canRedoYCanvas(yCanvas), true);
  redoYCanvas(yCanvas);
  assert.equal(snapshotFromYDoc(yCanvas).nodes[0].data.prompt, "更新后的角色设定");
  yCanvas.destroy();
});

test("Y canvas patches a single node without replacing the full document", () => {
  const yCanvas = createYCanvasDocument();
  applySnapshotToYDoc(yCanvas, makeSnapshot(), Y_CANVAS_LOAD_ORIGIN);
  const promptText = getYCanvasNodePromptText(yCanvas, "node:text");

  assert.equal(patchYCanvasNode(yCanvas, "node:text", { data: { prompt: "细粒度更新" } }, Y_CANVAS_LOCAL_ORIGIN), true);
  const snapshot = snapshotFromYDoc(yCanvas);

  assert.ok(promptText);
  assert.equal(getYCanvasNodePromptText(yCanvas, "node:text"), promptText);
  assert.equal(snapshot.nodes[0].data.prompt, "细粒度更新");
  assert.equal(snapshot.nodes[0].data.refs[0].name, "ref");
  assert.equal(snapshot.nodes[1].data.prompt, "anime");
  yCanvas.destroy();
});

test("Y canvas stores prompt as Y.Text and restores prompt with undo redo", () => {
  const yCanvas = createYCanvasDocument();
  applySnapshotToYDoc(yCanvas, makeSnapshot(), Y_CANVAS_LOAD_ORIGIN);

  const promptText = getYCanvasNodePromptText(yCanvas, "node:image");
  assert.ok(promptText);
  assert.equal(promptText.toString(), "anime");

  patchYCanvasNode(yCanvas, "node:image", { data: { prompt: "cinematic anime" } }, Y_CANVAS_LOCAL_ORIGIN);
  assert.equal(promptText.toString(), "cinematic anime");
  assert.equal(snapshotFromYDoc(yCanvas).nodes[1].data.prompt, "cinematic anime");

  undoYCanvas(yCanvas);
  assert.equal(snapshotFromYDoc(yCanvas).nodes[1].data.prompt, "anime");
  redoYCanvas(yCanvas);
  assert.equal(snapshotFromYDoc(yCanvas).nodes[1].data.prompt, "cinematic anime");
  yCanvas.destroy();
});

test("Y canvas removes a node and cleans dependent edges and undersized groups", () => {
  const yCanvas = createYCanvasDocument();
  applySnapshotToYDoc(yCanvas, makeSnapshot(), Y_CANVAS_LOAD_ORIGIN);

  removeYCanvasNode(yCanvas, "node:text", Y_CANVAS_LOCAL_ORIGIN);
  const snapshot = snapshotFromYDoc(yCanvas);

  assert.deepEqual(snapshot.nodes.map((node) => node.id), ["node:image"]);
  assert.deepEqual(snapshot.edges, []);
  assert.deepEqual(snapshot.groups, []);
  yCanvas.destroy();
});

test("Y canvas upserts edges and patches group runtime", () => {
  const yCanvas = createYCanvasDocument();
  applySnapshotToYDoc(yCanvas, { ...makeSnapshot(), edges: [], groups: [] }, Y_CANVAS_LOAD_ORIGIN);

  upsertYCanvasNode(yCanvas, {
    ...makeSnapshot().nodes[0],
    id: "node:extra",
    position: { x: 24, y: 32 },
  }, Y_CANVAS_LOCAL_ORIGIN);
  upsertYCanvasEdge(yCanvas, {
    id: "edge:extra",
    sourceNodeId: "node:extra",
    sourcePortId: "out",
    targetNodeId: "node:image",
    targetPortId: "in",
  }, Y_CANVAS_LOCAL_ORIGIN);
  upsertYCanvasGroup(yCanvas, {
    id: "group:runtime",
    title: "运行组合",
    nodeIds: ["node:extra", "node:image"],
    bounds: { x: 0, y: 0, width: 600, height: 300 },
    createdAt: "2026-06-08T00:00:00.000Z",
  }, Y_CANVAS_LOCAL_ORIGIN);
  assert.equal(patchYCanvasGroup(yCanvas, "group:runtime", { runtime: { status: "running", total: 2, completed: 1 } }, Y_CANVAS_LOCAL_ORIGIN), true);

  const snapshot = snapshotFromYDoc(yCanvas);
  assert.deepEqual(snapshot.edges.map((edge) => edge.id), ["edge:extra"]);
  assert.equal(snapshot.groups[0].runtime.status, "running");
  assert.equal(snapshot.groups[0].runtime.completed, 1);
  yCanvas.destroy();
});
