import { createServer } from "node:http";
import { emptySnapshot, ensureDb, readJson, writeJson } from "./db.js";
import { badRequest, id, notFound, now, parseBody, publicProvider, send } from "./utils/http.js";
import { createAiTask, getAiTask } from "./services/taskService.js";

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

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      send(res, 200, { ok: true, service: "anime-canvas-api", time: now() });
      return;
    }

    const db = await readJson();

    if (req.method === "GET" && pathname === "/api/projects") {
      send(res, 200, { projects: db.projects });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects") {
      const body = await parseBody(req);
      const timestamp = now();
      const project = {
        id: id("project"),
        name: String(body.name || "未命名动漫项目"),
        ownerId: "local-user",
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
      db.projects.push(project);
      db.canvases.push(canvas);
      await writeJson(db);
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

    if (projectMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const project = db.projects.find((item) => item.id === projectMatch[1]);
      if (!project) return notFound(res);
      project.name = String(body.name || project.name);
      project.updatedAt = now();
      await writeJson(db);
      send(res, 200, { project });
      return;
    }

    const canvasMatch = pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (canvasMatch && req.method === "GET") {
      const canvas = db.canvases.find((item) => item.id === canvasMatch[1]);
      if (!canvas) return notFound(res);
      send(res, 200, { canvas });
      return;
    }

    const snapshotMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/snapshot$/);
    if (snapshotMatch && req.method === "PUT") {
      const body = await parseBody(req);
      const canvas = db.canvases.find((item) => item.id === snapshotMatch[1]);
      if (!canvas) return notFound(res);
      canvas.snapshot = body.snapshot || emptySnapshot;
      canvas.updatedAt = now();
      await writeJson(db);
      send(res, 200, { canvas });
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
        createdBy: "local-user",
        createdAt: now(),
      };
      db.assets.unshift(asset);
      await writeJson(db);
      send(res, 201, { asset });
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
      const task = await getAiTask(taskMatch[1]);
      if (!task) return notFound(res);
      send(res, 200, { task });
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/tasks") {
      send(res, 200, { tasks: db.tasks });
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/providers") {
      send(res, 200, { providers: db.providers.map(publicProvider) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/providers") {
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
      db.providers.push(provider);
      await writeJson(db);
      send(res, 201, { provider: publicProvider(provider) });
      return;
    }

    const providerMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)$/);
    if (providerMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const provider = db.providers.find((item) => item.id === providerMatch[1]);
      if (!provider) return notFound(res);
      for (const key of ["name", "type", "baseUrl", "authType", "timeoutSeconds", "enabled"]) {
        if (key in body) provider[key] = body[key];
      }
      if ("secret" in body || "secretValue" in body) {
        provider.secretValue = body.secret || body.secretValue || undefined;
        provider.secretStorage = provider.secretValue ? "plain-local-json" : undefined;
      }
      provider.updatedAt = now();
      await writeJson(db);
      send(res, 200, { provider: publicProvider(provider) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/models") {
      send(res, 200, { models: db.models });
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/models") {
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
        paramSchema: body.paramSchema || {},
        adapter: body.adapter || { kind: "z-image-turbo" },
        enabled: body.enabled !== false,
        sortOrder: Number(body.sortOrder || 100),
        allowMockFallback: body.allowMockFallback !== false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!model.providerId) return badRequest(res, "providerId is required");
      db.models.push(model);
      await writeJson(db);
      send(res, 201, { model });
      return;
    }

    const modelMatch = pathname.match(/^\/api\/admin\/models\/([^/]+)$/);
    if (modelMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const model = db.models.find((item) => item.id === modelMatch[1]);
      if (!model) return notFound(res);
      for (const key of ["providerId", "name", "displayName", "type", "capabilities", "defaultParams", "paramSchema", "adapter", "enabled", "sortOrder", "allowMockFallback"]) {
        if (key in body) model[key] = body[key];
      }
      model.updatedAt = now();
      await writeJson(db);
      send(res, 200, { model });
      return;
    }

    notFound(res);
  } catch (error) {
    send(res, 500, {
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

await ensureDb();

createServer(handle).listen(PORT, "0.0.0.0", () => {
  console.log(`anime-canvas-api listening on ${PORT}`);
});
