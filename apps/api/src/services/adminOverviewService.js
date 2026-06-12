import { summarizeSystemEvents } from "./systemEventService.js";

const TASK_STATUSES = ["idle", "pending", "running", "succeeded", "failed", "cancelled"];
const ERROR_CATEGORIES = ["connection", "auth", "timeout", "non_json", "field_mapping", "model_error", "other"];

export function classifyTaskError(errorMessage) {
  if (!errorMessage) return "other";
  const msg = String(errorMessage).toLowerCase();
  if (msg.includes("连接失败") || msg.includes("connection") || msg.includes("econnrefused") || msg.includes("enotfound")) return "connection";
  if (msg.includes("鉴权失败") || msg.includes("unauthorized") || msg.includes("401") || msg.includes("403") || msg.includes("auth")) return "auth";
  if (msg.includes("超时") || msg.includes("timeout") || msg.includes("aborted")) return "timeout";
  if (msg.includes("非 json") || msg.includes("非json") || msg.includes("non-json") || msg.includes("not valid json")) return "non_json";
  if (msg.includes("字段映射错误") || msg.includes("未能通过") || msg.includes("读取")) return "field_mapping";
  if (msg.includes("模型任务失败") || msg.includes("模型接口") || msg.includes("模型供应商") || msg.includes("模型已禁用")) return "model_error";
  return "other";
}

export function enrichAdminTask(task, models = [], providers = []) {
  const model = models.find((item) => item.id === task.modelId);
  const provider = model ? providers.find((item) => item.id === model.providerId) : undefined;
  const startedAt = (task.startedAt || task.createdAt) ? new Date(task.startedAt || task.createdAt).getTime() : 0;
  const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
  const durationMs = startedAt && updatedAt ? Math.max(0, updatedAt - startedAt) : undefined;
  const prompt = task.input?.prompt ? String(task.input.prompt) : "";
  const inputSummary = prompt ? `${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}` : undefined;

  return {
    ...task,
    modelDisplayName: model?.displayName || task.modelId || "-",
    providerName: provider?.name || "-",
    durationMs,
    errorCategory: task.status === "failed" ? classifyTaskError(task.error) : undefined,
    inputSummary,
  };
}

export function enrichAdminTaskList(tasks = [], models = [], providers = []) {
  return tasks.map((task) => enrichAdminTask(task, models, providers));
}

export function selectRetryableAdminTasks(tasks = [], filters = {}) {
  const taskIds = Array.isArray(filters.taskIds)
    ? new Set(filters.taskIds.map((taskId) => String(taskId)).filter(Boolean))
    : null;
  const errorCategory = filters.errorCategory ? String(filters.errorCategory) : "";
  const statuses = Array.isArray(filters.statuses) && filters.statuses.length
    ? new Set(filters.statuses.map((status) => String(status)))
    : new Set(["failed", "cancelled"]);
  const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);

  const selected = [];
  const skipped = [];
  for (const task of tasks) {
    if (taskIds && !taskIds.has(String(task.id))) continue;
    if (!statuses.has(String(task.status))) {
      if (taskIds?.has(String(task.id))) skipped.push({ taskId: task.id, reason: "status", status: task.status });
      continue;
    }
    if (errorCategory && task.errorCategory !== errorCategory) continue;
    if (selected.length >= limit) {
      skipped.push({ taskId: task.id, reason: "limit" });
      continue;
    }
    selected.push(task);
  }

  return { selected, skipped, limit };
}

function summarizeTasks(tasks) {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  const byErrorCategory = Object.fromEntries(ERROR_CATEGORIES.map((category) => [category, 0]));
  const completedDurations = [];

  for (const task of tasks) {
    if (Object.prototype.hasOwnProperty.call(byStatus, task.status)) {
      byStatus[task.status] += 1;
    }
    if (task.status === "failed") {
      byErrorCategory[task.errorCategory || "other"] = (byErrorCategory[task.errorCategory || "other"] || 0) + 1;
    }
    if ((task.status === "succeeded" || task.status === "failed") && typeof task.durationMs === "number") {
      completedDurations.push(task.durationMs);
    }
  }

  const total = tasks.length;
  const completed = byStatus.succeeded + byStatus.failed + byStatus.cancelled;
  const averageDurationMs = completedDurations.length
    ? Math.round(completedDurations.reduce((sum, value) => sum + value, 0) / completedDurations.length)
    : null;

  return {
    total,
    byStatus,
    successRate: total ? Math.round((byStatus.succeeded / total) * 1000) / 10 : 0,
    failureRate: total ? Math.round((byStatus.failed / total) * 1000) / 10 : 0,
    active: byStatus.pending + byStatus.running,
    completed,
    averageDurationMs,
    byErrorCategory,
  };
}

function summarizeModels(models = [], providers = []) {
  const byType = {};
  for (const model of models) {
    const type = String(model.type || "unknown");
    byType[type] = (byType[type] || 0) + 1;
  }

  return {
    providers: {
      total: providers.length,
      enabled: providers.filter((provider) => provider.enabled !== false).length,
      disabled: providers.filter((provider) => provider.enabled === false).length,
    },
    models: {
      total: models.length,
      enabled: models.filter((model) => model.enabled !== false).length,
      disabled: models.filter((model) => model.enabled === false).length,
      byType,
    },
  };
}

function buildBackupSummary(events = []) {
  const backupEvents = events.filter((event) => event.category === "backup");
  const latest = backupEvents[0] || null;
  const latestError = backupEvents.find((event) => event.level === "error") || null;
  return {
    latest,
    latestError,
    total: backupEvents.length,
    errors: backupEvents.filter((event) => event.level === "error").length,
    warnings: backupEvents.filter((event) => event.level === "warning").length,
  };
}

export function buildAdminOverview(db = {}) {
  const providers = Array.isArray(db.providers) ? db.providers : [];
  const models = Array.isArray(db.models) ? db.models : [];
  const events = Array.isArray(db.systemEvents) ? db.systemEvents : [];
  const enrichedTasks = enrichAdminTaskList(Array.isArray(db.tasks) ? db.tasks : [], models, providers);
  const recentSignals = events.filter((event) => event.level === "error" || event.level === "warning").slice(0, 6);

  return {
    generatedAt: new Date().toISOString(),
    tasks: summarizeTasks(enrichedTasks),
    modelRuntime: summarizeModels(models, providers),
    events: {
      summary: summarizeSystemEvents(events),
      recentSignals,
    },
    backup: buildBackupSummary(events),
    recentFailedTasks: enrichedTasks.filter((task) => task.status === "failed").slice(0, 5),
  };
}
