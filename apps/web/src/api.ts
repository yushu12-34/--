import type { AITask, AssetRecord, CanvasRecord, CanvasSnapshot, ProjectBundle, ProjectRecord, UserRecord, YjsSnapshotDetail, YjsSnapshotRecord } from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function listUsers() {
  return request<{ users: UserRecord[] }>("/users");
}

export function createUser(name: string) {
  return request<{ user: UserRecord }>("/users", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function listProjects() {
  return request<{ projects: ProjectRecord[] }>("/projects");
}

export function getProject(projectId: string) {
  return request<{ project: ProjectRecord; canvases: CanvasRecord[] }>(`/projects/${encodeURIComponent(projectId)}`);
}

export function createProject(name: string, ownerId = "default-user") {
  return request<{ project: ProjectRecord; canvas: CanvasRecord }>("/projects", {
    method: "POST",
    body: JSON.stringify({ name, ownerId }),
  });
}

export function updateProject(projectId: string, payload: { name?: string }) {
  return request<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function copyProject(projectId: string, name?: string, ownerId?: string) {
  return request<{ project: ProjectRecord; canvases: CanvasRecord[]; assets: AssetRecord[] }>(`/projects/${encodeURIComponent(projectId)}/copy`, {
    method: "POST",
    body: JSON.stringify({ name, ownerId }),
  });
}

export function deleteProject(projectId: string) {
  return request<{ deletedProject: ProjectRecord; nextProject: ProjectRecord; nextCanvases: CanvasRecord[] }>(`/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export function exportProject(projectId: string) {
  return request<{ bundle: ProjectBundle }>(`/projects/${encodeURIComponent(projectId)}/export`);
}

export function importProject(bundle: ProjectBundle, name?: string, ownerId?: string) {
  return request<{ project: ProjectRecord; canvases: CanvasRecord[]; assets: AssetRecord[] }>("/projects/import", {
    method: "POST",
    body: JSON.stringify({ bundle, name, ownerId }),
  });
}

export async function ensureProject(ownerId = "default-user") {
  const existingId = localStorage.getItem("anime-canvas-project-id");
  if (existingId) {
    try {
      return await getProject(existingId);
    } catch {
      localStorage.removeItem("anime-canvas-project-id");
    }
  }

  const listed = await listProjects();
  const existingProject = listed.projects[0];
  if (existingProject) {
    localStorage.setItem("anime-canvas-project-id", existingProject.id);
    return getProject(existingProject.id);
  }

  const created = await createProject("我的动漫项目", ownerId);
  localStorage.setItem("anime-canvas-project-id", created.project.id);
  return { project: created.project, canvases: [created.canvas] };
}

export function createCanvas(projectId: string, name: string) {
  return request<{ canvas: CanvasRecord }>(`/projects/${encodeURIComponent(projectId)}/canvases`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function getCanvas(canvasId: string) {
  return request<{ canvas: CanvasRecord }>(`/canvases/${canvasId}`);
}

export function updateCanvas(canvasId: string, payload: { name?: string }) {
  return request<{ canvas: CanvasRecord }>(`/canvases/${encodeURIComponent(canvasId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function copyCanvas(canvasId: string, name?: string) {
  return request<{ canvas: CanvasRecord }>(`/canvases/${encodeURIComponent(canvasId)}/copy`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function deleteCanvas(canvasId: string) {
  return request<{ deletedCanvas: CanvasRecord; nextCanvas: CanvasRecord }>(`/canvases/${encodeURIComponent(canvasId)}`, {
    method: "DELETE",
  });
}

export function saveSnapshot(canvasId: string, snapshot: CanvasSnapshot) {
  return request<{ canvas: CanvasRecord }>(`/canvases/${canvasId}/snapshot`, {
    method: "PUT",
    body: JSON.stringify({ snapshot }),
  });
}

export function listYjsHistory(canvasId: string) {
  return request<{ snapshots: YjsSnapshotRecord[] }>(`/canvases/${encodeURIComponent(canvasId)}/yjs-history`);
}

export function getYjsHistorySnapshot(canvasId: string, snapshotId: string) {
  return request<YjsSnapshotDetail>(`/canvases/${encodeURIComponent(canvasId)}/yjs-history/${encodeURIComponent(snapshotId)}`);
}

export function compactYjsDocument(canvasId: string) {
  return request<{ snapshot: YjsSnapshotRecord }>(`/canvases/${encodeURIComponent(canvasId)}/yjs-compact`, {
    method: "POST",
  });
}

export function listAssets(projectId: string) {
  return request<{ assets: AssetRecord[] }>(`/assets?projectId=${encodeURIComponent(projectId)}`);
}

export function createAsset(payload: Partial<AssetRecord> & { projectId: string; type: string; url: string }) {
  return request<{ asset: AssetRecord }>("/assets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateAsset(id: string, payload: { name?: string }) {
  return request<{ asset: AssetRecord }>(`/assets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteAsset(id: string) {
  return request<{ asset: AssetRecord }>(`/assets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function createTask(payload: {
  projectId: string;
  canvasId: string;
  nodeId: string;
  type: "image.generate" | "audio.generate" | "video.generate";
  modelId?: string;
  input: Record<string, unknown>;
}) {
  return request<{ task: AITask }>("/ai/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getTask(taskId: string) {
  return request<{ task: AITask }>(`/ai/tasks/${encodeURIComponent(taskId)}`);
}

export function listModels() {
  return request<{ models: Array<Record<string, unknown>> }>("/models").then((result) => ({
    models: result.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      type: model.type,
      capabilities: model.capabilities,
      enabled: model.enabled,
      paramSchema: model.publicParamSchema || {},
      defaultParams: model.defaultPublicParams || {},
    })),
  }));
}
