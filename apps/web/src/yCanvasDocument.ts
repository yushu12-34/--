import * as Y from "yjs";
import type { CanvasSnapshot, WorkflowEdge, WorkflowGroup, WorkflowNode } from "./types";

export const Y_CANVAS_LOAD_ORIGIN = "canvas:load";
export const Y_CANVAS_LOCAL_ORIGIN = "canvas:local";
export const Y_CANVAS_REMOTE_ORIGIN = "canvas:remote";
export const Y_CANVAS_HISTORY_ORIGIN = "canvas:history";

export interface YCanvasDocument {
  doc: Y.Doc;
  nodes: Y.Map<Y.Map<unknown>>;
  nodeOrder: Y.Array<string>;
  edges: Y.Map<Y.Map<unknown>>;
  edgeOrder: Y.Array<string>;
  groups: Y.Map<Y.Map<unknown>>;
  groupOrder: Y.Array<string>;
  meta: Y.Map<unknown>;
  undoManager: Y.UndoManager;
  destroy: () => void;
}

const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Y.AbstractType));
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function toYValue(value: unknown): unknown {
  return cloneJson(value);
}

function toYDataValue(key: string, value: unknown): unknown {
  if (key === "prompt" && typeof value === "string") {
    return new Y.Text();
  }
  return toYValue(value);
}

function fromYValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const record: Record<string, unknown> = {};
    value.forEach((item, key) => {
      record[key] = fromYValue(item);
    });
    return record;
  }
  if (value instanceof Y.Array) {
    return value.toArray().map((item) => fromYValue(item));
  }
  if (value instanceof Y.Text) {
    return value.toString();
  }
  return cloneJson(value);
}

function replaceYArray<T>(array: Y.Array<T>, values: T[]) {
  if (array.length) array.delete(0, array.length);
  if (values.length) array.insert(0, values);
}

function removeFromYArray<T>(array: Y.Array<T>, value: T) {
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (array.get(index) === value) array.delete(index, 1);
  }
}

function appendToYArray<T>(array: Y.Array<T>, value: T) {
  if (!array.toArray().includes(value)) array.insert(array.length, [value]);
}

function encodeRecord<T extends { id: string }>(item: T) {
  return toYValue(item) as Y.Map<unknown>;
}

function encodeWorkflowNode(node: WorkflowNode) {
  const map = new Y.Map<unknown>();
  setRecordValue(map, "id", node.id);
  setRecordValue(map, "type", node.type);
  setRecordValue(map, "title", node.title);
  setRecordValue(map, "createdAt", node.createdAt);
  setRecordValue(map, "updatedAt", node.updatedAt);
  return map;
}

function setRecordValue(map: Y.Map<unknown>, key: string, value: unknown) {
  if (value === undefined) return;
  map.set(key, toYValue(value));
}

function ensureNestedMap(map: Y.Map<unknown>, key: string): Y.Map<unknown> {
  let nested: unknown = map.get(key);
  if (!(nested instanceof Y.Map)) {
    nested = new Y.Map<unknown>();
    map.set(key, nested);
  }
  return nested as Y.Map<unknown>;
}

function patchPromptText(dataMap: Y.Map<unknown>, prompt: unknown) {
  const promptValue = String(prompt || "");
  const currentPrompt = dataMap.get("prompt");
  if (currentPrompt instanceof Y.Text) {
    if (currentPrompt.toString() === promptValue) return;
    currentPrompt.delete(0, currentPrompt.length);
    if (promptValue) currentPrompt.insert(0, promptValue);
    return;
  }
  const nextPrompt = new Y.Text();
  dataMap.set("prompt", nextPrompt);
  if (promptValue) nextPrompt.insert(0, promptValue);
}

function patchNestedDataMap(map: Y.Map<unknown>, key: string, patch: Record<string, unknown>) {
  const nested = ensureNestedMap(map, key);
  for (const [patchKey, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;
    if (key === "data" && patchKey === "prompt") {
      patchPromptText(nested, patchValue);
    } else {
      nested.set(patchKey, key === "data" ? toYDataValue(patchKey, patchValue) : toYValue(patchValue));
    }
  }
}

function decodeRecord<T>(map: Y.Map<unknown>) {
  return fromYValue(map) as T;
}

function replaceCollection<T extends { id: string }>(
  map: Y.Map<Y.Map<unknown>>,
  order: Y.Array<string>,
  items: T[],
  encode: (item: T) => Y.Map<unknown> = encodeRecord,
) {
  const ids = items.map((item) => item.id);
  const nextIdSet = new Set(ids);
  for (const existingId of Array.from(map.keys())) {
    if (!nextIdSet.has(existingId)) map.delete(existingId);
  }
  for (const item of items) {
    map.set(item.id, encode(item));
  }
  replaceYArray(order, ids);
}

function putWorkflowNode(yCanvas: YCanvasDocument, node: WorkflowNode) {
  let nodeMap = yCanvas.nodes.get(node.id);
  if (!nodeMap) {
    nodeMap = encodeWorkflowNode(node);
    yCanvas.nodes.set(node.id, nodeMap);
  }
  setRecordValue(nodeMap, "id", node.id);
  setRecordValue(nodeMap, "type", node.type);
  setRecordValue(nodeMap, "title", node.title);
  setRecordValue(nodeMap, "createdAt", node.createdAt);
  setRecordValue(nodeMap, "updatedAt", node.updatedAt);
  patchNestedDataMap(nodeMap, "position", node.position);
  patchNestedDataMap(nodeMap, "data", node.data || {});
  patchNestedDataMap(nodeMap, "runtime", node.runtime || { status: "idle" });
  appendToYArray(yCanvas.nodeOrder, node.id);
}

function replaceNodeCollection(yCanvas: YCanvasDocument, nodes: WorkflowNode[]) {
  const ids = nodes.map((node) => node.id);
  const nextIdSet = new Set(ids);
  for (const existingId of Array.from(yCanvas.nodes.keys())) {
    if (!nextIdSet.has(existingId)) yCanvas.nodes.delete(existingId);
  }
  replaceYArray(yCanvas.nodeOrder, ids);
  for (const node of nodes) {
    putWorkflowNode(yCanvas, node);
  }
}

function orderedCollection<T>(map: Y.Map<Y.Map<unknown>>, order: Y.Array<string>): T[] {
  const orderedIds = order.toArray().filter((id, index, ids) => ids.indexOf(id) === index && map.has(id));
  const orderedIdSet = new Set(orderedIds);
  const extraIds = Array.from(map.keys()).filter((id) => !orderedIdSet.has(id)).sort();
  return [...orderedIds, ...extraIds].map((id) => decodeRecord<T>(map.get(id)!));
}

function touchMeta(yCanvas: YCanvasDocument) {
  yCanvas.meta.set("schemaVersion", 1);
  yCanvas.meta.set("updatedAt", new Date().toISOString());
}

export function createYCanvasDocument(): YCanvasDocument {
  const doc = new Y.Doc();
  const nodes = doc.getMap<Y.Map<unknown>>("nodes");
  const nodeOrder = doc.getArray<string>("nodeOrder");
  const edges = doc.getMap<Y.Map<unknown>>("edges");
  const edgeOrder = doc.getArray<string>("edgeOrder");
  const groups = doc.getMap<Y.Map<unknown>>("groups");
  const groupOrder = doc.getArray<string>("groupOrder");
  const meta = doc.getMap<unknown>("meta");
  const undoManager = new Y.UndoManager([nodes, nodeOrder, edges, edgeOrder, groups, groupOrder, meta], {
    trackedOrigins: new Set([Y_CANVAS_LOCAL_ORIGIN]),
  });

  return {
    doc,
    nodes,
    nodeOrder,
    edges,
    edgeOrder,
    groups,
    groupOrder,
    meta,
    undoManager,
    destroy: () => {
      undoManager.destroy();
      doc.destroy();
    },
  };
}

export function applySnapshotToYDoc(
  yCanvas: YCanvasDocument,
  snapshot: CanvasSnapshot,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  const normalizedSnapshot: CanvasSnapshot = {
    nodes: snapshot.nodes || [],
    edges: snapshot.edges || [],
    groups: snapshot.groups || [],
    viewport: snapshot.viewport || DEFAULT_VIEWPORT,
  };
  yCanvas.doc.transact(() => {
    replaceNodeCollection(yCanvas, normalizedSnapshot.nodes);
    replaceCollection<WorkflowEdge>(yCanvas.edges, yCanvas.edgeOrder, normalizedSnapshot.edges);
    replaceCollection<WorkflowGroup>(yCanvas.groups, yCanvas.groupOrder, normalizedSnapshot.groups || []);
    yCanvas.meta.set("viewport", toYValue(normalizedSnapshot.viewport));
    touchMeta(yCanvas);
  }, origin);
}

export function transactYCanvas(
  yCanvas: YCanvasDocument,
  mutation: () => void,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  yCanvas.doc.transact(() => {
    mutation();
    touchMeta(yCanvas);
  }, origin);
}

export function upsertYCanvasNode(
  yCanvas: YCanvasDocument,
  node: WorkflowNode,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    putWorkflowNode(yCanvas, node);
  }, origin);
}

export function upsertYCanvasNodes(
  yCanvas: YCanvasDocument,
  nodes: WorkflowNode[],
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    for (const node of nodes) {
      putWorkflowNode(yCanvas, node);
    }
  }, origin);
}

export function patchYCanvasNode(
  yCanvas: YCanvasDocument,
  nodeId: string,
  patch: Partial<WorkflowNode>,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  const currentMap = yCanvas.nodes.get(nodeId);
  if (!currentMap) return false;
  const current = decodeRecord<WorkflowNode>(currentMap);
  const next: WorkflowNode = {
    ...current,
    ...patch,
    data: patch.data ? { ...current.data, ...patch.data } : current.data,
    runtime: patch.runtime ? { ...current.runtime, ...patch.runtime } : current.runtime,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };
  transactYCanvas(yCanvas, () => {
    if (patch.title !== undefined) setRecordValue(currentMap, "title", patch.title);
    if (patch.type !== undefined) setRecordValue(currentMap, "type", patch.type);
    if (patch.position !== undefined) patchNestedDataMap(currentMap, "position", patch.position);
    if (patch.data !== undefined) patchNestedDataMap(currentMap, "data", next.data);
    if (patch.runtime !== undefined) patchNestedDataMap(currentMap, "runtime", next.runtime);
    if (patch.createdAt !== undefined) setRecordValue(currentMap, "createdAt", patch.createdAt);
    setRecordValue(currentMap, "updatedAt", next.updatedAt);
    appendToYArray(yCanvas.nodeOrder, nodeId);
  }, origin);
  return true;
}

export function removeYCanvasNode(
  yCanvas: YCanvasDocument,
  nodeId: string,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    yCanvas.nodes.delete(nodeId);
    removeFromYArray(yCanvas.nodeOrder, nodeId);

    for (const [edgeId, edgeMap] of Array.from(yCanvas.edges.entries())) {
      const edge = decodeRecord<WorkflowEdge>(edgeMap);
      if (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId) {
        yCanvas.edges.delete(edgeId);
        removeFromYArray(yCanvas.edgeOrder, edgeId);
      }
    }

    for (const [groupId, groupMap] of Array.from(yCanvas.groups.entries())) {
      const group = decodeRecord<WorkflowGroup>(groupMap);
      const nodeIds = group.nodeIds.filter((id) => id !== nodeId);
      if (nodeIds.length <= 1) {
        yCanvas.groups.delete(groupId);
        removeFromYArray(yCanvas.groupOrder, groupId);
      } else if (nodeIds.length !== group.nodeIds.length) {
        yCanvas.groups.set(groupId, encodeRecord({ ...group, nodeIds }));
      }
    }
  }, origin);
}

export function upsertYCanvasEdge(
  yCanvas: YCanvasDocument,
  edge: WorkflowEdge,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    yCanvas.edges.set(edge.id, encodeRecord(edge));
    appendToYArray(yCanvas.edgeOrder, edge.id);
  }, origin);
}

export function upsertYCanvasEdges(
  yCanvas: YCanvasDocument,
  edges: WorkflowEdge[],
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    for (const edge of edges) {
      yCanvas.edges.set(edge.id, encodeRecord(edge));
      appendToYArray(yCanvas.edgeOrder, edge.id);
    }
  }, origin);
}

export function removeYCanvasEdge(
  yCanvas: YCanvasDocument,
  edgeId: string,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    yCanvas.edges.delete(edgeId);
    removeFromYArray(yCanvas.edgeOrder, edgeId);
  }, origin);
}

export function upsertYCanvasGroup(
  yCanvas: YCanvasDocument,
  group: WorkflowGroup,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    yCanvas.groups.set(group.id, encodeRecord(group));
    appendToYArray(yCanvas.groupOrder, group.id);
  }, origin);
}

export function upsertYCanvasGroups(
  yCanvas: YCanvasDocument,
  groups: WorkflowGroup[],
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    for (const group of groups) {
      yCanvas.groups.set(group.id, encodeRecord(group));
      appendToYArray(yCanvas.groupOrder, group.id);
    }
  }, origin);
}

export function patchYCanvasGroup(
  yCanvas: YCanvasDocument,
  groupId: string,
  patch: Partial<WorkflowGroup>,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  const currentMap = yCanvas.groups.get(groupId);
  if (!currentMap) return false;
  const current = decodeRecord<WorkflowGroup>(currentMap);
  const next: WorkflowGroup = {
    ...current,
    ...patch,
    bounds: patch.bounds ? { ...current.bounds, ...patch.bounds } : current.bounds,
    runtime: patch.runtime ? { ...current.runtime, ...patch.runtime } : current.runtime,
  };
  upsertYCanvasGroup(yCanvas, next, origin);
  return true;
}

export function removeYCanvasGroup(
  yCanvas: YCanvasDocument,
  groupId: string,
  origin: unknown = Y_CANVAS_LOCAL_ORIGIN,
) {
  transactYCanvas(yCanvas, () => {
    yCanvas.groups.delete(groupId);
    removeFromYArray(yCanvas.groupOrder, groupId);
  }, origin);
}

export function snapshotFromYDoc(yCanvas: YCanvasDocument): CanvasSnapshot {
  const viewport = fromYValue(yCanvas.meta.get("viewport")) as CanvasSnapshot["viewport"] | undefined;
  return {
    nodes: orderedCollection<WorkflowNode>(yCanvas.nodes, yCanvas.nodeOrder),
    edges: orderedCollection<WorkflowEdge>(yCanvas.edges, yCanvas.edgeOrder),
    groups: orderedCollection<WorkflowGroup>(yCanvas.groups, yCanvas.groupOrder),
    viewport: viewport || DEFAULT_VIEWPORT,
  };
}

export function getYCanvasNodePromptText(yCanvas: YCanvasDocument, nodeId: string) {
  const nodeMap = yCanvas.nodes.get(nodeId);
  const dataMap = nodeMap?.get("data");
  const prompt = dataMap instanceof Y.Map ? dataMap.get("prompt") : undefined;
  return prompt instanceof Y.Text ? prompt : null;
}

export function observeYCanvas(
  yCanvas: YCanvasDocument,
  onChange: (snapshot: CanvasSnapshot, transaction: Y.Transaction, update?: Uint8Array) => void,
) {
  const handleTransaction = (transaction: Y.Transaction) => {
    if (!transaction.changed.size) return;
    onChange(snapshotFromYDoc(yCanvas), transaction);
  };
  const handleUpdate = (update: Uint8Array, origin: unknown, doc: Y.Doc, transaction: Y.Transaction) => {
    if (!transaction.changed.size) return;
    onChange(snapshotFromYDoc(yCanvas), transaction, update);
  };
  yCanvas.doc.on("afterTransaction", handleTransaction);
  yCanvas.doc.on("update", handleUpdate);
  return () => {
    yCanvas.doc.off("afterTransaction", handleTransaction);
    yCanvas.doc.off("update", handleUpdate);
  };
}

export function canUndoYCanvas(yCanvas: YCanvasDocument) {
  return yCanvas.undoManager.undoStack.length > 0;
}

export function canRedoYCanvas(yCanvas: YCanvasDocument) {
  return yCanvas.undoManager.redoStack.length > 0;
}

export function undoYCanvas(yCanvas: YCanvasDocument) {
  yCanvas.undoManager.undo();
}

export function redoYCanvas(yCanvas: YCanvasDocument) {
  yCanvas.undoManager.redo();
}

export function encodeYCanvasUpdate(yCanvas: YCanvasDocument) {
  return Y.encodeStateAsUpdate(yCanvas.doc);
}

export function encodeYCanvasStateVector(yCanvas: YCanvasDocument) {
  return Y.encodeStateVector(yCanvas.doc);
}

export function encodeYCanvasDiffUpdate(yCanvas: YCanvasDocument, stateVector: Uint8Array) {
  return Y.encodeStateAsUpdate(yCanvas.doc, stateVector);
}

export function applyYCanvasUpdate(
  yCanvas: YCanvasDocument,
  update: Uint8Array,
  origin: unknown = Y_CANVAS_REMOTE_ORIGIN,
) {
  Y.applyUpdate(yCanvas.doc, update, origin);
}
