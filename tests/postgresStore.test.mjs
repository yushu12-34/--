import assert from "node:assert/strict";
import test from "node:test";
import {
  assetToRow,
  decodeYjsPayload,
  encodeYjsPayload,
  preparePostgresSnapshot,
  preserveExistingUserAuthFields,
  rowToAsset,
  rowToTask,
  rowToWorkflowSnapshot,
  rowToWorkflowUpdate,
  taskToRow,
} from "../apps/api/src/services/postgresStore.js";

const timestamp = "2026-06-13T00:00:00.000Z";

test("preparePostgresSnapshot adds default users and project owner members", () => {
  const snapshot = preparePostgresSnapshot({
    users: [],
    projects: [
      { id: "project:1", name: "Project", ownerId: "user:owner", createdAt: timestamp, updatedAt: timestamp },
    ],
  }, { timestamp });

  assert.equal(snapshot.users.some((user) => user.id === "default-user"), true);
  assert.equal(snapshot.users.some((user) => user.id === "user:owner"), true);
  assert.deepEqual(snapshot.projectMembers.map((member) => ({
    projectId: member.projectId,
    userId: member.userId,
    role: member.role,
  })), [
    { projectId: "project:1", userId: "user:owner", role: "owner" },
  ]);
});

test("preparePostgresSnapshot preserves auth fields for existing users", () => {
  const snapshot = preparePostgresSnapshot({
    users: [{
      id: "user:login",
      name: "Login User",
      email: "User@Example.COM",
      passwordHash: "scrypt:salt:hash",
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }, { timestamp });

  const user = snapshot.users.find((item) => item.id === "user:login");
  assert.equal(user.email, "User@Example.COM");
  assert.equal(user.passwordHash, "scrypt:salt:hash");
});

test("preserveExistingUserAuthFields keeps login fields when imported user is incomplete", () => {
  const users = preserveExistingUserAuthFields([
    { id: "user:login", name: "Login User" },
  ], [
    {
      id: "user:login",
      email: "login@example.com",
      passwordHash: "scrypt:old:hash",
      fingerprintHash: "fingerprint",
      fingerprintVersion: 2,
    },
  ]);

  assert.equal(users[0].email, "login@example.com");
  assert.equal(users[0].passwordHash, "scrypt:old:hash");
  assert.equal(users[0].fingerprintHash, "fingerprint");
  assert.equal(users[0].fingerprintVersion, 2);
});

test("asset rows preserve legacy JSON-only fields in metadata", () => {
  const asset = {
    id: "asset:1",
    projectId: "project:1",
    type: "image",
    url: "https://example.test/a.png",
    thumbnailUrl: "https://example.test/thumb.png",
    mimeType: "image/png",
    size: 42,
    storage: "remote-url",
    objectName: "project:1/image/task.png",
    createdBy: "user:1",
    createdAt: timestamp,
  };
  const row = assetToRow(asset, new Map([["project:1", "user:owner"]]), timestamp);
  const restored = rowToAsset({
    id: row.id,
    project_id: row.projectId,
    owner_user_id: row.ownerUserId,
    type: row.type,
    title: row.title,
    url: row.url,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });

  assert.equal(row.ownerUserId, "user:1");
  assert.equal(restored.mimeType, "image/png");
  assert.equal(restored.size, 42);
  assert.equal(restored.storage, "remote-url");
  assert.equal(restored.objectName, "project:1/image/task.png");
  assert.equal(restored.createdBy, "user:1");
});

test("task rows keep runtime fields in the input metadata envelope", () => {
  const task = {
    id: "task:1",
    projectId: "project:1",
    canvasId: "canvas:1",
    nodeId: "node:1",
    modelId: "model:1",
    type: "image.generate",
    status: "running",
    progress: 30,
    input: { prompt: "city" },
    timeoutMs: 120000,
    pollIntervalMs: 2000,
    createdBy: "local-user",
    startedAt: "2026-06-13T00:00:01.000Z",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const row = taskToRow(task, {
    projectIds: new Set(["project:1"]),
    canvasIds: new Set(["canvas:1"]),
  }, timestamp);
  const restored = rowToTask({
    id: row.id,
    project_id: row.projectId,
    canvas_id: row.canvasId,
    node_id: row.nodeId,
    user_id: row.userId,
    model_id: row.modelId,
    type: row.type,
    status: row.status,
    progress: row.progress,
    input: row.input,
    output: row.output,
    error: row.error,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });

  assert.deepEqual(restored.input, { prompt: "city" });
  assert.equal(restored.timeoutMs, 120000);
  assert.equal(restored.pollIntervalMs, 2000);
  assert.equal(restored.createdBy, "local-user");
  assert.equal(restored.startedAt, "2026-06-13T00:00:01.000Z");
});

test("Yjs update payloads round-trip through bytea buffers", () => {
  const buffer = encodeYjsPayload({ update: "base64-update", clock: 7, updateCount: 3 });
  assert.deepEqual(decodeYjsPayload(buffer), {
    update: "base64-update",
    clock: 7,
    updateCount: 3,
  });

  const update = rowToWorkflowUpdate({
    id: "update:1",
    canvas_id: "canvas:1",
    update_data: buffer,
    created_at: timestamp,
  });
  assert.equal(update.update, "base64-update");
  assert.equal(update.clock, 7);

  const snapshot = rowToWorkflowSnapshot({
    id: "snapshot:1",
    canvas_id: "canvas:1",
    snapshot: { clock: 2, updateCount: 1 },
    update_data: buffer,
    created_at: timestamp,
  });
  assert.equal(snapshot.update, "base64-update");
  assert.equal(snapshot.clock, 7);
  assert.equal(snapshot.updateCount, 3);
});
