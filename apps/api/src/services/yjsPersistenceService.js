import * as Y from "yjs";
import { persistYjsUpdateDirect, saveYjsSnapshotDirect, updateJson } from "../db.js";
import { id, now } from "../utils/http.js";

const DEFAULT_COMPACT_THRESHOLD = 24;

export function encodeYUpdate(update) {
  return Buffer.from(update).toString("base64");
}

export function decodeYUpdate(update) {
  if (typeof update !== "string" || !update) return null;
  try {
    return new Uint8Array(Buffer.from(update, "base64"));
  } catch {
    return null;
  }
}

function ensureWorkflowCollections(db) {
  if (!Array.isArray(db.workflowUpdates)) db.workflowUpdates = [];
  if (!Array.isArray(db.workflowSnapshots)) db.workflowSnapshots = [];
}

export function buildYDocFromPersistence(records = {}) {
  const doc = new Y.Doc();
  const latestSnapshot = records.snapshot;
  if (latestSnapshot?.update) {
    const snapshotUpdate = decodeYUpdate(latestSnapshot.update);
    if (snapshotUpdate) Y.applyUpdate(doc, snapshotUpdate, "persisted:snapshot");
  }
  for (const record of records.updates || []) {
    const update = decodeYUpdate(record.update);
    if (update) Y.applyUpdate(doc, update, "persisted:update");
  }
  return doc;
}

function fromYValue(value) {
  if (value instanceof Y.Map) {
    const record = {};
    value.forEach((item, key) => {
      record[key] = fromYValue(item);
    });
    return record;
  }
  if (value instanceof Y.Array) return value.toArray().map((item) => fromYValue(item));
  if (value instanceof Y.Text) return value.toString();
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

function orderedCollection(map, order) {
  const orderedIds = order.toArray().filter((item, index, items) => items.indexOf(item) === index && map.has(item));
  const orderedIdSet = new Set(orderedIds);
  const extraIds = Array.from(map.keys()).filter((item) => !orderedIdSet.has(item)).sort();
  return [...orderedIds, ...extraIds].map((item) => fromYValue(map.get(item)));
}

export function snapshotFromYDoc(doc) {
  const nodes = doc.getMap("nodes");
  const nodeOrder = doc.getArray("nodeOrder");
  const edges = doc.getMap("edges");
  const edgeOrder = doc.getArray("edgeOrder");
  const groups = doc.getMap("groups");
  const groupOrder = doc.getArray("groupOrder");
  const meta = doc.getMap("meta");
  const viewport = fromYValue(meta.get("viewport")) || { x: 0, y: 0, zoom: 1 };
  return {
    nodes: orderedCollection(nodes, nodeOrder),
    edges: orderedCollection(edges, edgeOrder),
    groups: orderedCollection(groups, groupOrder),
    viewport,
  };
}

export function getCanvasYjsPersistence(db, canvasId) {
  ensureWorkflowCollections(db);
  const snapshots = db.workflowSnapshots
    .filter((record) => record.canvasId === canvasId)
    .sort((left, right) => Number(left.clock || 0) - Number(right.clock || 0));
  const snapshot = snapshots[snapshots.length - 1] || null;
  const sinceClock = Number(snapshot?.clock || 0);
  const updates = db.workflowUpdates
    .filter((record) => record.canvasId === canvasId && Number(record.clock || 0) > sinceClock)
    .sort((left, right) => Number(left.clock || 0) - Number(right.clock || 0));
  return { snapshot, updates };
}

export function restoreYDocFromDb(db, canvasId) {
  return buildYDocFromPersistence(getCanvasYjsPersistence(db, canvasId));
}

export function listCanvasYjsSnapshots(db, canvasId) {
  ensureWorkflowCollections(db);
  return db.workflowSnapshots
    .filter((record) => record.canvasId === canvasId)
    .sort((left, right) => Number(right.clock || 0) - Number(left.clock || 0))
    .map(({ update, ...record }) => ({
      ...record,
      updateSize: typeof update === "string" ? Buffer.byteLength(update, "base64") : 0,
    }));
}

export function getCanvasYjsSnapshotDetail(db, canvasId, snapshotId) {
  ensureWorkflowCollections(db);
  const snapshotRecord = db.workflowSnapshots.find((record) => record.canvasId === canvasId && record.id === snapshotId);
  if (!snapshotRecord?.update) return null;
  const doc = buildYDocFromPersistence({ snapshot: snapshotRecord, updates: [] });
  const snapshot = snapshotFromYDoc(doc);
  const { update, ...publicRecord } = snapshotRecord;
  return {
    record: {
      ...publicRecord,
      updateSize: typeof update === "string" ? Buffer.byteLength(update, "base64") : 0,
    },
    snapshot,
    summary: {
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
      groups: (snapshot.groups || []).length,
    },
  };
}

export async function persistYjsUpdate(canvasId, update, options = {}) {
  const encodedUpdate = typeof update === "string" ? update : encodeYUpdate(update);
  const compactThreshold = Number(options.compactThreshold || DEFAULT_COMPACT_THRESHOLD);
  const direct = await persistYjsUpdateDirect(canvasId, encodedUpdate, options);
  if (direct.handled) {
    let snapshotRecord = null;
    if (direct.result?.pendingUpdateCount >= compactThreshold && options.doc instanceof Y.Doc) {
      const snapshot = await saveYjsSnapshotDirect(canvasId, encodeYUpdate(Y.encodeStateAsUpdate(options.doc)), options);
      snapshotRecord = snapshot.result;
    }
    return { update: direct.result?.update, snapshot: snapshotRecord };
  }
  return updateJson((db) => {
    ensureWorkflowCollections(db);
    const timestamp = now();
    const latestClock = Math.max(
      0,
      ...db.workflowUpdates.filter((record) => record.canvasId === canvasId).map((record) => Number(record.clock || 0)),
      ...db.workflowSnapshots.filter((record) => record.canvasId === canvasId).map((record) => Number(record.clock || 0)),
    );
    const record = {
      id: id("yupdate"),
      canvasId,
      clock: latestClock + 1,
      update: encodedUpdate,
      createdAt: timestamp,
    };
    db.workflowUpdates.push(record);

    const latestSnapshot = getCanvasYjsPersistence(db, canvasId).snapshot;
    const sinceClock = Number(latestSnapshot?.clock || 0);
    const pendingUpdates = db.workflowUpdates.filter((item) => item.canvasId === canvasId && Number(item.clock || 0) > sinceClock);
    let snapshotRecord = null;
    if (pendingUpdates.length >= compactThreshold) {
      const doc = restoreYDocFromDb(db, canvasId);
      snapshotRecord = {
        id: id("ysnapshot"),
        canvasId,
        clock: record.clock,
        update: encodeYUpdate(Y.encodeStateAsUpdate(doc)),
        updateCount: db.workflowUpdates.filter((item) => item.canvasId === canvasId && Number(item.clock || 0) <= record.clock).length,
        createdAt: timestamp,
      };
      db.workflowSnapshots.push(snapshotRecord);
      db.workflowUpdates = db.workflowUpdates.filter((item) => item.canvasId !== canvasId || Number(item.clock || 0) > record.clock);
    }
    return { update: record, snapshot: snapshotRecord };
  });
}

export async function saveYjsSnapshot(canvasId, doc) {
  const encodedSnapshotUpdate = encodeYUpdate(Y.encodeStateAsUpdate(doc));
  const direct = await saveYjsSnapshotDirect(canvasId, encodedSnapshotUpdate);
  if (direct.handled) return direct.result;
  return updateJson((db) => {
    ensureWorkflowCollections(db);
    const timestamp = now();
    const latestClock = Math.max(
      0,
      ...db.workflowUpdates.filter((record) => record.canvasId === canvasId).map((record) => Number(record.clock || 0)),
      ...db.workflowSnapshots.filter((record) => record.canvasId === canvasId).map((record) => Number(record.clock || 0)),
    );
    const snapshot = {
      id: id("ysnapshot"),
      canvasId,
      clock: latestClock,
      update: encodedSnapshotUpdate,
      updateCount: db.workflowUpdates.filter((record) => record.canvasId === canvasId && Number(record.clock || 0) <= latestClock).length,
      createdAt: timestamp,
    };
    db.workflowSnapshots.push(snapshot);
    db.workflowUpdates = db.workflowUpdates.filter((record) => record.canvasId !== canvasId || Number(record.clock || 0) > latestClock);
    return snapshot;
  });
}
