import { emptySnapshot } from "../db.js";
import { id, now } from "../utils/http.js";

const SUPPORTED_BUNDLE_VERSION = 1;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function ensureCollections(db) {
  if (!Array.isArray(db.projects)) db.projects = [];
  if (!Array.isArray(db.canvases)) db.canvases = [];
  if (!Array.isArray(db.assets)) db.assets = [];
  if (!Array.isArray(db.workflowUpdates)) db.workflowUpdates = [];
  if (!Array.isArray(db.workflowSnapshots)) db.workflowSnapshots = [];
}

function latestTimestamp(values) {
  return values
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
}

export function buildProjectList(db) {
  ensureCollections(db);
  return db.projects.map((project) => {
    const canvases = db.canvases.filter((item) => item.projectId === project.id);
    const canvasIds = new Set(canvases.map((canvas) => canvas.id));
    const assets = db.assets.filter((item) => item.projectId === project.id);
    const workflowUpdates = db.workflowUpdates.filter((item) => canvasIds.has(item.canvasId));
    const workflowSnapshots = db.workflowSnapshots.filter((item) => canvasIds.has(item.canvasId));
    const latest = latestTimestamp([
      project.updatedAt,
      ...canvases.map((canvas) => canvas.updatedAt || canvas.createdAt),
      ...assets.map((asset) => asset.createdAt),
      ...workflowUpdates.map((record) => record.createdAt),
      ...workflowSnapshots.map((record) => record.createdAt),
    ]);
    return {
      ...project,
      updatedAt: latest ? new Date(latest).toISOString() : project.updatedAt,
      canvasCount: canvases.length,
      assetCount: assets.length,
      historyUpdateCount: workflowUpdates.length,
      historySnapshotCount: workflowSnapshots.length,
      lastCanvasUpdatedAt: canvases
        .map((canvas) => canvas.updatedAt || canvas.createdAt)
        .filter(Boolean)
        .sort()
        .at(-1),
    };
  });
}

export function validateProjectBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    return { ok: false, error: "导入文件不是有效的项目 JSON" };
  }
  if (Number(bundle.version) !== SUPPORTED_BUNDLE_VERSION) {
    return { ok: false, error: `不支持的项目文件版本：${bundle.version ?? "未知"}` };
  }
  if (!bundle.project || typeof bundle.project !== "object" || Array.isArray(bundle.project)) {
    return { ok: false, error: "项目文件缺少 project 信息" };
  }
  if (!Array.isArray(bundle.canvases) || bundle.canvases.length === 0) {
    return { ok: false, error: "项目文件至少需要包含一个画布" };
  }
  if (bundle.assets !== undefined && !Array.isArray(bundle.assets)) {
    return { ok: false, error: "项目文件中的 assets 必须是数组" };
  }
  if (bundle.workflowUpdates !== undefined && !Array.isArray(bundle.workflowUpdates)) {
    return { ok: false, error: "项目文件中的 workflowUpdates 必须是数组" };
  }
  if (bundle.workflowSnapshots !== undefined && !Array.isArray(bundle.workflowSnapshots)) {
    return { ok: false, error: "项目文件中的 workflowSnapshots 必须是数组" };
  }

  const canvasIds = new Set();
  for (const [index, canvas] of bundle.canvases.entries()) {
    if (!canvas || typeof canvas !== "object" || Array.isArray(canvas)) {
      return { ok: false, error: `第 ${index + 1} 个画布不是有效对象` };
    }
    if (!canvas.id) return { ok: false, error: `第 ${index + 1} 个画布缺少 id` };
    if (canvasIds.has(canvas.id)) return { ok: false, error: `画布 id 重复：${canvas.id}` };
    canvasIds.add(canvas.id);
    if (canvas.snapshot !== undefined) {
      if (!canvas.snapshot || typeof canvas.snapshot !== "object" || Array.isArray(canvas.snapshot)) {
        return { ok: false, error: `画布「${canvas.name || canvas.id}」的 snapshot 无效` };
      }
      if (canvas.snapshot.nodes !== undefined && !Array.isArray(canvas.snapshot.nodes)) {
        return { ok: false, error: `画布「${canvas.name || canvas.id}」的 nodes 必须是数组` };
      }
      if (canvas.snapshot.edges !== undefined && !Array.isArray(canvas.snapshot.edges)) {
        return { ok: false, error: `画布「${canvas.name || canvas.id}」的 edges 必须是数组` };
      }
      if (canvas.snapshot.groups !== undefined && !Array.isArray(canvas.snapshot.groups)) {
        return { ok: false, error: `画布「${canvas.name || canvas.id}」的 groups 必须是数组` };
      }
    }
  }

  for (const record of bundle.workflowUpdates || []) {
    if (!record?.canvasId || !canvasIds.has(record.canvasId)) {
      return { ok: false, error: "workflowUpdates 中包含无法匹配的 canvasId" };
    }
  }
  for (const record of bundle.workflowSnapshots || []) {
    if (!record?.canvasId || !canvasIds.has(record.canvasId)) {
      return { ok: false, error: "workflowSnapshots 中包含无法匹配的 canvasId" };
    }
  }

  return { ok: true };
}

export function buildProjectBundle(db, projectId) {
  ensureCollections(db);
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) return null;
  const canvases = db.canvases.filter((item) => item.projectId === project.id);
  const canvasIds = new Set(canvases.map((canvas) => canvas.id));
  return {
    version: 1,
    exportedAt: now(),
    project: cloneJson(project),
    canvases: cloneJson(canvases),
    assets: cloneJson(db.assets.filter((item) => item.projectId === project.id)),
    workflowUpdates: cloneJson(db.workflowUpdates.filter((item) => canvasIds.has(item.canvasId))),
    workflowSnapshots: cloneJson(db.workflowSnapshots.filter((item) => canvasIds.has(item.canvasId))),
  };
}

export function importProjectBundle(db, bundle, options = {}) {
  ensureCollections(db);
  if (!validateProjectBundle(bundle).ok) return null;
  const timestamp = now();
  const sourceProject = bundle.project;
  const canvasIdMap = new Map();
  const project = {
    ...cloneJson(sourceProject),
    id: id("project"),
    name: String(options.name || sourceProject.name || "Imported Project"),
    ownerId: String(options.ownerId || sourceProject.ownerId || "default-user"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const sourceCanvases = Array.isArray(bundle.canvases) && bundle.canvases.length
    ? bundle.canvases
    : [{ id: "canvas:imported", name: "Main Canvas", snapshot: emptySnapshot }];
  const canvases = sourceCanvases.map((canvas, index) => {
    const nextId = id("canvas");
    canvasIdMap.set(canvas.id, nextId);
    return {
      ...cloneJson(canvas),
      id: nextId,
      projectId: project.id,
      name: String(canvas.name || `Canvas ${index + 1}`),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  });
  const assets = (Array.isArray(bundle.assets) ? bundle.assets : []).map((asset) => ({
    ...cloneJson(asset),
    id: id("asset"),
    projectId: project.id,
    createdAt: asset.createdAt || timestamp,
  }));
  const workflowUpdates = (Array.isArray(bundle.workflowUpdates) ? bundle.workflowUpdates : [])
    .filter((record) => canvasIdMap.has(record.canvasId))
    .map((record) => ({
      ...cloneJson(record),
      id: id("yupdate"),
      canvasId: canvasIdMap.get(record.canvasId),
    }));
  const workflowSnapshots = (Array.isArray(bundle.workflowSnapshots) ? bundle.workflowSnapshots : [])
    .filter((record) => canvasIdMap.has(record.canvasId))
    .map((record) => ({
      ...cloneJson(record),
      id: id("ysnapshot"),
      canvasId: canvasIdMap.get(record.canvasId),
    }));

  db.projects.push(project);
  db.canvases.push(...canvases);
  db.assets.push(...assets);
  db.workflowUpdates.push(...workflowUpdates);
  db.workflowSnapshots.push(...workflowSnapshots);

  return { project, canvases, assets, workflowUpdates, workflowSnapshots };
}

export function copyProject(db, projectId, options = {}) {
  const bundle = buildProjectBundle(db, projectId);
  if (!bundle) return null;
  return importProjectBundle(db, bundle, {
    ...options,
    name: options.name || `${bundle.project.name} Copy`,
  });
}

export function deleteProjectGraph(db, projectId) {
  ensureCollections(db);
  const project = db.projects.find((item) => item.id === projectId);
  if (!project) return null;
  const canvases = db.canvases.filter((item) => item.projectId === project.id);
  const canvasIds = new Set(canvases.map((canvas) => canvas.id));
  const assets = db.assets.filter((item) => item.projectId === project.id);

  db.projects = db.projects.filter((item) => item.id !== project.id);
  db.canvases = db.canvases.filter((item) => item.projectId !== project.id);
  db.assets = db.assets.filter((item) => item.projectId !== project.id);
  db.workflowUpdates = db.workflowUpdates.filter((item) => !canvasIds.has(item.canvasId));
  db.workflowSnapshots = db.workflowSnapshots.filter((item) => !canvasIds.has(item.canvasId));

  const nextProject = db.projects[0] || null;
  const nextCanvases = nextProject ? db.canvases.filter((item) => item.projectId === nextProject.id) : [];
  return { deletedProject: project, deletedCanvases: canvases, deletedAssets: assets, nextProject, nextCanvases };
}
