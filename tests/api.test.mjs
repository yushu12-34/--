import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Y from "../apps/api/node_modules/yjs/dist/yjs.mjs";
import { applyEncodedYUpdate, createYjsSyncPayload, decodeYUpdate, encodeYUpdate, sanitizeAwarenessWireState } from "../apps/api/src/services/collaborationService.js";
import { buildAdminOverview, enrichAdminTask, selectRetryableAdminTasks } from "../apps/api/src/services/adminOverviewService.js";
import { createDbBackup, createRequiredDbBackup } from "../apps/api/src/services/backupService.js";
import { createDefaultDb, normalizeDb } from "../apps/api/src/db.js";
import { buildProjectBundle, buildProjectList, copyProject, deleteProjectGraph, importProjectBundle, validateProjectBundle } from "../apps/api/src/services/projectArchiveService.js";
import { appendSystemEvent, listSystemEvents } from "../apps/api/src/services/systemEventService.js";
import { resolveTaskRuntimeConfig } from "../apps/api/src/services/taskService.js";
import { buildYDocFromPersistence, getCanvasYjsPersistence, getCanvasYjsSnapshotDetail, listCanvasYjsSnapshots } from "../apps/api/src/services/yjsPersistenceService.js";
import { generateImageWithModel, generateVideoWithModel, renderAdapterTemplate } from "../apps/api/src/services/imageGeneration.js";
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

test("task runtime config is resolved from the selected model adapter", () => {
  const db = {
    models: [
      { id: "fast", adapter: { timeoutMs: 45000, pollIntervalMs: 1200 } },
      { id: "slow", adapter: { timeoutMs: 300000, pollIntervalMs: 5000 } },
      { id: "invalid", adapter: { timeoutMs: 0, pollIntervalMs: -1 } },
    ],
  };

  assert.deepEqual(resolveTaskRuntimeConfig(db, "fast"), { timeoutMs: 45000, pollIntervalMs: 1200 });
  assert.deepEqual(resolveTaskRuntimeConfig(db, "slow"), { timeoutMs: 300000, pollIntervalMs: 5000 });
  assert.deepEqual(resolveTaskRuntimeConfig(db, "missing"), { timeoutMs: 120000, pollIntervalMs: 2000 });
  assert.deepEqual(resolveTaskRuntimeConfig(db, "invalid"), { timeoutMs: 120000, pollIntervalMs: 2000 });
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
      task: "/v1/images/tasks/{task_id}",
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
      task: "/v1/images/tasks/task-1",
    },
  });
});

test("built-in Z-Image models use the current images task polling API", () => {
  const db = createDefaultDb("2026-07-03T00:00:00.000Z");
  const turbo = db.models.find((model) => model.id === "z-image-turbo");
  const standard = db.models.find((model) => model.id === "z-image");

  assert.equal(turbo.adapter.taskPathTemplate, "/v1/images/tasks/{task_id}");
  assert.equal(turbo.defaultParams.model, "z-image-turbo");
  assert.equal(standard.adapter.taskPathTemplate, "/v1/images/tasks/{task_id}");
  assert.equal(standard.defaultParams.num_inference_steps, 40);

  turbo.adapter.configVersion = "legacy";
  turbo.adapter.taskPathTemplate = "/v1/tasks/{task_id}";
  delete turbo.defaultParams.model;
  standard.adapter.configVersion = "legacy";
  standard.adapter.taskPathTemplate = "/v1/tasks/{task_id}";
  standard.defaultParams.num_inference_steps = 50;

  const normalized = normalizeDb(db, "2026-07-03T00:01:00.000Z");
  assert.equal(normalized.changed, true);
  assert.equal(turbo.adapter.taskPathTemplate, "/v1/images/tasks/{task_id}");
  assert.equal(turbo.defaultParams.model, "z-image-turbo");
  assert.equal(standard.adapter.taskPathTemplate, "/v1/images/tasks/{task_id}");
  assert.equal(standard.defaultParams.num_inference_steps, 40);
});

test("built-in Seedance video models use Ark contents task API", () => {
  const db = createDefaultDb("2026-07-03T00:00:00.000Z");
  const provider = db.providers.find((item) => item.id === "volcengine-ark");
  const standard = db.models.find((model) => model.id === "seedance-2");
  const fast = db.models.find((model) => model.id === "seedance-2-fast");

  assert.equal(provider.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(provider.authType, "bearer");
  assert.equal(standard.type, "video");
  assert.equal(standard.defaultParams.model, "doubao-seedance-2-0-260128");
  assert.equal(standard.adapter.submitPath, "/contents/generations/tasks");
  assert.equal(standard.adapter.taskPathTemplate, "/contents/generations/tasks/{task_id}");
  assert.equal(standard.adapter.resultPath, "content.video_url");
  assert.equal(fast.defaultParams.model, "doubao-seedance-2-0-fast-260128");
  assert.deepEqual(fast.publicParamSchema.resolution.options, ["480p", "720p"]);
});

test("seedance video adapter creates content generation task and resolves video url", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      requests.push({
        url: String(url),
        headers: options.headers || {},
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      if (String(url).endsWith("/contents/generations/tasks") && options.method === "POST") {
        return new Response(JSON.stringify({ id: "cgt-1" }), { status: 200 });
      }
      if (String(url).endsWith("/contents/generations/tasks/cgt-1")) {
        return new Response(JSON.stringify({
          id: "cgt-1",
          status: "succeeded",
          content: { video_url: "https://cdn.test/video.mp4" },
        }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const result = await generateVideoWithModel(
      { enabled: true, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", authType: "bearer", secretValue: "ark-key", timeoutSeconds: 1 },
      {
        enabled: true,
        defaultParams: {
          model: "doubao-seedance-2-0-260128",
          resolution: "720p",
          ratio: "16:9",
          duration: 5,
          generate_audio: true,
          watermark: false,
          web_search: true,
        },
        adapter: {
          kind: "seedance-video",
          submitPath: "/contents/generations/tasks",
          taskPathTemplate: "/contents/generations/tasks/{task_id}",
          resultPath: "content.video_url",
          pollIntervalMs: 1,
          timeoutMs: 100,
        },
      },
      {
        prompt: "first person tea ad",
        params: { duration: 8 },
        images: ["https://asset.test/frame.png"],
        videos: ["https://asset.test/ref.mp4"],
        audios: ["https://asset.test/music.mp3"],
      },
    );

    assert.equal(result.providerTaskId, "cgt-1");
    assert.equal(result.url, "https://cdn.test/video.mp4");
    assert.equal(requests[0].headers.authorization, "Bearer ark-key");
    assert.deepEqual(requests[0].body, {
      model: "doubao-seedance-2-0-260128",
      resolution: "720p",
      ratio: "16:9",
      duration: 8,
      generate_audio: true,
      watermark: false,
      tools: [{ type: "web_search" }],
      content: [
        { type: "text", text: "first person tea ad" },
        { type: "image_url", image_url: { url: "https://asset.test/frame.png" }, role: "reference_image" },
        { type: "video_url", video_url: { url: "https://asset.test/ref.mp4" }, role: "reference_video" },
        { type: "audio_url", audio_url: { url: "https://asset.test/music.mp3" }, role: "reference_audio" },
      ],
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("seedance defaults upsert preserves existing Ark provider secret", async () => {
  const previousDataDir = process.env.DATA_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "seedance-db-"));
  try {
    process.env.DATA_DIR = tempDir;
    const { ensureDb, updateProvider, readJsonQueued, upsertSeedanceDefaults } = await import(`../apps/api/src/db.js?seedance=${Date.now()}`);
    await ensureDb();
    await updateProvider("volcengine-ark", { secretValue: "existing-key" });

    const result = await upsertSeedanceDefaults();
    const db = await readJsonQueued();
    const provider = db.providers.find((item) => item.id === "volcengine-ark");
    const modelIds = db.models.filter((item) => item.type === "video").map((item) => item.id).sort();

    assert.equal(result.models.length, 2);
    assert.equal(provider.secretValue, "existing-key");
    assert.deepEqual(modelIds, ["seedance-2", "seedance-2-fast"]);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("z-image adapter uses model request template and mapped polling fields", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : undefined });
      if (String(url).endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ id: "task-1", state: "queued" }), { status: 200 });
      }
      if (String(url).endsWith("/v1/jobs/task-1")) {
        return new Response(JSON.stringify({ state: "completed", output: [{ image_url: "/static/task-1.png" }] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const result = await generateImageWithModel(
      { enabled: true, baseUrl: "http://provider.test", timeoutSeconds: 1 },
      {
        enabled: true,
        defaultParams: { size: "1k", n: 1, optional: "" },
        adapter: {
          kind: "z-image-turbo",
          submitPath: "/v1/images/generations",
          requestTemplate: {
            prompt: "{prompt}",
            image_size: "{params.size}",
            samples: "{params.n}",
            optional: "{params.optional}",
          },
          taskIdPath: "id",
          taskPathTemplate: "/v1/jobs/{task_id}",
          statusPath: "state",
          successStatusValues: ["completed"],
          resultPath: "output.0.image_url",
          pollIntervalMs: 1,
          timeoutMs: 100,
        },
      },
      { prompt: "city skyline", params: { size: "720p" } },
    );

    assert.equal(result.providerTaskId, "task-1");
    assert.equal(result.url, "http://provider.test/static/task-1.png");
    assert.deepEqual(requests[0].body, { prompt: "city skyline", image_size: "720p", samples: 1 });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("z-image adapter accepts synchronous image responses without task id", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: "abc123" }] }), { status: 200 });

    const result = await generateImageWithModel(
      { enabled: true, baseUrl: "http://provider.test", timeoutSeconds: 1 },
      { enabled: true, defaultParams: { n: 1 }, adapter: { kind: "z-image", submitPath: "/v1/images/generations" } },
      { prompt: "portrait" },
    );

    assert.equal(result.providerTaskId, undefined);
    assert.equal(result.url, "data:image/png;base64,abc123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("z-image adapter retries transient task polling 404 responses", async () => {
  const previousFetch = globalThis.fetch;
  let pollCount = 0;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ task_id: "task-404-once", status: "queued" }), { status: 200 });
      }
      pollCount += 1;
      if (pollCount === 1) {
        return new Response(JSON.stringify({ detail: "Task not found" }), { status: 404, statusText: "Not Found" });
      }
      return new Response(JSON.stringify({ status: "finished", data: [{ url: "/static/task-404-once.png" }] }), { status: 200 });
    };

    const result = await generateImageWithModel(
      { enabled: true, baseUrl: "http://provider.test", timeoutSeconds: 1 },
      {
        enabled: true,
        defaultParams: { n: 1 },
        adapter: {
          kind: "z-image-turbo",
          submitPath: "/v1/images/generations",
          taskPathTemplate: "/v1/images/tasks/{task_id}",
          pollIntervalMs: 1,
          taskNotFoundRetryMs: 100,
          timeoutMs: 1000,
        },
      },
      { prompt: "portrait" },
    );

    assert.equal(pollCount, 2);
    assert.equal(result.url, "http://provider.test/static/task-404-once.png");
  } finally {
    globalThis.fetch = previousFetch;
  }
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

test("project list sorts by latest activity first", () => {
  const db = {
    projects: [
      { id: "project:old", name: "Old", ownerId: "user:1", createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z" },
      { id: "project:active", name: "Active", ownerId: "user:1", createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:01:00.000Z" },
    ],
    canvases: [
      { id: "canvas:old", projectId: "project:old", name: "Old Canvas", snapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:02:00.000Z" },
      { id: "canvas:active", projectId: "project:active", name: "Active Canvas", snapshot: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:10:00.000Z" },
    ],
    assets: [
      { id: "asset:old", projectId: "project:old", type: "image", url: "https://example.test/old.png", mimeType: "image/png", size: 12, source: "upload", createdBy: "user:1", createdAt: "2026-06-09T00:03:00.000Z" },
    ],
    workflowUpdates: [],
    workflowSnapshots: [],
  };

  assert.deepEqual(buildProjectList(db).map((project) => project.id), ["project:active", "project:old"]);
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

test("createDbBackup copies db.json into operation-specific backup file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anime-canvas-backup-"));
  try {
    const dbFile = path.join(dir, "db.json");
    const backupDir = path.join(dir, "backups");
    await writeFile(dbFile, JSON.stringify({ projects: [{ id: "project:a" }] }), "utf8");

    const backup = await createDbBackup("project import", {
      dbFile,
      backupDir,
      now: new Date("2026-06-11T10:00:00.000Z"),
    });

    assert.equal(backup.operation, "project-import");
    assert.ok(backup.file.endsWith("2026-06-11T10-00-00-000Z_project-import.db.json"));
    assert.deepEqual(JSON.parse(await readFile(backup.file, "utf8")), { projects: [{ id: "project:a" }] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createRequiredDbBackup blocks dangerous writes when backup fails", async () => {
  await assert.rejects(
    () => createRequiredDbBackup("history-restore", {
      dbFile: path.join(os.tmpdir(), "missing-anime-canvas-db.json"),
      backupDir: path.join(os.tmpdir(), "anime-canvas-backups"),
    }),
    (error) => {
      assert.equal(error.code, "DB_BACKUP_FAILED");
      assert.equal(error.operation, "history-restore");
      assert.match(error.message, /数据备份失败/);
      return true;
    },
  );
});

test("system events are sanitized, summarized, filtered and capped", () => {
  const db = { systemEvents: [] };

  appendSystemEvent(db, {
    id: "event:1",
    level: "error",
    category: "api",
    source: "test",
    message: "API failed",
    metadata: {
      authorization: "Bearer secret",
      nested: { apiKey: "key-value", visible: "ok" },
      longText: "x".repeat(700),
    },
    createdAt: "2026-06-11T00:00:00.000Z",
  });

  appendSystemEvent(db, {
    id: "event:2",
    level: "warning",
    category: "security",
    source: "test",
    message: "Unauthorized",
    metadata: { path: "/internal/providers" },
    createdAt: "2026-06-11T00:01:00.000Z",
  }, { maxEvents: 2 });

  appendSystemEvent(db, {
    id: "event:3",
    level: "info",
    category: "system",
    source: "test",
    message: "Started",
    createdAt: "2026-06-11T00:02:00.000Z",
  }, { maxEvents: 2 });

  assert.equal(db.systemEvents.length, 2);
  assert.equal(db.systemEvents[0].id, "event:3");
  assert.equal(db.systemEvents[1].id, "event:2");

  const fullDb = {
    systemEvents: [
      db.systemEvents[0],
      db.systemEvents[1],
      {
        id: "event:1",
        level: "error",
        category: "api",
        source: "test",
        message: "API failed",
        metadata: {
          authorization: "[redacted]",
          nested: { apiKey: "[redacted]", visible: "ok" },
          longText: "x".repeat(500) + "...",
        },
        createdAt: "2026-06-11T00:00:00.000Z",
      },
    ],
  };

  const listed = listSystemEvents(fullDb);
  assert.equal(listed.summary.total, 3);
  assert.equal(listed.summary.byLevel.error, 1);
  assert.equal(listed.summary.byLevel.warning, 1);
  assert.equal(listed.summary.byCategory.security, 1);
  assert.equal(listed.summary.latestErrorAt, "2026-06-11T00:00:00.000Z");

  const errors = listSystemEvents(fullDb, { level: "error" });
  assert.equal(errors.events.length, 1);
  assert.equal(errors.events[0].metadata.authorization, "[redacted]");
  assert.equal(errors.events[0].metadata.nested.apiKey, "[redacted]");
  assert.equal(errors.events[0].metadata.nested.visible, "ok");
  assert.equal(errors.events[0].metadata.longText.length, 503);

  const security = listSystemEvents(fullDb, { category: "security" });
  assert.equal(security.events.length, 1);
  assert.equal(security.events[0].message, "Unauthorized");
});

test("admin overview summarizes task health, runtime signals and backups", () => {
  const db = {
    providers: [
      { id: "provider:enabled", name: "Enabled Provider", enabled: true },
      { id: "provider:disabled", name: "Disabled Provider", enabled: false },
    ],
    models: [
      { id: "model:image", providerId: "provider:enabled", displayName: "Image Model", type: "image", enabled: true },
      { id: "model:video", providerId: "provider:disabled", displayName: "Video Model", type: "video", enabled: false },
    ],
    tasks: [
      {
        id: "task:success",
        modelId: "model:image",
        type: "image.generate",
        status: "succeeded",
        input: { prompt: "finished image" },
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:02.000Z",
      },
      {
        id: "task:failed",
        modelId: "model:video",
        type: "video.generate",
        status: "failed",
        input: { prompt: "failed video" },
        error: "connection refused by model provider",
        createdAt: "2026-06-11T00:01:00.000Z",
        updatedAt: "2026-06-11T00:01:04.000Z",
      },
      {
        id: "task:running",
        modelId: "model:image",
        type: "image.generate",
        status: "running",
        input: { prompt: "running image" },
        createdAt: "2026-06-11T00:02:00.000Z",
        updatedAt: "2026-06-11T00:02:01.000Z",
      },
    ],
    systemEvents: [
      { id: "event:backup", level: "info", category: "backup", source: "test", message: "backup ok", createdAt: "2026-06-11T00:03:00.000Z" },
      { id: "event:warn", level: "warning", category: "security", source: "test", message: "warning", createdAt: "2026-06-11T00:02:30.000Z" },
      { id: "event:error", level: "error", category: "api", source: "test", message: "error", createdAt: "2026-06-11T00:02:00.000Z" },
    ],
  };

  const overview = buildAdminOverview(db);
  assert.equal(overview.tasks.total, 3);
  assert.equal(overview.tasks.byStatus.succeeded, 1);
  assert.equal(overview.tasks.byStatus.failed, 1);
  assert.equal(overview.tasks.active, 1);
  assert.equal(overview.tasks.successRate, 33.3);
  assert.equal(overview.tasks.failureRate, 33.3);
  assert.equal(overview.tasks.averageDurationMs, 3000);
  assert.equal(overview.tasks.byErrorCategory.connection, 1);
  assert.equal(overview.recentFailedTasks[0].providerName, "Disabled Provider");
  assert.equal(overview.modelRuntime.models.enabled, 1);
  assert.equal(overview.modelRuntime.models.disabled, 1);
  assert.equal(overview.modelRuntime.models.byType.image, 1);
  assert.equal(overview.modelRuntime.providers.enabled, 1);
  assert.equal(overview.events.summary.byLevel.error, 1);
  assert.equal(overview.events.recentSignals.length, 2);
  assert.equal(overview.backup.latest.id, "event:backup");
  assert.equal(overview.backup.total, 1);
});

test("admin task enrichment exposes display names, duration and input summary", () => {
  const task = enrichAdminTask(
    {
      id: "task:1",
      modelId: "model:1",
      status: "failed",
      input: { prompt: "x".repeat(220) },
      error: "unauthorized request",
      createdAt: "2026-06-11T00:00:00.000Z",
      startedAt: "2026-06-11T00:00:10.000Z",
      updatedAt: "2026-06-11T00:00:11.500Z",
    },
    [{ id: "model:1", providerId: "provider:1", displayName: "Private Model" }],
    [{ id: "provider:1", name: "Private Provider" }],
  );

  assert.equal(task.modelDisplayName, "Private Model");
  assert.equal(task.providerName, "Private Provider");
  assert.equal(task.durationMs, 1500);
  assert.equal(task.errorCategory, "auth");
  assert.equal(task.inputSummary.length, 203);
  assert.ok(task.inputSummary.endsWith("..."));
});

test("selectRetryableAdminTasks filters by status, error category and explicit ids", () => {
  const tasks = [
    { id: "failed:connection", status: "failed", errorCategory: "connection" },
    { id: "failed:timeout", status: "failed", errorCategory: "timeout" },
    { id: "cancelled:other", status: "cancelled", errorCategory: "other" },
    { id: "running:connection", status: "running", errorCategory: "connection" },
    { id: "succeeded:connection", status: "succeeded", errorCategory: "connection" },
  ];

  const connection = selectRetryableAdminTasks(tasks, { errorCategory: "connection" });
  assert.deepEqual(connection.selected.map((task) => task.id), ["failed:connection"]);

  const explicit = selectRetryableAdminTasks(tasks, {
    taskIds: ["failed:connection", "running:connection", "cancelled:other"],
  });
  assert.deepEqual(explicit.selected.map((task) => task.id), ["failed:connection", "cancelled:other"]);
  assert.deepEqual(explicit.skipped, [{ taskId: "running:connection", reason: "status", status: "running" }]);

  const limited = selectRetryableAdminTasks(tasks, { limit: 1 });
  assert.equal(limited.selected.length, 1);
  assert.equal(limited.skipped.some((item) => item.reason === "limit"), true);
});
