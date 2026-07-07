import type { AITask, AssetRecord, CanvasAccessRecord, CanvasMemberRecord, CanvasRecord, CanvasSnapshot, CollaborativeCanvasRecord, ProjectBundle, ProjectRecord, UserRecord, YjsSnapshotDetail, YjsSnapshotRecord } from "./types";

const RAW_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

export function getApiBaseUrl(): string {
  const value = String(RAW_API_BASE_URL);
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (isLocalHost && typeof window !== "undefined" && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
      url.hostname = window.location.hostname;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

export function getAuthToken(): string {
  return String(sessionStorage.getItem("anime-canvas-auth-token") || localStorage.getItem("anime-canvas-auth-token") || "");
}

export function setAuthToken(token: string) {
  if (token) {
    localStorage.setItem("anime-canvas-auth-token", token);
    sessionStorage.setItem("anime-canvas-auth-token", token);
  } else {
    localStorage.removeItem("anime-canvas-auth-token");
    sessionStorage.removeItem("anime-canvas-auth-token");
  }
}

function getCurrentUserId(): string {
  return String(sessionStorage.getItem("anime-canvas-active-user-id") || localStorage.getItem("anime-canvas-active-user-id") || "");
}

function userScopedStorageKey(key: string, userId = getCurrentUserId()) {
  return userId ? `${key}:${userId}` : key;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-user-id": getCurrentUserId(),
      ...(getAuthToken() ? { authorization: `Bearer ${getAuthToken()}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function getCurrentSession() {
  return request<{ user: UserRecord }>("/auth/me");
}

export function registerUser(payload: { name: string; email: string; password: string }) {
  return request<{ user: UserRecord; token: string }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function loginUser(payload: { email: string; password: string }) {
  return request<{ user: UserRecord; token: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function logoutUser() {
  return request<{ ok: boolean }>("/auth/logout", { method: "POST" }).finally(() => setAuthToken(""));
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

export function listCollaborativeCanvases() {
  return request<{ canvases: CollaborativeCanvasRecord[] }>("/collaboration/canvases");
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
  const projectStorageKey = userScopedStorageKey("anime-canvas-project-id", ownerId);
  const existingId = localStorage.getItem(projectStorageKey) || localStorage.getItem("anime-canvas-project-id");
  if (existingId) {
    try {
      return await getProject(existingId);
    } catch {
      localStorage.removeItem(projectStorageKey);
      if (localStorage.getItem("anime-canvas-project-id") === existingId) localStorage.removeItem("anime-canvas-project-id");
    }
  }

  const listed = await listProjects();
  const existingProject = listed.projects[0];
  if (existingProject) {
    localStorage.setItem(projectStorageKey, existingProject.id);
    return getProject(existingProject.id);
  }

  const created = await createProject("我的动漫项目", ownerId);
  localStorage.setItem(projectStorageKey, created.project.id);
  return { project: created.project, canvases: [created.canvas] };
}

export function createCanvas(projectId: string, name: string) {
  return request<{ canvas: CanvasRecord }>(`/projects/${encodeURIComponent(projectId)}/canvases`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function listCanvasMembers(canvasId: string) {
  return request<{ members: CanvasMemberRecord[] }>(`/canvases/${encodeURIComponent(canvasId)}/members`);
}

export function inviteCanvasMember(canvasId: string, userId: string, role: "editor" | "viewer" = "editor") {
  return request<{ member: CanvasMemberRecord }>(`/canvases/${encodeURIComponent(canvasId)}/members`, {
    method: "POST",
    body: JSON.stringify({ userId, role }),
  });
}

export function removeCanvasMember(canvasId: string, userId: string) {
  return request<{ removed: boolean }>(`/canvases/${encodeURIComponent(canvasId)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export interface CanvasInviteRecord {
  id: string;
  canvasId: string;
  ownerId: string;
  code: string;
  role: "editor" | "viewer";
  maxUses?: number;
  usedCount: number;
  expiresAt?: string;
  createdAt: string;
}

export function createCanvasInvite(canvasId: string, payload: { role?: "editor" | "viewer"; expiresHours?: number; maxUses?: number } = {}) {
  return request<{ invite: CanvasInviteRecord }>(`/canvases/${encodeURIComponent(canvasId)}/invites`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function acceptCanvasInvite(code: string) {
  return request<{ invite: CanvasInviteRecord; member: CanvasMemberRecord; canvas?: CanvasRecord }>(`/invites/${encodeURIComponent(code)}/accept`, {
    method: "POST",
  });
}

export function getCanvas(canvasId: string) {
  return request<{ canvas: CanvasRecord; access?: CanvasAccessRecord }>(`/canvases/${canvasId}`);
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

export function saveSnapshot(canvasId: string, snapshot: CanvasSnapshot, options: { backupOperation?: "history-restore" } = {}) {
  return request<{ canvas: CanvasRecord }>(`/canvases/${canvasId}/snapshot`, {
    method: "PUT",
    body: JSON.stringify({ snapshot, ...options }),
  });
}

export function saveSnapshotJson(canvasId: string, bodyJson: string, options: { minimal?: boolean } = {}) {
  const query = options.minimal ? "?minimal=1" : "";
  return request<{ canvas?: CanvasRecord; ok?: boolean; updatedAt?: string }>(`/canvases/${encodeURIComponent(canvasId)}/snapshot${query}`, {
    method: "PUT",
    body: bodyJson,
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

export function createAsset(payload: Partial<AssetRecord> & { projectId: string; canvasId?: string; type: string; url: string }) {
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
