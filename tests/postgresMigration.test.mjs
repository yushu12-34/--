import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePreparedSnapshot,
  diffCounts,
  shouldBlockMigration,
  summarizeSnapshot,
} from "../scripts/postgres-migration-utils.mjs";
import { preparePostgresSnapshot } from "../apps/api/src/services/postgresStore.js";

const timestamp = "2026-06-13T00:00:00.000Z";

test("migration analysis reports missing references without blocking non-strict imports", () => {
  const source = {
    users: [{ id: "user:1", name: "User", createdAt: timestamp, updatedAt: timestamp }],
    projects: [{ id: "project:1", name: "Project", ownerId: "user:1", createdAt: timestamp, updatedAt: timestamp }],
    canvases: [{ id: "canvas:1", projectId: "project:1", name: "Main", snapshot: { nodes: [], edges: [] }, createdAt: timestamp, updatedAt: timestamp }],
    assets: [{ id: "asset:orphan", projectId: "project:missing", type: "image", url: "https://example.test/a.png", createdAt: timestamp }],
    tasks: [{ id: "task:orphan", projectId: "project:missing", canvasId: "canvas:missing", type: "image.generate", status: "failed", input: {}, createdAt: timestamp, updatedAt: timestamp }],
    providers: [],
    models: [],
    systemEvents: [],
    workflowUpdates: [{ id: "update:missing", canvasId: "canvas:missing", update: "bad", createdAt: timestamp }],
    workflowSnapshots: [],
  };
  const analysis = analyzePreparedSnapshot(source, preparePostgresSnapshot(source, { timestamp }));

  assert.equal(analysis.errors.length, 0);
  assert.equal(analysis.warnings.some((issue) => issue.message.includes("asset:orphan")), true);
  assert.equal(analysis.warnings.some((issue) => issue.message.includes("task:orphan")), true);
  assert.equal(analysis.warnings.some((issue) => issue.message.includes("update:missing")), true);
  assert.equal(shouldBlockMigration(analysis, { strict: false }), false);
  assert.equal(shouldBlockMigration(analysis, { strict: true }), true);
});

test("migration analysis blocks duplicate ids", () => {
  const source = {
    users: [{ id: "user:1", name: "User", createdAt: timestamp, updatedAt: timestamp }],
    projects: [
      { id: "project:1", name: "A", ownerId: "user:1", createdAt: timestamp, updatedAt: timestamp },
      { id: "project:1", name: "B", ownerId: "user:1", createdAt: timestamp, updatedAt: timestamp },
    ],
    canvases: [],
    assets: [],
    tasks: [],
    providers: [],
    models: [],
    systemEvents: [],
    workflowUpdates: [],
    workflowSnapshots: [],
  };
  const analysis = analyzePreparedSnapshot(source, preparePostgresSnapshot(source, { timestamp }));

  assert.equal(analysis.errors.length, 1);
  assert.match(analysis.errors[0].message, /duplicate id/);
  assert.equal(shouldBlockMigration(analysis, { strict: false }), true);
});

test("migration count diff reports only changed tables", () => {
  assert.deepEqual(diffCounts(
    { projects: 2, canvases: 4, assets: 1 },
    { projects: 2, canvases: 3, assets: 1 },
  ), [
    { table: "canvases", expected: 4, actual: 3 },
  ]);
});

test("migration snapshot summary uses PostgreSQL table names", () => {
  const summary = summarizeSnapshot({
    users: [{}],
    userDevices: [{}, {}],
    projectMembers: [{}],
    projects: [{}],
    canvases: [],
    assets: [{}],
    tasks: [],
    providers: [{}],
    models: [{}],
    systemEvents: [{}],
    workflowUpdates: [{}, {}, {}],
    workflowSnapshots: [{}],
  });

  assert.equal(summary.users, 1);
  assert.equal(summary.user_devices, 2);
  assert.equal(summary.project_members, 1);
  assert.equal(summary.yjs_updates, 3);
  assert.equal(summary.yjs_snapshots, 1);
});
