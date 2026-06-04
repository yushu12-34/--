import type { AITask, AssetRecord, CanvasRecord, CanvasSnapshot, ProjectRecord } from "./types";

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

export async function ensureProject() {
  const existingId = localStorage.getItem("anime-canvas-project-id");
  if (existingId) {
    try {
      return await request<{ project: ProjectRecord; canvases: CanvasRecord[] }>(`/projects/${existingId}`);
    } catch {
      localStorage.removeItem("anime-canvas-project-id");
    }
  }

  const created = await request<{ project: ProjectRecord; canvas: CanvasRecord }>("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "我的动漫项目" }),
  });
  localStorage.setItem("anime-canvas-project-id", created.project.id);
  return { project: created.project, canvases: [created.canvas] };
}

export function getCanvas(canvasId: string) {
  return request<{ canvas: CanvasRecord }>(`/canvases/${canvasId}`);
}

export function saveSnapshot(canvasId: string, snapshot: CanvasSnapshot) {
  return request<{ canvas: CanvasRecord }>(`/canvases/${canvasId}/snapshot`, {
    method: "PUT",
    body: JSON.stringify({ snapshot }),
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

export function listTasks() {
  return request<{ tasks: AITask[] }>("/admin/tasks");
}

export function listProviders() {
  return request<{ providers: Array<Record<string, unknown>> }>("/admin/providers");
}

export function listModels() {
  return request<{ models: Array<Record<string, unknown>> }>("/admin/models");
}

export function createProvider(payload: Record<string, unknown>) {
  return request<{ provider: Record<string, unknown> }>("/admin/providers", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateProvider(id: string, payload: Record<string, unknown>) {
  return request<{ provider: Record<string, unknown> }>(`/admin/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function createModel(payload: Record<string, unknown>) {
  return request<{ model: Record<string, unknown> }>("/admin/models", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateModel(id: string, payload: Record<string, unknown>) {
  return request<{ model: Record<string, unknown> }>(`/admin/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
