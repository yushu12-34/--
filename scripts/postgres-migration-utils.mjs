import { readFile } from "node:fs/promises";
import path from "node:path";
import { preparePostgresSnapshot } from "../apps/api/src/services/postgresStore.js";

export const TABLE_SPECS = [
  ["users", "users"],
  ["user_devices", "userDevices"],
  ["project_members", "projectMembers"],
  ["projects", "projects"],
  ["canvases", "canvases"],
  ["assets", "assets"],
  ["tasks", "tasks"],
  ["providers", "providers"],
  ["models", "models"],
  ["system_events", "systemEvents"],
  ["yjs_updates", "workflowUpdates"],
  ["yjs_snapshots", "workflowSnapshots"],
];

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function defaultDbFile() {
  const dataDir = process.env.DATA_DIR || path.resolve("data");
  return process.env.DB_FILE || path.join(dataDir, "db.json");
}

export async function readSourceDb(file = defaultDbFile()) {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw);
}

export function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item?.[key] || "(empty)";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function findDuplicateIds(items) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    if (!item?.id) continue;
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates].sort();
}

export function summarizeSnapshot(snapshot = {}) {
  return Object.fromEntries(TABLE_SPECS.map(([table, key]) => [table, asArray(snapshot[key]).length]));
}

function skippedCountFromWarnings(warnings = [], table) {
  const skippedPatterns = {
    assets: /asset .* will be skipped/,
    yjs_updates: /Yjs record .* will be skipped/,
    yjs_snapshots: /Yjs record .* will be skipped/,
  };
  const pattern = skippedPatterns[table];
  if (!pattern) return 0;
  return warnings.filter((w) => pattern.test(w.message)).length;
}

export function adjustedExpectedCounts(analysis) {
  const counts = { ...analysis.counts };
  for (const [table] of TABLE_SPECS) {
    counts[table] = Math.max(0, counts[table] - skippedCountFromWarnings(analysis.warnings, table));
  }
  return counts;
}

export function diffCounts(expected = {}, actual = {}) {
  return TABLE_SPECS
    .map(([table]) => ({
      table,
      expected: Number(expected[table] || 0),
      actual: Number(actual[table] || 0),
    }))
    .filter((item) => item.expected !== item.actual);
}

function addIssue(issues, severity, message, meta = {}) {
  issues.push({ severity, message, ...meta });
}

export function analyzePreparedSnapshot(sourceDb = {}, prepared = preparePostgresSnapshot(sourceDb)) {
  const issues = [];
  const projectIds = new Set(asArray(prepared.projects).map((project) => project.id));
  const canvasesWithValidProject = asArray(prepared.canvases).filter((canvas) => projectIds.has(canvas.projectId));
  const canvasIds = new Set(canvasesWithValidProject.map((canvas) => canvas.id));
  const providerIds = new Set(asArray(prepared.providers).map((provider) => provider.id));

  for (const [key, items] of Object.entries({
    users: prepared.users,
    projects: prepared.projects,
    canvases: prepared.canvases,
    assets: prepared.assets,
    tasks: prepared.tasks,
    providers: prepared.providers,
    models: prepared.models,
    workflowUpdates: prepared.workflowUpdates,
    workflowSnapshots: prepared.workflowSnapshots,
  })) {
    const duplicates = findDuplicateIds(asArray(items));
    if (duplicates.length) addIssue(issues, "error", `${key} has duplicate id(s): ${duplicates.join(", ")}`, { key, ids: duplicates });
  }

  for (const canvas of asArray(prepared.canvases)) {
    if (!projectIds.has(canvas.projectId)) {
      addIssue(issues, "error", `canvas ${canvas.id} references missing project ${canvas.projectId}`, { key: "canvases", id: canvas.id });
    }
  }

  for (const asset of asArray(prepared.assets)) {
    if (!projectIds.has(asset.projectId)) {
      addIssue(issues, "warning", `asset ${asset.id} references missing project ${asset.projectId}; it will be skipped by the PostgreSQL adapter`, { key: "assets", id: asset.id });
    }
  }

  for (const task of asArray(prepared.tasks)) {
    if (task.projectId && !projectIds.has(task.projectId)) {
      addIssue(issues, "warning", `task ${task.id} references missing project ${task.projectId}; project_id will be null`, { key: "tasks", id: task.id });
    }
    if (task.canvasId && !canvasIds.has(task.canvasId)) {
      addIssue(issues, "warning", `task ${task.id} references missing canvas ${task.canvasId}; canvas_id will be null`, { key: "tasks", id: task.id });
    }
  }

  for (const model of asArray(prepared.models)) {
    if (model.providerId && !providerIds.has(model.providerId)) {
      addIssue(issues, "warning", `model ${model.id} references missing provider ${model.providerId}; provider_id will be null`, { key: "models", id: model.id });
    }
  }

  for (const record of [...asArray(prepared.workflowUpdates), ...asArray(prepared.workflowSnapshots)]) {
    if (!canvasIds.has(record.canvasId)) {
      addIssue(issues, "warning", `Yjs record ${record.id || "(unknown)"} references missing canvas ${record.canvasId}; it will be skipped`, { key: "yjs", id: record.id });
    }
  }

  if (asArray(sourceDb.users).length !== asArray(prepared.users).length) {
    addIssue(issues, "info", `users will change from ${asArray(sourceDb.users).length} to ${asArray(prepared.users).length} because synthetic owners/devices may be added`);
  }
  if (asArray(sourceDb.projectMembers).length !== asArray(prepared.projectMembers).length) {
    addIssue(issues, "info", `project_members will change from ${asArray(sourceDb.projectMembers).length} to ${asArray(prepared.projectMembers).length} because each project needs an owner member`);
  }

  return {
    prepared,
    counts: summarizeSnapshot(prepared),
    issues,
    errors: issues.filter((issue) => issue.severity === "error"),
    warnings: issues.filter((issue) => issue.severity === "warning"),
    infos: issues.filter((issue) => issue.severity === "info"),
    breakdowns: {
      assetsByType: countBy(prepared.assets, "type"),
      tasksByStatus: countBy(prepared.tasks, "status"),
      modelsByType: countBy(prepared.models, "type"),
    },
  };
}

export function printCounts(counts = {}) {
  for (const [table] of TABLE_SPECS) {
    console.log(`${table.padEnd(20)} ${String(counts[table] || 0).padStart(6)}`);
  }
}

export function printIssues(issues = {}) {
  const groups = [
    ["Errors", issues.errors || []],
    ["Warnings", issues.warnings || []],
    ["Info", issues.infos || []],
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    console.log(`${label}:`);
    for (const issue of items) console.log(`- ${issue.message}`);
    console.log("");
  }
}

export function shouldBlockMigration(analysis, options = {}) {
  if (analysis.errors.length) return true;
  return options.strict === true && analysis.warnings.length > 0;
}
