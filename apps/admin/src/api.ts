import type { AITask } from "./types";

const INTERNAL_API_BASE_URL = import.meta.env.VITE_INTERNAL_API_BASE_URL || "/internal";
const INTERNAL_ADMIN_TOKEN = import.meta.env.VITE_INTERNAL_ADMIN_TOKEN || "";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((options.headers || {}) as Record<string, string>),
  };
  if (INTERNAL_ADMIN_TOKEN) headers.authorization = `Bearer ${INTERNAL_ADMIN_TOKEN}`;

  const response = await fetch(`${INTERNAL_API_BASE_URL}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function listTasks() {
  return request<{ tasks: AITask[] }>("/tasks");
}

export function getTask(id: string) {
  return request<{ task: AITask }>(`/tasks/${encodeURIComponent(id)}`);
}

export function listProviders() {
  return request<{ providers: Array<Record<string, unknown>> }>("/providers");
}

export function listModels() {
  return request<{ models: Array<Record<string, unknown>> }>("/models");
}

export function createProvider(payload: Record<string, unknown>) {
  return request<{ provider: Record<string, unknown> }>("/providers", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateProvider(id: string, payload: Record<string, unknown>) {
  return request<{ provider: Record<string, unknown> }>(`/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function createModel(payload: Record<string, unknown>) {
  return request<{ model: Record<string, unknown> }>("/models", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateModel(id: string, payload: Record<string, unknown>) {
  return request<{ model: Record<string, unknown> }>(`/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function testProvider(id: string) {
  return request<{ ok: boolean; message: string; latencyMs?: number }>(`/providers/${encodeURIComponent(id)}/test`, {
    method: "POST",
  });
}

export function cancelTask(id: string) {
  return request<{ task: AITask }>(`/tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

export function retryTask(id: string) {
  return request<{ task: AITask }>(`/tasks/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });
}
