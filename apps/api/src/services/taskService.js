import { readJsonQueued, createTask, updateTask, createAsset, usePostgresBackend, getTaskView, listModelsView, listProvidersView } from "../db.js";
import { id, now } from "../utils/http.js";
import { createMockImageResult, generateImageWithModel, generateVideoWithModel } from "./imageGeneration.js";
import { enqueueTask } from "./queueService.js";
import { storeGeneratedAsset } from "./storageService.js";
import { recordSystemEvent } from "./systemEventService.js";

const runningTasks = new Set();
const DEFAULT_TASK_TIMEOUT_MS = 120000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 2000;

function defaultModelIdForTaskType(type) {
  if (type === "video.generate") return "seedance-2-fast";
  return "z-image-turbo";
}

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
  const modelId = body.modelId || defaultModelIdForTaskType(body.type);
  const db = await getTaskRuntimeDb();
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
    userId: body.userId || body.createdBy || undefined,
    createdBy: body.createdBy || body.userId || "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await createTask(task);
  await enqueueTask(task);
  return { task };
}

export async function getAiTask(taskId) {
  if (await usePostgresBackend()) return getTaskView(taskId);
  const db = await readJsonQueued();
  return db.tasks.find((task) => task.id === taskId);
}

export async function cancelAiTask(taskId) {
  const existing = await getAiTask(taskId);
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
  const existing = await getAiTask(taskId);
  if (!existing) return null;
  if (existing.status === "pending" || existing.status === "running") return existing;
  const db = await getTaskRuntimeDb();
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
    const db = await getTaskRuntimeDb();
    const task = await getAiTask(taskId);
    if (!task || task.status === "cancelled") return;

    if (task.type !== "image.generate" && task.type !== "video.generate") {
      await patchTask(taskId, { status: "failed", progress: 0, error: "当前仅支持图片和视频生成任务" });
      await recordTaskFailure(task, "当前仅支持图片和视频生成任务");
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

    const mediaType = task.type === "video.generate" ? "video" : "image";
    let mediaResult;
    try {
      await patchTask(taskId, { progress: 30 });
      mediaResult = mediaType === "video"
        ? await generateVideoWithModel(provider, modelForTask, task.input, (progress) =>
          patchTask(taskId, { progress }, { onlyStatus: "running" }))
        : await generateImageWithModel(provider, modelForTask, task.input, (progress) =>
          patchTask(taskId, { progress }, { onlyStatus: "running" }));
    } catch (error) {
      if (mediaType === "image" && model.allowMockFallback !== false) {
        mediaResult = {
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
    const storedAsset = await persistGeneratedAsset({
      userId: task.createdBy || task.userId || "local-user",
      projectId: task.projectId,
      taskId,
      mediaType,
      sourceUrl: mediaResult.url,
    });
    const resultUrl = storedAsset.url;
    const asset = {
      id: id("asset"),
      projectId: task.projectId,
      type: mediaType,
      url: resultUrl,
      thumbnailUrl: resultUrl,
      mimeType: storedAsset.mimeType,
      size: storedAsset.size,
      source: "ai-generated",
      storage: storedAsset.storage,
      objectName: storedAsset.objectName,
      bucket: storedAsset.bucket,
      createdBy: task.createdBy || task.userId || "local-user",
      createdAt: finishedAt,
    };

    await createAsset(asset);
    await updateTask(taskId, {
      status: "succeeded",
      progress: 100,
      output: {
        assetId: asset.id,
        url: resultUrl,
        providerTaskId: mediaResult.providerTaskId,
        raw: mediaResult.raw,
        storage: storedAsset.storage,
        objectName: storedAsset.objectName,
        bucket: storedAsset.bucket,
      },
    });
  } finally {
    runningTasks.delete(taskId);
  }
}

async function persistGeneratedAsset({ userId, projectId, taskId, mediaType, sourceUrl }) {
  try {
    return await storeGeneratedAsset({ userId, projectId, taskId, mediaType, sourceUrl });
  } catch (error) {
    if (!/Object storage is required/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return {
      url: sourceUrl,
      mimeType: mediaType === "video" ? "video/mp4" : "image/png",
      size: 0,
      storage: "remote-url",
      objectName: undefined,
      bucket: undefined,
    };
  }
}

async function patchTask(taskId, patch, options = {}) {
  if (options.onlyStatus) {
    const existing = await getAiTask(taskId);
    if (!existing || existing.status !== options.onlyStatus) return false;
  }
  await updateTask(taskId, patch);
  return true;
}

async function getTaskRuntimeDb() {
  if (await usePostgresBackend()) {
    const [models, providers] = await Promise.all([listModelsView(), listProvidersView()]);
    return { models, providers };
  }
  return readJsonQueued();
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
