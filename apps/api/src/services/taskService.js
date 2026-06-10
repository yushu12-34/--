import { readJsonQueued, updateJson } from "../db.js";
import { id, now } from "../utils/http.js";
import { createMockImageResult, generateImageWithModel } from "./imageGeneration.js";
import { enqueueTask } from "./queueService.js";
import { storeGeneratedAsset } from "./storageService.js";

const runningTasks = new Set();

export async function createAiTask(body) {
  if (!body.projectId || !body.canvasId || !body.nodeId || !body.type) {
    return { error: "projectId, canvasId, nodeId and type are required" };
  }
  const timestamp = now();
  const task = {
    id: id("task"),
    projectId: body.projectId,
    canvasId: body.canvasId,
    nodeId: body.nodeId,
    modelId: body.modelId || "z-image-turbo",
    type: body.type,
    status: "pending",
    input: body.input || {},
    progress: 0,
    createdBy: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await updateJson((db) => {
    db.tasks.unshift(task);
  });
  await enqueueTask(task);
  return { task };
}

export async function getAiTask(taskId) {
  const db = await readJsonQueued();
  return db.tasks.find((task) => task.id === taskId);
}

export async function cancelAiTask(taskId) {
  const task = await updateJson((db) => {
    const item = db.tasks.find((candidate) => candidate.id === taskId);
    if (!item) return null;
    if (item.status === "succeeded" || item.status === "failed") return item;
    item.status = "cancelled";
    item.progress = 0;
    item.error = "任务已取消";
    item.updatedAt = now();
    return item;
  });
  return task;
}

export async function retryAiTask(taskId) {
  const timestamp = now();
  const task = await updateJson((db) => {
    const item = db.tasks.find((candidate) => candidate.id === taskId);
    if (!item) return null;
    if (item.status === "pending" || item.status === "running") return item;
    delete item.output;
    delete item.error;
    item.status = "pending";
    item.progress = 0;
    item.updatedAt = timestamp;
    return item;
  });
  if (task?.status === "pending") await enqueueTask(task);
  return task;
}

export async function runTask(taskId) {
  if (runningTasks.has(taskId)) return;
  runningTasks.add(taskId);
  try {
    const started = await patchTask(taskId, { status: "running", progress: 10 }, { onlyStatus: "pending" });
    if (!started) return;
    const db = await readJsonQueued();
    const task = db.tasks.find((item) => item.id === taskId);
    if (!task || task.status === "cancelled") return;

    if (task.type !== "image.generate") {
      await patchTask(taskId, { status: "failed", progress: 0, error: "当前 MVP 只实现图片生成任务" });
      return;
    }

    const model = db.models.find((item) => item.id === task.modelId);
    const provider = model ? db.providers.find((item) => item.id === model.providerId) : undefined;
    if (!model || !provider) {
      await patchTask(taskId, { status: "failed", progress: 0, error: "模型或供应商不存在" });
      return;
    }

    let imageResult;
    try {
      await patchTask(taskId, { progress: 30 });
      imageResult = await generateImageWithModel(provider, model, task.input, (progress) =>
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
        await patchTask(taskId, { status: "failed", progress: 0, error: error instanceof Error ? error.message : String(error) });
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

    await updateJson((latestDb) => {
      const latestTask = latestDb.tasks.find((item) => item.id === taskId);
      if (!latestTask || latestTask.status === "cancelled") return;
      latestTask.status = "succeeded";
      latestTask.progress = 100;
      latestTask.output = { assetId: asset.id, url: imageUrl, providerTaskId: imageResult.providerTaskId, raw: imageResult.raw };
      latestTask.updatedAt = finishedAt;
      latestDb.assets.unshift(asset);
    });
  } finally {
    runningTasks.delete(taskId);
  }
}

async function patchTask(taskId, patch, options = {}) {
  return updateJson((db) => {
    const task = db.tasks.find((item) => item.id === taskId);
    if (!task) return false;
    if (options.onlyStatus && task.status !== options.onlyStatus) return false;
    Object.assign(task, patch, { updatedAt: now() });
    return true;
  });
}
