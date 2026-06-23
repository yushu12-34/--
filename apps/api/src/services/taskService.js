import { readJsonQueued, createTask, updateTask, createAsset } from "../db.js";
import { id, now } from "../utils/http.js";
import { createMockImageResult, generateImageWithModel } from "./imageGeneration.js";
import { enqueueTask } from "./queueService.js";
import { storeGeneratedAsset } from "./storageService.js";
import { recordSystemEvent } from "./systemEventService.js";

const runningTasks = new Set();
const DEFAULT_TASK_TIMEOUT_MS = 120000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 2000;

export function resolveTaskRuntimeConfig(db, modelId) {
  const model = db.models?.find((item) => item.id === modelId);
  const adapter = model?.adapter && typeof model.adapter === "object" ? model.adapter : {};
  const timeoutMs = Number(adapter.timeoutMs || DEFAULT_TASK_TIMEOUT_MS);
  const pollIntervalMs = Number(adapter.pollIntervalMs || DEFAULT_TASK_POLL_INTERVAL_MS);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TASK_TIMEOUT_MS,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : DEFAULT_TASK_POLL_INTERVAL_MS,
  };
}

export async function createAiTask(body) {
  if (!body.projectId || !body.canvasId || !body.nodeId || !body.type) {
    return { error: "projectId, canvasId, nodeId and type are required" };
  }
  const timestamp = now();
  const modelId = body.modelId || "z-image-turbo";
  const db = await readJsonQueued();
  const runtimeConfig = resolveTaskRuntimeConfig(db, modelId);
  const task = {
    id: id("task"),
    projectId: body.projectId,
    canvasId: body.canvasId,
    nodeId: body.nodeId,
    modelId,
    type: body.type,
    status: "pending",
    input: body.input || {},
    progress: 0,
    timeoutMs: runtimeConfig.timeoutMs,
    pollIntervalMs: runtimeConfig.pollIntervalMs,
    createdBy: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await createTask(task);
  await enqueueTask(task);
  return { task };
}

export async function getAiTask(taskId) {
  const db = await readJsonQueued();
  return db.tasks.find((task) => task.id === taskId);
}

export async function cancelAiTask(taskId) {
  const db = await readJsonQueued();
  const existing = db.tasks.find((item) => item.id === taskId);
  if (!existing) return null;
  if (existing.status === "succeeded" || existing.status === "failed") return existing;
  const task = await updateTask(taskId, {
    status: "cancelled",
    progress: 0,
    error: "任务已取消",
  });
  return task;
}

export async function retryAiTask(taskId) {
  const db = await readJsonQueued();
  const existing = db.tasks.find((item) => item.id === taskId);
  if (!existing) return null;
  if (existing.status === "pending" || existing.status === "running") return existing;
  const runtimeConfig = resolveTaskRuntimeConfig(db, existing.modelId);
  const task = await updateTask(taskId, {
    status: "pending",
    progress: 0,
    timeoutMs: runtimeConfig.timeoutMs,
    pollIntervalMs: runtimeConfig.pollIntervalMs,
  });
  if (task?.status === "pending") await enqueueTask(task);
  return task;
}

export async function runTask(taskId) {
  if (runningTasks.has(taskId)) return;
  runningTasks.add(taskId);
  try {
    const startedAt = now();
    const started = await patchTask(taskId, { status: "running", progress: 10, startedAt }, { onlyStatus: "pending" });
    if (!started) return;
    const db = await readJsonQueued();
    const task = db.tasks.find((item) => item.id === taskId);
    if (!task || task.status === "cancelled") return;

    if (task.type !== "image.generate") {
      await patchTask(taskId, { status: "failed", progress: 0, error: "当前 MVP 只实现图片生成任务" });
      await recordTaskFailure(task, "当前 MVP 只实现图片生成任务");
      return;
    }

    const model = db.models.find((item) => item.id === task.modelId);
    const provider = model ? db.providers.find((item) => item.id === model.providerId) : undefined;
    if (!model || !provider) {
      await patchTask(taskId, { status: "failed", progress: 0, error: "模型或供应商不存在" });
      await recordTaskFailure(task, "模型或供应商不存在");
      return;
    }

    const modelForTask = {
      ...model,
      adapter: {
        ...(model.adapter || {}),
        timeoutMs: task.timeoutMs || model.adapter?.timeoutMs,
        pollIntervalMs: task.pollIntervalMs || model.adapter?.pollIntervalMs,
      },
    };

    let imageResult;
    try {
      await patchTask(taskId, { progress: 30 });
      imageResult = await generateImageWithModel(provider, modelForTask, task.input, (progress) =>
        patchTask(taskId, { progress }, { onlyStatus: "running" }),
      );
    } catch (error) {
      if (model.allowMockFallback !== false) {
        imageResult = {
          providerTaskId: "mock-fallback",
          url: createMockImageResult(task.input),
          raw: { fallback: true, reason: error instanceof Error ? error.message : String(error) },
        };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await patchTask(taskId, { status: "failed", progress: 0, error: message });
        await recordTaskFailure(task, message, { modelId: model.id, providerId: provider.id });
        return;
      }
    }

    const finishedAt = now();
    const storedAsset = await storeGeneratedAsset({
      projectId: task.projectId,
      taskId,
      mediaType: "image",
      sourceUrl: imageResult.url,
    });
    const imageUrl = storedAsset.url;
    const asset = {
      id: id("asset"),
      projectId: task.projectId,
      type: "image",
      url: imageUrl,
      thumbnailUrl: imageUrl,
      mimeType: storedAsset.mimeType,
      size: storedAsset.size,
      source: "ai-generated",
      storage: storedAsset.storage,
      objectName: storedAsset.objectName,
      bucket: storedAsset.bucket,
      createdBy: "local-user",
      createdAt: finishedAt,
    };

    await createAsset(asset);
    await updateTask(taskId, {
      status: "succeeded",
      progress: 100,
      output: { assetId: asset.id, url: imageUrl, providerTaskId: imageResult.providerTaskId, raw: imageResult.raw },
    });
  } finally {
    runningTasks.delete(taskId);
  }
}

async function patchTask(taskId, patch, options = {}) {
  if (options.onlyStatus) {
    const db = await readJsonQueued();
    const existing = db.tasks.find((item) => item.id === taskId);
    if (!existing || existing.status !== options.onlyStatus) return false;
  }
  await updateTask(taskId, patch);
  return true;
}

async function recordTaskFailure(task, error, metadata = {}) {
  try {
    await recordSystemEvent({
      level: "error",
      category: "task",
      source: "task-runner",
      message: "AI 任务执行失败",
      metadata: {
        taskId: task.id,
        projectId: task.projectId,
        canvasId: task.canvasId,
        nodeId: task.nodeId,
        type: task.type,
        modelId: task.modelId,
        error,
        ...metadata,
      },
    });
  } catch {}
}
