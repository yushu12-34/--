import { createServer } from "node:http";
import { emptySnapshot, ensureDb, readJson, updateJson } from "./db.js";
import { badRequest, id, isInternalAdminRequest, notFound, now, parseBody, publicModel, publicProvider, send } from "./utils/http.js";
import { createAiTask, getAiTask, cancelAiTask, retryAiTask, runTask } from "./services/taskService.js";
import { initializeTaskQueue } from "./services/queueService.js";
import { attachCollaborationServer, compactCanvasYDoc, getCanvasYjsHistorySnapshot, listCanvasYjsHistory } from "./services/collaborationService.js";
import { buildProjectBundle, buildProjectList, copyProject, deleteProjectGraph, importProjectBundle, validateProjectBundle } from "./services/projectArchiveService.js";
import { createRequiredDbBackup } from "./services/backupService.js";
import { buildAdminOverview, enrichAdminTask, enrichAdminTaskList, selectRetryableAdminTasks } from "./services/adminOverviewService.js";
import { listSystemEvents, recordSystemEvent } from "./services/systemEventService.js";

const PORT = Number(process.env.API_PORT || 8787);

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const internalPathname = pathname.startsWith("/api/admin")
    ? pathname.replace(/^\/api\/admin/, "/internal")
    : pathname;
  const isInternalPath = pathname.startsWith("/internal") || pathname.startsWith("/api/admin");

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      send(res, 200, { ok: true, service: "anime-canvas-api", time: now() });
      return;
    }

    const db = await readJson();

    if (isInternalPath && !isInternalAdminRequest(req)) {
      await recordRuntimeEvent({
        level: "warning",
        category: "security",
        source: "api",
        message: "未授权内部接口访问被拒绝",
        metadata: { method: req.method, path: pathname, remoteAddress: req.socket?.remoteAddress },
      });
      send(res, 401, { error: "Unauthorized", message: "Internal admin access is required" });
      return;
    }

    if (req.method === "GET" && pathname === "/api/models") {
      const models = (db.models || [])
        .filter((model) => model.enabled !== false)
        .sort((left, right) => Number(left.sortOrder || 100) - Number(right.sortOrder || 100))
        .map(publicModel);
      send(res, 200, { models });
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      send(res, 200, { projects: buildProjectList(db) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/users") {
      send(res, 200, { users: db.users || [] });
      return;
    }

    if (req.method === "POST" && pathname === "/api/users") {
      const body = await parseBody(req);
      const timestamp = now();
      const user = {
        id: body.id || id("user"),
        name: String(body.name || "新用户"),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await updateJson((latestDb) => {
        if (!latestDb.users) latestDb.users = [];
        latestDb.users.push(user);
      });
      send(res, 201, { user });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects") {
      const body = await parseBody(req);
      const timestamp = now();
      const project = {
        id: id("project"),
        name: String(body.name || "未命名动漫项目"),
        ownerId: String(body.ownerId || body.userId || "default-user"),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const canvas = {
        id: id("canvas"),
        projectId: project.id,
        name: "主画布",
        snapshot: emptySnapshot,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await updateJson((latestDb) => {
        latestDb.projects.push(project);
        latestDb.canvases.push(canvas);
      });
      send(res, 201, { project, canvas });
      return;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === "GET") {
      const project = db.projects.find((item) => item.id === projectMatch[1]);
      if (!project) return notFound(res);
      const canvases = db.canvases.filter((item) => item.projectId === project.id);
      send(res, 200, { project, canvases });
      return;
    }

    const projectCanvasMatch = pathname.match(/^\/api\/projects\/([^/]+)\/canvases$/);
    if (projectCanvasMatch && req.method === "POST") {
      const body = await parseBody(req);
      const project = db.projects.find((item) => item.id === projectCanvasMatch[1]);
      if (!project) return notFound(res);
      const timestamp = now();
      const canvas = {
        id: id("canvas"),
        projectId: project.id,
        name: String(body.name || `画布 ${db.canvases.filter((item) => item.projectId === project.id).length + 1}`),
        snapshot: emptySnapshot,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await updateJson((latestDb) => {
        latestDb.canvases.push(canvas);
        const latestProject = latestDb.projects.find((item) => item.id === project.id);
        if (latestProject) latestProject.updatedAt = timestamp;
      });
      send(res, 201, { canvas });
      return;
    }

    if (projectMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const updatedProject = await updateJson((latestDb) => {
        const project = latestDb.projects.find((item) => item.id === projectMatch[1]);
        if (!project) return null;
        project.name = String(body.name || project.name);
        project.updatedAt = now();
        return project;
      });
      if (!updatedProject) return notFound(res);
      send(res, 200, { project: updatedProject });
      return;
    }

    const projectCopyMatch = pathname.match(/^\/api\/projects\/([^/]+)\/copy$/);
    if (projectCopyMatch && req.method === "POST") {
      const body = await parseBody(req);
      const copied = await updateJson((latestDb) => copyProject(latestDb, projectCopyMatch[1], {
        name: body.name,
        ownerId: body.ownerId,
      }));
      if (!copied) return notFound(res);
      send(res, 201, copied);
      return;
    }

    const projectExportMatch = pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
    if (projectExportMatch && req.method === "GET") {
      const bundle = buildProjectBundle(db, projectExportMatch[1]);
      if (!bundle) return notFound(res);
      send(res, 200, { bundle });
      return;
    }

    const projectImportMatch = pathname.match(/^\/api\/projects\/import$/);
    if (projectImportMatch && req.method === "POST") {
      const body = await parseBody(req);
      const validation = validateProjectBundle(body.bundle || body);
      if (!validation.ok) return badRequest(res, validation.error);
      const backup = await createRequiredDbBackup("project-import");
      const imported = await updateJson((latestDb) => importProjectBundle(latestDb, body.bundle || body, {
        name: body.name,
        ownerId: body.ownerId,
      }));
      if (!imported) return badRequest(res, "Invalid project bundle");
      send(res, 201, { ...imported, backup });
      return;
    }

    if (projectMatch && req.method === "DELETE") {
      const result = await updateJson((latestDb) => {
        const deleted = deleteProjectGraph(latestDb, projectMatch[1]);
        if (!deleted) return null;
        if (!deleted.nextProject) {
          const timestamp = now();
          const project = {
            id: id("project"),
            name: "新项目",
            ownerId: "default-user",
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const canvas = {
            id: id("canvas"),
            projectId: project.id,
            name: "主画布",
            snapshot: emptySnapshot,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          latestDb.projects.push(project);
          latestDb.canvases.push(canvas);
          deleted.nextProject = project;
          deleted.nextCanvases = [canvas];
        }
        return deleted;
      });
      if (!result) return notFound(res);
      send(res, 200, result);
      return;
    }

    const canvasMatch = pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (canvasMatch && req.method === "GET") {
      const canvas = db.canvases.find((item) => item.id === canvasMatch[1]);
      if (!canvas) return notFound(res);
      send(res, 200, { canvas });
      return;
    }

    if (canvasMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const updatedCanvas = await updateJson((latestDb) => {
        const canvas = latestDb.canvases.find((item) => item.id === canvasMatch[1]);
        if (!canvas) return null;
        canvas.name = String(body.name || canvas.name);
        canvas.updatedAt = now();
        return canvas;
      });
      if (!updatedCanvas) return notFound(res);
      send(res, 200, { canvas: updatedCanvas });
      return;
    }

    if (canvasMatch && req.method === "DELETE") {
      const result = await updateJson((latestDb) => {
        const canvas = latestDb.canvases.find((item) => item.id === canvasMatch[1]);
        if (!canvas) return null;
        const projectCanvases = latestDb.canvases.filter((item) => item.projectId === canvas.projectId);
        if (projectCanvases.length <= 1) return { error: "至少保留一个画布" };
        latestDb.canvases = latestDb.canvases.filter((item) => item.id !== canvas.id);
        const latestProject = latestDb.projects.find((item) => item.id === canvas.projectId);
        if (latestProject) latestProject.updatedAt = now();
        return { deletedCanvas: canvas, nextCanvas: projectCanvases.find((item) => item.id !== canvas.id) };
      });
      if (!result) return notFound(res);
      if (result.error) return badRequest(res, result.error);
      send(res, 200, result);
      return;
    }

    const canvasCopyMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/copy$/);
    if (canvasCopyMatch && req.method === "POST") {
      const body = await parseBody(req);
      const sourceCanvas = db.canvases.find((item) => item.id === canvasCopyMatch[1]);
      if (!sourceCanvas) return notFound(res);
      const timestamp = now();
      const canvas = {
        ...sourceCanvas,
        id: id("canvas"),
        name: String(body.name || `${sourceCanvas.name} 副本`),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await updateJson((latestDb) => {
        latestDb.canvases.push(canvas);
        const latestProject = latestDb.projects.find((item) => item.id === sourceCanvas.projectId);
        if (latestProject) latestProject.updatedAt = timestamp;
      });
      send(res, 201, { canvas });
      return;
    }

    const snapshotMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/snapshot$/);
    if (snapshotMatch && req.method === "PUT") {
      const body = await parseBody(req);
      const shouldBackup = body.backupOperation === "history-restore";
      const backup = shouldBackup ? await createRequiredDbBackup("history-restore") : undefined;
      const updatedCanvas = await updateJson((latestDb) => {
        const canvas = latestDb.canvases.find((item) => item.id === snapshotMatch[1]);
        if (!canvas) return null;
        canvas.snapshot = body.snapshot || emptySnapshot;
        canvas.updatedAt = now();
        return canvas;
      });
      if (!updatedCanvas) return notFound(res);
      send(res, 200, { canvas: updatedCanvas, backup });
      return;
    }

    const yjsHistoryMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/yjs-history$/);
    if (yjsHistoryMatch && req.method === "GET") {
      const canvas = db.canvases.find((item) => item.id === yjsHistoryMatch[1]);
      if (!canvas) return notFound(res);
      send(res, 200, { snapshots: await listCanvasYjsHistory(canvas.id) });
      return;
    }

    const yjsHistoryDetailMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/yjs-history\/([^/]+)$/);
    if (yjsHistoryDetailMatch && req.method === "GET") {
      const canvas = db.canvases.find((item) => item.id === yjsHistoryDetailMatch[1]);
      if (!canvas) return notFound(res);
      const detail = await getCanvasYjsHistorySnapshot(canvas.id, yjsHistoryDetailMatch[2]);
      if (!detail) return notFound(res);
      send(res, 200, detail);
      return;
    }

    const yjsCompactMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/yjs-compact$/);
    if (yjsCompactMatch && req.method === "POST") {
      const canvas = db.canvases.find((item) => item.id === yjsCompactMatch[1]);
      if (!canvas) return notFound(res);
      const snapshot = await compactCanvasYDoc(canvas.id);
      send(res, 201, {
        snapshot: {
          ...snapshot,
          update: undefined,
          updateSize: typeof snapshot.update === "string" ? Buffer.byteLength(snapshot.update, "base64") : 0,
        },
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/assets") {
      const projectId = url.searchParams.get("projectId");
      const assets = projectId ? db.assets.filter((item) => item.projectId === projectId) : db.assets;
      send(res, 200, { assets });
      return;
    }

    if (req.method === "POST" && pathname === "/api/assets") {
      const body = await parseBody(req);
      if (!body.projectId || !body.url || !body.type) return badRequest(res, "projectId, type and url are required");
      const asset = {
        id: id("asset"),
        projectId: body.projectId,
        type: body.type,
        url: body.url,
        thumbnailUrl: body.thumbnailUrl,
        mimeType: body.mimeType || "application/octet-stream",
        size: Number(body.size || 0),
        source: body.source || "upload",
        name: body.name || undefined,
        createdBy: body.createdBy || "local-user",
        createdAt: now(),
      };
      await updateJson((latestDb) => {
        latestDb.assets.unshift(asset);
      });
      send(res, 201, { asset });
      return;
    }

    const assetMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (assetMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const updatedAsset = await updateJson((latestDb) => {
        const asset = latestDb.assets.find((item) => item.id === assetMatch[1]);
        if (!asset) return null;
        if ("name" in body) asset.name = String(body.name || "");
        return asset;
      });
      if (!updatedAsset) return notFound(res);
      send(res, 200, { asset: updatedAsset });
      return;
    }

    if (assetMatch && req.method === "DELETE") {
      const deletedAsset = await updateJson((latestDb) => {
        const asset = latestDb.assets.find((item) => item.id === assetMatch[1]);
        if (!asset) return null;
        latestDb.assets = latestDb.assets.filter((item) => item.id !== asset.id);
        return asset;
      });
      if (!deletedAsset) return notFound(res);
      send(res, 200, { asset: deletedAsset });
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai/tasks") {
      const result = await createAiTask(await parseBody(req));
      if (result.error) return badRequest(res, result.error);
      send(res, 202, result);
      return;
    }

    const taskMatch = pathname.match(/^\/api\/ai\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === "GET") {
      try {
        const task = await getAiTask(taskMatch[1]);
        if (!task) return notFound(res);
        send(res, 200, { task });
      } catch (taskError) {
        send(res, 503, {
          error: "Service Unavailable",
          message: taskError instanceof Error ? taskError.message : String(taskError),
        });
      }
      return;
    }

    if (req.method === "GET" && internalPathname === "/internal/overview") {
      send(res, 200, { overview: buildAdminOverview(db) });
      return;
    }

    if (req.method === "GET" && internalPathname === "/internal/tasks") {
      send(res, 200, { tasks: enrichAdminTaskList(db.tasks, db.models, db.providers) });
      return;
    }

    if (req.method === "GET" && internalPathname === "/internal/system-events") {
      send(res, 200, listSystemEvents(db, {
        level: url.searchParams.get("level"),
        category: url.searchParams.get("category"),
        limit: url.searchParams.get("limit"),
      }));
      return;
    }

    if (req.method === "POST" && internalPathname === "/internal/tasks/retry-batch") {
      const body = await parseBody(req);
      const enrichedTasks = enrichAdminTaskList(db.tasks, db.models, db.providers);
      const retryPlan = selectRetryableAdminTasks(enrichedTasks, {
        taskIds: body.taskIds,
        errorCategory: body.errorCategory,
        statuses: body.statuses,
        limit: body.limit,
      });
      const retriedTasks = [];
      const failed = [];
      for (const task of retryPlan.selected) {
        try {
          const retriedTask = await retryAiTask(task.id);
          if (retriedTask) retriedTasks.push(retriedTask);
          else failed.push({ taskId: task.id, reason: "not_found" });
        } catch (error) {
          failed.push({ taskId: task.id, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      await recordRuntimeEvent({
        level: failed.length ? "warning" : "info",
        category: "task",
        source: "admin",
        message: "后台批量重试任务",
        metadata: {
          requested: retryPlan.selected.length,
          retried: retriedTasks.length,
          failed: failed.length,
          skipped: retryPlan.skipped.length,
          errorCategory: body.errorCategory || "",
        },
      });
      const latestDb = await readJson();
      send(res, 202, {
        retried: enrichAdminTaskList(retriedTasks, latestDb.models, latestDb.providers),
        retriedCount: retriedTasks.length,
        skipped: [...retryPlan.skipped, ...failed],
        requestedCount: retryPlan.selected.length,
        limit: retryPlan.limit,
      });
      return;
    }

    const adminTaskDetailMatch = internalPathname.match(/^\/internal\/tasks\/([^/]+)$/);
    if (adminTaskDetailMatch && req.method === "GET") {
      const task = db.tasks.find((item) => item.id === adminTaskDetailMatch[1]);
      if (!task) return notFound(res);
      send(res, 200, { task: enrichAdminTask(task, db.models, db.providers) });
      return;
    }

    const adminTaskCancelMatch = internalPathname.match(/^\/internal\/tasks\/([^/]+)\/cancel$/);
    if (adminTaskCancelMatch && req.method === "POST") {
      const task = await cancelAiTask(adminTaskCancelMatch[1]);
      if (!task) return notFound(res);
      await recordRuntimeEvent({
        level: "info",
        category: "task",
        source: "admin",
        message: "后台任务已取消",
        metadata: { taskId: task.id, status: task.status, type: task.type, modelId: task.modelId },
      });
      send(res, 200, { task });
      return;
    }

    const adminTaskRetryMatch = internalPathname.match(/^\/internal\/tasks\/([^/]+)\/retry$/);
    if (adminTaskRetryMatch && req.method === "POST") {
      const task = await retryAiTask(adminTaskRetryMatch[1]);
      if (!task) return notFound(res);
      await recordRuntimeEvent({
        level: "info",
        category: "task",
        source: "admin",
        message: "后台任务已重新入队",
        metadata: { taskId: task.id, status: task.status, type: task.type, modelId: task.modelId },
      });
      send(res, 202, { task });
      return;
    }

    if (req.method === "GET" && internalPathname === "/internal/providers") {
      send(res, 200, { providers: db.providers.map(publicProvider) });
      return;
    }

    if (req.method === "POST" && internalPathname === "/internal/providers") {
      const body = await parseBody(req);
      const timestamp = now();
      const provider = {
        id: body.id || id("provider"),
        name: String(body.name || "未命名供应商"),
        type: body.type || "custom-http",
        baseUrl: String(body.baseUrl || ""),
        authType: body.authType || "none",
        secretValue: body.secret || body.secretValue || undefined,
        secretStorage: body.secret || body.secretValue ? "plain-local-json" : undefined,
        timeoutSeconds: Number(body.timeoutSeconds || 30),
        enabled: body.enabled !== false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await updateJson((latestDb) => {
        latestDb.providers.push(provider);
      });
      await recordRuntimeEvent({
        level: "info",
        category: "model",
        source: "admin",
        message: "供应商配置已创建",
        metadata: { providerId: provider.id, name: provider.name, type: provider.type, authType: provider.authType },
      });
      send(res, 201, { provider: publicProvider(provider) });
      return;
    }

    const providerTestMatch = internalPathname.match(/^\/internal\/providers\/([^/]+)\/test$/);
    if (providerTestMatch && req.method === "POST") {
      const provider = db.providers.find((item) => item.id === providerTestMatch[1]);
      if (!provider) return notFound(res);
      if (!provider.enabled) {
        await recordRuntimeEvent({
          level: "warning",
          category: "model",
          source: "admin",
          message: "禁用供应商被测试",
          metadata: { providerId: provider.id, name: provider.name },
        });
        return badRequest(res, "供应商已禁用");
      }
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(provider.timeoutSeconds || 30) * 1000);
      try {
        const response = await fetch(provider.baseUrl, { method: "GET", signal: controller.signal });
        if (!response.ok && response.status >= 500) {
          await recordRuntimeEvent({
            level: "warning",
            category: "model",
            source: "admin",
            message: "供应商测试返回异常状态",
            metadata: { providerId: provider.id, name: provider.name, status: response.status, latencyMs: Date.now() - startedAt },
          });
        }
        send(res, 200, {
          ok: response.ok || response.status < 500,
          message: `连接完成，HTTP ${response.status}`,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        await recordRuntimeEvent({
          level: "warning",
          category: "model",
          source: "admin",
          message: "供应商测试连接失败",
          metadata: { providerId: provider.id, name: provider.name, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - startedAt },
        });
        send(res, 200, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          latencyMs: Date.now() - startedAt,
        });
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    const providerMatch = internalPathname.match(/^\/internal\/providers\/([^/]+)$/);
    if (providerMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const updatedProvider = await updateJson((latestDb) => {
        const provider = latestDb.providers.find((item) => item.id === providerMatch[1]);
        if (!provider) return null;
        for (const key of ["name", "type", "baseUrl", "authType", "timeoutSeconds", "enabled"]) {
          if (key in body) provider[key] = body[key];
        }
        if ("secret" in body || "secretValue" in body) {
          provider.secretValue = body.secret || body.secretValue || undefined;
          provider.secretStorage = provider.secretValue ? "plain-local-json" : undefined;
        }
        provider.updatedAt = now();
        return provider;
      });
      if (!updatedProvider) return notFound(res);
      await recordRuntimeEvent({
        level: "info",
        category: "model",
        source: "admin",
        message: "供应商配置已更新",
        metadata: { providerId: updatedProvider.id, name: updatedProvider.name, enabled: updatedProvider.enabled },
      });
      send(res, 200, { provider: publicProvider(updatedProvider) });
      return;
    }

    if (req.method === "GET" && internalPathname === "/internal/models") {
      send(res, 200, { models: db.models });
      return;
    }

    if (req.method === "POST" && internalPathname === "/internal/models") {
      const body = await parseBody(req);
      const timestamp = now();
      const model = {
        id: body.id || id("model"),
        providerId: body.providerId,
        name: String(body.name || body.id || "custom-model"),
        displayName: String(body.displayName || body.name || "自定义模型"),
        type: body.type || "image",
        capabilities: body.capabilities || ["text-to-image"],
        defaultParams: body.defaultParams || {},
        defaultPublicParams: body.defaultPublicParams || body.defaultParams || {},
        paramSchema: body.paramSchema || {},
        publicParamSchema: body.publicParamSchema || body.paramSchema || {},
        adapter: body.adapter || { kind: "z-image-turbo" },
        enabled: body.enabled !== false,
        sortOrder: Number(body.sortOrder || 100),
        allowMockFallback: body.allowMockFallback !== false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!model.providerId) return badRequest(res, "providerId is required");
      await updateJson((latestDb) => {
        latestDb.models.push(model);
      });
      await recordRuntimeEvent({
        level: "info",
        category: "model",
        source: "admin",
        message: "模型配置已创建",
        metadata: { modelId: model.id, displayName: model.displayName, providerId: model.providerId, type: model.type },
      });
      send(res, 201, { model });
      return;
    }

    const modelMatch = internalPathname.match(/^\/internal\/models\/([^/]+)$/);
    if (modelMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const updatedModel = await updateJson((latestDb) => {
        const model = latestDb.models.find((item) => item.id === modelMatch[1]);
        if (!model) return null;
        for (const key of ["providerId", "name", "displayName", "type", "capabilities", "defaultParams", "defaultPublicParams", "paramSchema", "publicParamSchema", "adapter", "enabled", "sortOrder", "allowMockFallback"]) {
          if (key in body) model[key] = body[key];
        }
        model.updatedAt = now();
        return model;
      });
      if (!updatedModel) return notFound(res);
      await recordRuntimeEvent({
        level: "info",
        category: "model",
        source: "admin",
        message: "模型配置已更新",
        metadata: { modelId: updatedModel.id, displayName: updatedModel.displayName, providerId: updatedModel.providerId, enabled: updatedModel.enabled },
      });
      send(res, 200, { model: updatedModel });
      return;
    }

    notFound(res);
  } catch (error) {
    if (error?.code === "DB_BACKUP_FAILED") {
      await recordRuntimeEvent({
        level: "error",
        category: "backup",
        source: "api",
        message: "危险写入前备份失败",
        metadata: { method: req.method, path: pathname, operation: error.operation, error: error.message },
      });
      send(res, 503, {
        error: "Backup Failed",
        message: error.message,
        operation: error.operation,
      });
      return;
    }
    await recordRuntimeEvent({
      level: "error",
      category: "api",
      source: "api",
      message: "API 请求处理失败",
      metadata: { method: req.method, path: pathname, error: error instanceof Error ? error.message : String(error) },
    });
    send(res, 500, {
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function classifyError(errorMessage) {
  if (!errorMessage) return "other";
  const msg = String(errorMessage).toLowerCase();
  if (msg.includes("连接失败") || msg.includes("connection") || msg.includes("econnrefused") || msg.includes("enotfound")) return "connection";
  if (msg.includes("鉴权失败") || msg.includes("unauthorized") || msg.includes("401") || msg.includes("403") || msg.includes("auth")) return "auth";
  if (msg.includes("超时") || msg.includes("timeout") || msg.includes("aborted")) return "timeout";
  if (msg.includes("非 json") || msg.includes("non-json") || msg.includes("not valid json")) return "non_json";
  if (msg.includes("字段映射错误") || msg.includes("未能通过") || msg.includes("读取")) return "field_mapping";
  if (msg.includes("模型任务失败") || msg.includes("模型接口") || msg.includes("模型供应商") || msg.includes("模型已禁用")) return "model_error";
  return "other";
}

function enrichTask(task, models, providers) {
  const model = models.find((item) => item.id === task.modelId);
  const provider = model ? providers.find((item) => item.id === model.providerId) : undefined;
  const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : 0;
  const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
  const durationMs = createdAt && updatedAt ? Math.max(0, updatedAt - createdAt) : undefined;

  const inputSummary = task.input?.prompt
    ? String(task.input.prompt).slice(0, 200) + (String(task.input.prompt).length > 200 ? "…" : "")
    : undefined;

  return {
    ...task,
    modelDisplayName: model?.displayName || task.modelId || "-",
    providerName: provider?.name || "-",
    durationMs,
    errorCategory: task.status === "failed" ? classifyError(task.error) : undefined,
    inputSummary,
  };
}

function enrichTaskList(tasks, models, providers) {
  return tasks.map((task) => enrichTask(task, models, providers));
}

async function recordRuntimeEvent(event) {
  try {
    await recordSystemEvent(event);
  } catch (error) {
    console.warn("failed to record system event", error instanceof Error ? error.message : error);
  }
}

await ensureDb();
const queueStatus = await initializeTaskQueue(runTask);
await recordRuntimeEvent({
  level: "info",
  category: "system",
  source: "api",
  message: "API 服务已启动",
  metadata: { port: PORT, queueMode: queueStatus.mode },
});

const server = createServer(handle);
attachCollaborationServer(server);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`anime-canvas-api listening on ${PORT}`);
  console.log(`task queue mode: ${queueStatus.mode}`);
});
