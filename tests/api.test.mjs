import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "../apps/api/node_modules/yjs/dist/yjs.mjs";
import { applyEncodedYUpdate, createYjsSyncPayload, decodeYUpdate, encodeYUpdate, sanitizeAwarenessWireState } from "../apps/api/src/services/collaborationService.js";
import { buildProjectBundle, buildProjectList, copyProject, deleteProjectGraph, importProjectBundle, validateProjectBundle } from "../apps/api/src/services/projectArchiveService.js";
import { buildYDocFromPersistence, getCanvasYjsPersistence, getCanvasYjsSnapshotDetail, listCanvasYjsSnapshots } from "../apps/api/src/services/yjsPersistenceService.js";
import { renderAdapterTemplate } from "../apps/api/src/services/imageGeneration.js";
import { isInternalAdminRequest, publicModel, publicProvider } from "../apps/api/src/utils/http.js";

test("publicProvider hides local secret values and exposes only hasSecret", () => {
  const provider = publicProvider({
    id: "p1",
    name: "provider",
    secretValue: "secret",
    secretStorage: "plain-local-json",
  });
  assert.equal(provider.secretValue, undefined);
  assert.equal(provider.hasSecret, true);
  assert.equal(provider.secretStorage, "plain-local-json");
});

test("publicModel exposes only customer-safe model fields", () => {
  const model = publicModel({
    id: "m1",
    providerId: "p1",
    name: "private-name",
    displayName: "Public model",
    type: "image",
    capabilities: ["text-to-image"],
    defaultParams: { size: "private-size", secretSeed: 42 },
    defaultPublicParams: { size: "1k", secretSeed: 42 },
    paramSchema: { size: ["private-size"], secretSeed: [42] },
    publicParamSchema: { size: ["1k", "2k"] },
    adapter: { kind: "z-image", taskPathTemplate: "/secret/{task_id}" },
    enabled: true,
  });

  assert.deepEqual(model, {
    id: "m1",
    displayName: "Public model",
    type: "image",
    capabilities: ["text-to-image"],
    publicParamSchema: { size: ["1k", "2k"] },
    defaultPublicParams: { size: "1k" },
    enabled: true,
  });
  assert.equal(model.providerId, undefined);
  assert.equal(model.adapter, undefined);
  assert.equal(model.defaultParams, undefined);
  assert.equal(model.paramSchema, undefined);
  assert.equal(model.publicParamSchema.secretSeed, undefined);
  assert.equal(model.defaultPublicParams.secretSeed, undefined);
  assert.equal(model.defaultPublicParams.size, "1k");
});

test("publicModel falls back to internal params for legacy models", () => {
  const model = publicModel({
    id: "legacy",
    displayName: "Legacy",
    type: "image",
    capabilities: ["text-to-image"],
    defaultParams: { size: "1k" },
    paramSchema: { size: ["1k", "2k"] },
    enabled: true,
  });

  assert.deepEqual(model.publicParamSchema, { size: ["1k", "2k"] });
  assert.deepEqual(model.defaultPublicParams, { size: "1k" });
});

test("publicModel preserves structured public param schema without internal flags", () => {
  const model = publicModel({
    id: "structured",
    displayName: "Structured",
    type: "image",
    capabilities: ["text-to-image"],
    defaultPublicParams: { size: "1k", cfg: 7, privateSeed: 42, hidden: "x" },
    publicParamSchema: {
      size: { label: "尺寸", type: "string", control: "select", options: ["1k", "2k"], defaultValue: "1k", publicVisible: true },
      cfg: { label: "CFG", type: "number", control: "input", defaultValue: 7, required: true },
      privateSeed: { label: "Seed", type: "number", control: "input", publicVisible: false },
    },
    adapter: { kind: "secret", taskPathTemplate: "/secret/{task_id}" },
  });

  assert.deepEqual(model.defaultPublicParams, { size: "1k", cfg: 7 });
  assert.deepEqual(model.publicParamSchema, {
    size: { label: "尺寸", type: "string", control: "select", options: ["1k", "2k"], defaultValue: "1k" },
    cfg: { label: "CFG", type: "number", control: "input", defaultValue: 7, required: true },
  });
  assert.equal(model.publicParamSchema.size.publicVisible, undefined);
  assert.equal(model.publicParamSchema.privateSeed, undefined);
  assert.equal(model.defaultPublicParams.privateSeed, undefined);
  assert.equal(model.adapter, undefined);
});

test("internal admin request uses token in production and local fallback in development", () => {
  const previousToken = process.env.INTERNAL_ADMIN_TOKEN;
  try {
    process.env.INTERNAL_ADMIN_TOKEN = "dev-secret";
    assert.equal(isInternalAdminRequest({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), false);
    assert.equal(isInternalAdminRequest({ headers: { authorization: "Bearer dev-secret" }, socket: { remoteAddress: "10.0.0.1" } }), true);
    assert.equal(isInternalAdminRequest({ headers: { "x-internal-admin-token": "dev-secret" }, socket: { remoteAddress: "10.0.0.1" } }), true);
    assert.equal(isInternalAdminRequest({ headers: { authorization: "Bearer wrong" }, socket: { remoteAddress: "::1" } }), false);

    delete process.env.INTERNAL_ADMIN_TOKEN;
    assert.equal(isInternalAdminRequest({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), true);
    assert.equal(isInternalAdminRequest({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
    assert.equal(isInternalAdminRequest({ headers: {}, socket: { remoteAddress: "10.0.0.1" } }), false);
  } finally {
    if (previousToken === undefined) delete process.env.INTERNAL_ADMIN_TOKEN;
    else process.env.INTERNAL_ADMIN_TOKEN = previousToken;
  }
});

test("custom HTTP adapter templates render nested request values", () => {
  const payload = renderAdapterTemplate({
    prompt: "{prompt}",
    size: "{params.size}",
    count: "{params.n}",
    image: "{{images.0}}",
    nested: {
      task: "/v1/tasks/{task_id}",
    },
  }, {
    prompt: "画一张动漫海报",
    params: { size: "1k", n: 1 },
    images: ["https://example.test/ref.png"],
    task_id: "task-1",
  });

  assert.deepEqual(payload, {
    prompt: "画一张动漫海报",
    size: "1k",
    count: 1,
    image: "https://example.test/ref.png",
    nested: {
      task: "/v1/tasks/task-1",
    },
  });
});

test("collaboration service encodes and applies Yjs updates", () => {
  const source = new Y.Doc();
  const target = new Y.Doc();
  source.getMap("nodes").set("node:text", { id: "node:text", title: "文本" });

  const encoded = encodeYUpdate(Y.encodeStateAsUpdate(source));
  assert.ok(decodeYUpdate(encoded) instanceof Uint8Array);
  assert.equal(applyEncodedYUpdate(target, encoded, "test"), true);
  assert.equal(target.getMap("nodes").get("node:text").title, "文本");

  const syncPayload = createYjsSyncPayload(source);
  assert.equal(syncPayload.type, "yjs:sync");
  assert.equal(applyEncodedYUpdate(new Y.Doc(), syncPayload.update, "sync"), true);
});

test("collaboration sync payload supports state-vector diff handshake", () => {
  const server = new Y.Doc();
  const client = new Y.Doc();
  server.getMap("nodes").set("node:remote", { id: "node:remote", title: "remote" });
  client.getMap("nodes").set("node:local", { id: "node:local", title: "local" });

  const syncPayload = createYjsSyncPayload(server, encodeYUpdate(Y.encodeStateVector(client)));
  assert.equal(syncPayload.type, "yjs:sync");
  assert.ok(syncPayload.stateVector);

  assert.equal(applyEncodedYUpdate(client, syncPayload.update, "server"), true);
  assert.equal(client.getMap("nodes").get("node:remote").title, "remote");
  assert.equal(client.getMap("nodes").get("node:local").title, "local");

  const clientDiffForServer = Y.encodeStateAsUpdate(client, decodeYUpdate(syncPayload.stateVector));
  assert.equal(applyEncodedYUpdate(server, encodeYUpdate(clientDiffForServer), "client"), true);
  assert.equal(server.getMap("nodes").get("node:remote").title, "remote");
  assert.equal(server.getMap("nodes").get("node:local").title, "local");
});

test("collaboration service sanitizes awareness wire state", () => {
  const state = sanitizeAwarenessWireState({
    clientId: 42,
    state: {
      user: { id: "user:1", name: "Alice", color: "#36d1dc" },
      cursor: { x: "12", y: 24 },
      selectedNodeIds: ["node:a", 7],
      editingNodeId: "node:a",
    },
  });

  assert.equal(state.clientId, 42);
  assert.equal(state.state.user.id, "user:1");
  assert.deepEqual(state.state.cursor, { x: 12, y: 24 });
  assert.deepEqual(state.state.selectedNodeIds, ["node:a", "7"]);
  assert.equal(state.state.editingNodeId, "node:a");
  assert.equal(sanitizeAwarenessWireState({ clientId: Number.NaN, state: {} }), null);
});

test("Yjs persistence restores from snapshot and incremental updates", () => {
  const canvasId = "canvas:history";
  const first = new Y.Doc();
  first.getMap("nodes").set("node:a", { id: "node:a", title: "A" });
  const firstUpdate = encodeYUpdate(Y.encodeStateAsUpdate(first));

  const second = new Y.Doc();
  Y.applyUpdate(second, decodeYUpdate(firstUpdate), "first");
  second.getMap("nodes").set("node:b", { id: "node:b", title: "B" });
  const secondUpdate = encodeYUpdate(Y.encodeStateAsUpdate(second, Y.encodeStateVector(first)));

  const db = {
    workflowSnapshots: [
      {
        id: "snapshot:1",
        canvasId,
        clock: 1,
        update: firstUpdate,
        updateCount: 1,
        createdAt: "2026-06-09T00:00:00.000Z",
      },
    ],
    workflowUpdates: [
      {
        id: "update:2",
        canvasId,
        clock: 2,
        update: secondUpdate,
        createdAt: "2026-06-09T00:01:00.000Z",
      },
    ],
  };

  const persisted = getCanvasYjsPersistence(db, canvasId);
  const restored = buildYDocFromPersistence(persisted);

  assert.equal(restored.getMap("nodes").get("node:a").title, "A");
  assert.equal(restored.getMap("nodes").get("node:b").title, "B");

  const history = listCanvasYjsSnapshots(db, canvasId);
  assert.equal(history.length, 1);
  assert.equal(history[0].update, undefined);
  assert.ok(history[0].updateSize > 0);
});

test("Yjs snapshot detail exposes CanvasSnapshot summary without raw update", () => {
  const canvasId = "canvas:detail";
  const source = new Y.Doc();
  const nodes = source.getMap("nodes");
  const nodeOrder = source.getArray("nodeOrder");
  const edges = source.getMap("edges");
  const edgeOrder = source.getArray("edgeOrder");
  const groups = source.getMap("groups");
  const groupOrder = source.getArray("groupOrder");
  const meta = source.getMap("meta");

  nodes.set("node:a", new Y.Map(Object.entries({
    id: "node:a",
    type: "text.input",
    title: "A",
    position: { x: 10, y: 20 },
    data: {},
    runtime: { status: "idle" },
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
  })));
  nodeOrder.insert(0, ["node:a"]);
  edges.set("edge:a", new Y.Map(Object.entries({
    id: "edge:a",
    sourceNodeId: "node:a",
    sourcePortId: "out",
    targetNodeId: "node:b",
    targetPortId: "in",
  })));
  edgeOrder.insert(0, ["edge:a"]);
  groups.set("group:a", new Y.Map(Object.entries({
    id: "group:a",
    title: "Group",
    nodeIds: ["node:a"],
    bounds: { x: 0, y: 0, width: 200, height: 120 },
    createdAt: "2026-06-09T00:00:00.000Z",
  })));
  groupOrder.insert(0, ["group:a"]);
  meta.set("viewport", { x: 1, y: 2, zoom: 0.5 });

  const db = {
    workflowSnapshots: [
      {
        id: "snapshot:detail",
        canvasId,
        clock: 4,
        update: encodeYUpdate(Y.encodeStateAsUpdate(source)),
        updateCount: 3,
        createdAt: "2026-06-09T00:04:00.000Z",
      },
    ],
    workflowUpdates: [],
  };

  const detail = getCanvasYjsSnapshotDetail(db, canvasId, "snapshot:detail");
  assert.equal(detail.record.id, "snapshot:detail");
  assert.equal(detail.record.update, undefined);
  assert.ok(detail.record.updateSize > 0);
  assert.equal(detail.summary.nodes, 1);
  assert.equal(detail.summary.edges, 1);
  assert.equal(detail.summary.groups, 1);
  assert.equal(detail.snapshot.nodes[0].title, "A");
  assert.deepEqual(detail.snapshot.viewport, { x: 1, y: 2, zoom: 0.5 });
});

test("project archive imports and copies project graph with remapped Yjs history", () => {
  const db = {
    projects: [
      { id: "project:source", name: "Source", ownerId: "user:1", createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z" },
      { id: "project:other", name: "Other", ownerId: "user:1", createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z" },
    ],
    canvases: [
      {
        id: "canvas:source",
        projectId: "project:source",
        name: "Main",
        snapshot: { nodes: [{ id: "node:a", title: "A" }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      },
      {
        id: "canvas:other",
        projectId: "project:other",
        name: "Other",
        snapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      },
    ],
    assets: [
      { id: "asset:source", projectId: "project:source", type: "image", url: "https://example.test/a.png", mimeType: "image/png", size: 12, source: "upload", createdBy: "user:1", createdAt: "2026-06-09T00:00:00.000Z" },
    ],
    workflowUpdates: [
      { id: "update:source", canvasId: "canvas:source", clock: 2, update: "source-update", createdAt: "2026-06-09T00:02:00.000Z" },
      { id: "update:other", canvasId: "canvas:other", clock: 1, update: "other-update", createdAt: "2026-06-09T00:01:00.000Z" },
    ],
    workflowSnapshots: [
      { id: "snapshot:source", canvasId: "canvas:source", clock: 1, update: "source-snapshot", updateCount: 1, createdAt: "2026-06-09T00:01:00.000Z" },
    ],
  };

  const bundle = buildProjectBundle(db, "project:source");
  assert.equal(bundle.project.id, "project:source");
  assert.equal(bundle.canvases.length, 1);
  assert.equal(bundle.assets.length, 1);
  assert.equal(bundle.workflowUpdates.length, 1);
  assert.equal(bundle.workflowSnapshots.length, 1);

  const imported = importProjectBundle(db, bundle, { name: "Imported", ownerId: "user:2" });
  assert.equal(imported.project.name, "Imported");
  assert.equal(imported.project.ownerId, "user:2");
  assert.notEqual(imported.project.id, "project:source");
  assert.notEqual(imported.canvases[0].id, "canvas:source");
  assert.equal(imported.canvases[0].projectId, imported.project.id);
  assert.equal(imported.assets[0].projectId, imported.project.id);
  assert.equal(imported.workflowUpdates[0].canvasId, imported.canvases[0].id);
  assert.equal(imported.workflowSnapshots[0].canvasId, imported.canvases[0].id);
  assert.equal(imported.workflowUpdates[0].update, "source-update");

  const copied = copyProject(db, "project:source", { name: "Copy" });
  assert.equal(copied.project.name, "Copy");
  assert.equal(copied.canvases.length, 1);
  assert.notEqual(copied.canvases[0].id, "canvas:source");

  const deleted = deleteProjectGraph(db, "project:source");
  assert.equal(deleted.deletedProject.id, "project:source");
  assert.equal(deleted.deletedCanvases.length, 1);
  assert.equal(db.workflowUpdates.some((record) => record.canvasId === "canvas:source"), false);
  assert.equal(db.workflowUpdates.some((record) => record.canvasId === "canvas:other"), true);
});

test("project list exposes management summary counts", () => {
  const db = {
    projects: [
      { id: "project:a", name: "A", ownerId: "user:1", createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z" },
    ],
    canvases: [
      { id: "canvas:a", projectId: "project:a", name: "Main", snapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:05:00.000Z" },
      { id: "canvas:b", projectId: "project:a", name: "Second", snapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:06:00.000Z" },
    ],
    assets: [
      { id: "asset:a", projectId: "project:a", type: "image", url: "https://example.test/a.png", mimeType: "image/png", size: 12, source: "upload", createdBy: "user:1", createdAt: "2026-06-09T00:07:00.000Z" },
    ],
    workflowUpdates: [
      { id: "update:a", canvasId: "canvas:a", clock: 1, update: "update", createdAt: "2026-06-09T00:08:00.000Z" },
    ],
    workflowSnapshots: [
      { id: "snapshot:a", canvasId: "canvas:a", clock: 1, update: "snapshot", updateCount: 1, createdAt: "2026-06-09T00:09:00.000Z" },
    ],
  };

  const listed = buildProjectList(db);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].canvasCount, 2);
  assert.equal(listed[0].assetCount, 1);
  assert.equal(listed[0].historyUpdateCount, 1);
  assert.equal(listed[0].historySnapshotCount, 1);
  assert.equal(listed[0].updatedAt, "2026-06-09T00:09:00.000Z");
});

test("project bundle validation rejects incompatible imports", () => {
  assert.equal(validateProjectBundle(null).ok, false);
  assert.equal(validateProjectBundle({ version: 2, project: {}, canvases: [] }).ok, false);
  assert.equal(validateProjectBundle({ version: 1, project: { id: "project:a" }, canvases: [] }).ok, false);
  assert.equal(validateProjectBundle({
    version: 1,
    project: { id: "project:a", name: "A" },
    canvases: [{ id: "canvas:a", snapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }],
    workflowUpdates: [{ canvasId: "canvas:missing", update: "bad" }],
  }).ok, false);
  assert.equal(validateProjectBundle({
    version: 1,
    project: { id: "project:a", name: "A" },
    canvases: [{ id: "canvas:a", snapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }],
    assets: [],
    workflowUpdates: [],
    workflowSnapshots: [],
  }).ok, true);
});
