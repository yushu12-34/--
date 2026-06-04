import { readJson, writeJson } from "../db.js";
import { id, now } from "../utils/http.js";
import { createMockImageResult, generateImageWithModel } from "./imageGeneration.js";

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
  const db = await readJson();
  db.tasks.unshift(task);
  await writeJson(db);
  queueMicrotask(() => runTask(task.id));
  return { task };
}

export async function getAiTask(taskId) {
  const db = await readJson();
  return db.tasks.find((task) => task.id === taskId);
}

export async function runTask(taskId) {
  if (runningTasks.has(taskId)) return;
  runningTasks.add(taskId);
  try {
    await patchTask(taskId, { status: "running", progress: 10 });
    const db = await readJson();
    const task = db.tasks.find((item) => item.id === taskId);
    if (!task) return;

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
      imageResult = await generateImageWithModel(provider, model, task.input);
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
    const imageUrl = imageResult.url;
    const asset = {
      id: id("asset"),
      projectId: task.projectId,
      type: "image",
      url: imageUrl,
      thumbnailUrl: imageUrl,
      mimeType: imageUrl.startsWith("data:image/png") ? "image/png" : "image/svg+xml",
      size: imageUrl.length,
      source: "ai-generated",
      createdBy: "local-user",
      createdAt: finishedAt,
    };

    const latestDb = await readJson();
    const latestTask = latestDb.tasks.find((item) => item.id === taskId);
    if (!latestTask) return;
    latestTask.status = "succeeded";
    latestTask.progress = 100;
    latestTask.output = { assetId: asset.id, url: imageUrl, providerTaskId: imageResult.providerTaskId, raw: imageResult.raw };
    latestTask.updatedAt = finishedAt;
    latestDb.assets.unshift(asset);
    await writeJson(latestDb);
  } finally {
    runningTasks.delete(taskId);
  }
}

async function patchTask(taskId, patch) {
  const db = await readJson();
  const task = db.tasks.find((item) => item.id === taskId);
  if (!task) return;
  Object.assign(task, patch, { updatedAt: now() });
  await writeJson(db);
}
