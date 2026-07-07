import { createServer } from "node:http";
import { emptySnapshot, ensureDb, readJson, updateJson, updateCanvasSnapshot, updateModel, updateProvider, upsertSeedanceDefaults, createUser, createProject, createProjectWithCanvas, createCanvas, createAsset, usePostgresBackend, listProjectsView, getProjectView, getCanvasView, listCollaborativeCanvases, listCanvasMembersView, listAssetsView, getTaskView, getAdminOverviewView, listAdminTasksView, getAdminTaskView, listSystemEventsView, listYjsHistoryView, getYjsHistorySnapshotView, listAdminUsersView, listProvidersView, listModelsView, updateAdminUserRecord, deleteAdminUserRecord, updateProject, updateCanvasMeta, deleteProjectDirect, deleteCanvasDirect, upsertCanvasMember, removeCanvasMember, updateAsset, deleteAssetDirect, createProvider, createModel, findUserForLogin, getUserByAuthTokenHash, createAuthToken, revokeAuthToken, getCanvasAccess, getProjectAccess, createCanvasInvite, acceptCanvasInvite } from "./db.js";
import { badRequest, id, isInternalAdminRequest, notFound, now, parseBody, publicModel, publicProvider, send } from "./utils/http.js";
import { createSessionToken, hashPassword, hashToken, publicUser, verifyPassword } from "./services/authService.js";
import { createAiTask, getAiTask, cancelAiTask, retryAiTask, runTask } from "./services/taskService.js";
import { initializeTaskQueue } from "./services/queueService.js";
import { attachCollaborationServer, compactCanvasYDoc, getCanvasYjsHistorySnapshot, listCanvasYjsHistory, notifyCanvasAccessRevoked } from "./services/collaborationService.js";
import { buildProjectBundle, buildProjectList, copyProject, deleteProjectGraph, importProjectBundle, validateProjectBundle } from "./services/projectArchiveService.js";
import { createRequiredDbBackup } from "./services/backupService.js";
import { buildAdminOverview, enrichAdminTask, enrichAdminTaskList, selectRetryableAdminTasks } from "./services/adminOverviewService.js";
import { listSystemEvents, recordSystemEvent } from "./services/systemEventService.js";
import { getStoredObject, storeAssetObject } from "./services/storageService.js";

const PORT = Number(process.env.API_PORT || 8787);
const AUTH_TOKEN_TTL_DAYS = Number(process.env.AUTH_TOKEN_TTL_DAYS || 30);
const ALLOW_LEGACY_USER_HEADER = process.env.AUTH_ALLOW_LEGACY_USER_HEADER !== "false";

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
}

function getLegacyUserId(req, url) {
  if (!ALLOW_LEGACY_USER_HEADER) return "";
  return String(req.headers["x-user-id"] || url.searchParams.get("userId") || "");
}

async function getRequestUser(req, url) {
  const token = getBearerToken(req);
  if (token) {
    const user = await getUserByAuthTokenHash(hashToken(token));
    if (user) return publicUser(user);
  }
  const legacyUserId = getLegacyUserId(req, url);
  return legacyUserId ? { id: legacyUserId, name: legacyUserId } : null;
}

function unauthorized(res, message = "Authentication is required") {
  send(res, 401, { error: "Unauthorized", message });
}

function forbidden(res, message = "Access denied") {
  send(res, 403, { error: "Forbidden", message });
}

async function requireRequestUser(req, res, url) {
  const user = await getRequestUser(req, url);
  if (!user?.id) {
    unauthorized(res);
    return null;
  }
  return user;
}

function sessionExpiresAt() {
  return new Date(Date.now() + AUTH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function inviteCode() {
  return createSessionToken().slice(0, 16);
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-user-id",
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

    // PostgreSQL 专用读取路径：对已优化的 GET 路由直接查询，避免 readJson() 整库快照加载
    const storageMatch = pathname.match(/^\/api\/storage\/(.+)$/);
    if (req.method === "GET" && storageMatch) {
      const objectName = decodeURIComponent(storageMatch[1]);
      if (!objectName || objectName.includes("..")) return badRequest(res, "Invalid object name");
      const stored = await getStoredObject(objectName);
      const contentType = stored.stat?.metaData?.["content-type"] || stored.stat?.metaData?.["Content-Type"] || stored.stat?.contentType || "application/octet-stream";
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "public, max-age=31536000, immutable",
        "access-control-allow-origin": "*",
      });
      stored.stream.on("error", (error) => {
        console.error(`[api] GET ${pathname} storage stream failed`, error instanceof Error ? error.message : error);
        if (!res.headersSent) send(res, 500, { error: "Storage stream failed" });
        else res.destroy(error);
      });
      stored.stream.pipe(res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/register") {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || email || "User").trim();
      if (!email || !email.includes("@")) return badRequest(res, "Valid email is required");
      if (password.length < 6) return badRequest(res, "Password must be at least 6 characters");
      const existing = await findUserForLogin(email);
      if (existing) return badRequest(res, "Email already registered");
      const timestamp = now();
      const user = {
        id: id("user"),
        name,
        displayName: name,
        email,
        passwordHash: await hashPassword(password),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await createUser(user);
      const token = createSessionToken();
      await createAuthToken(hashToken(token), user.id, sessionExpiresAt(), timestamp);
      send(res, 201, { user: publicUser(user), token });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await parseBody(req);
      const login = String(body.email || body.login || "").trim();
      const password = String(body.password || "");
      if (!login || !password) return badRequest(res, "Email and password are required");
      const user = await findUserForLogin(login);
      if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
        unauthorized(res, "Invalid email or password");
        return;
      }
      const token = createSessionToken();
      await createAuthToken(hashToken(token), user.id, sessionExpiresAt(), now());
      send(res, 200, { user: publicUser(user), token });
      return;
    }

    if (req.method === "GET" && pathname === "/api/auth/me") {
      const user = await requireRequestUser(req, res, url);
      if (!user) return;
      send(res, 200, { user });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const token = getBearerToken(req);
      if (token) await revokeAuthToken(hashToken(token));
      send(res, 200, { ok: true });
      return;
    }

    const inviteAcceptMatch = pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
    if (inviteAcceptMatch && req.method === "POST") {
      const user = await requireRequestUser(req, res, url);
      if (!user) return;
      const result = await acceptCanvasInvite(inviteAcceptMatch[1], user.id, now());
      if (!result) return notFound(res);
      if (result.error) return badRequest(res, result.error);
      const canvas = result.member?.canvasId ? await getCanvasView(result.member.canvasId) : null;
      send(res, 200, { ...result, canvas });
      return;
    }

    if (req.method === "GET" && pathname === "/api/collaboration/canvases") {
      const user = await requireRequestUser(req, res, url);
      if (!user) return;
      send(res, 200, { canvases: await listCollaborativeCanvases(user.id) });
      return;
    }

    const pg = await usePostgresBackend();

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

    // ── PostgreSQL 专用 GET 路由（不调用 readJson） ──

    if (pg && req.method === "POST" && pathname === "/api/projects") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const body = await parseBody(req);
      const timestamp = now();
      const project = {
        id: id("project"),
        name: String(body.name || "Untitled Project"),
        ownerId: requestUser.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const canvas = {
        id: id("canvas"),
        projectId: project.id,
        ownerId: requestUser.id,
        name: "Main Canvas",
        snapshot: emptySnapshot,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const created = await createProjectWithCanvas(project, canvas);
      send(res, 201, created);
      return;
    }

    if (pg && req.method === "POST") {
      const _pcm = pathname.match(/^\/api\/projects\/([^/]+)\/canvases$/);
      if (_pcm) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getProjectAccess(_pcm[1], requestUser.id);
        if (!access) return notFound(res);
        if (access.role !== "owner") return forbidden(res, "Only the project owner can create canvases");
        const projectResult = await getProjectView(_pcm[1], requestUser.id);
        if (!projectResult) return notFound(res);
        const body = await parseBody(req);
        const timestamp = now();
        const canvas = {
          id: id("canvas"),
          projectId: projectResult.project.id,
          ownerId: requestUser.id,
          name: String(body.name || `Canvas ${projectResult.canvases.length + 1}`),
          snapshot: emptySnapshot,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const createdCanvas = await createCanvas(canvas);
        send(res, 201, { canvas: createdCanvas });
        return;
      }
    }

    if (pg && req.method === "DELETE") {
      const _pdm = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (_pdm) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getProjectAccess(_pdm[1], requestUser.id);
        if (!access) return notFound(res);
        if (access.role !== "owner") return forbidden(res, "Only the project owner can delete the project");
        const result = await deleteProjectDirect(_pdm[1], requestUser.id);
        if (!result) return notFound(res);
        if (!result.nextProject) {
          const timestamp = now();
          const project = {
            id: id("project"),
            name: "Untitled Project",
            ownerId: requestUser.id,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const canvas = {
            id: id("canvas"),
            projectId: project.id,
            ownerId: requestUser.id,
            name: "Main Canvas",
            snapshot: emptySnapshot,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const created = await createProjectWithCanvas(project, canvas);
          result.nextProject = created.project;
          result.nextCanvases = [created.canvas];
        }
        send(res, 200, result);
        return;
      }
    }

    if (pg && req.method === "DELETE") {
      const _cdm = pathname.match(/^\/api\/canvases\/([^/]+)$/);
      if (_cdm) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(_cdm[1], requestUser.id);
        if (!access) return notFound(res);
        if (access.role !== "owner") return forbidden(res, "Only the canvas owner can delete the canvas");
        const canvas = await getCanvasView(_cdm[1]);
        if (!canvas) return notFound(res);
        const projectResult = await getProjectView(canvas.projectId, requestUser.id);
        if (!projectResult) return notFound(res);
        const projectCanvases = projectResult.canvases.filter((item) => item.ownerId === requestUser.id);
        if (projectCanvases.length <= 1) return badRequest(res, "Keep at least one canvas");
        const deletedCanvas = await deleteCanvasDirect(canvas.id);
        if (!deletedCanvas) return notFound(res);
        const nextCanvas = projectCanvases.find((item) => item.id !== canvas.id);
        send(res, 200, { deletedCanvas, nextCanvas });
        return;
      }
    }

    if (pg && req.method === "GET" && pathname === "/api/projects") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const requestUserId = requestUser.id;
      const projects = await listProjectsView(requestUserId);
      send(res, 200, { projects });
      return;
    }

    if (pg && req.method === "GET" && pathname === "/api/models") {
      const models = (await listModelsView())
        .filter((model) => model.enabled !== false)
        .sort((left, right) => Number(left.sortOrder || 100) - Number(right.sortOrder || 100))
        .map(publicModel);
      send(res, 200, { models });
      return;
    }
    if (pg && req.method === "GET") {
      const _pm = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (_pm) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const requestUserId = requestUser.id;
        const result = await getProjectView(_pm[1], requestUserId);
        if (!result) return notFound(res);
        const access = await getProjectAccess(_pm[1], requestUserId);
        if (!access?.allowed) return forbidden(res);
        send(res, 200, result);
        return;
      }
    }

    if (pg && req.method === "GET") {
      const _cm = pathname.match(/^\/api\/canvases\/([^/]+)$/);
      if (_cm && !pathname.includes("/members") && !pathname.includes("/snapshot") && !pathname.includes("/yjs-")) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(_cm[1], requestUser.id);
        if (!access) return notFound(res);
        if (!access.allowed) return forbidden(res);
        const canvas = await getCanvasView(_cm[1]);
        if (!canvas) return notFound(res);
        send(res, 200, { canvas, access });
        return;
      }
    }

    if (pg && req.method === "GET") {
      const _cmm = pathname.match(/^\/api\/canvases\/([^/]+)\/members$/);
      if (_cmm) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(_cmm[1], requestUser.id);
        if (!access) return notFound(res);
        if (access.role !== "owner") return forbidden(res, "Only the canvas owner can manage members");
        const members = await listCanvasMembersView(_cmm[1]);
        if (!members) return notFound(res);
        send(res, 200, { members });
        return;
      }
    }

    if (pg && req.method === "POST") {
      const _cim = pathname.match(/^\/api\/canvases\/([^/]+)\/invites$/);
      if (_cim) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(_cim[1], requestUser.id);
        if (!access) return notFound(res);
        if (access.role !== "owner") return forbidden(res, "Only the canvas owner can create invite codes");
        const body = await parseBody(req);
        const timestamp = now();
        const expiresHours = Number(body.expiresHours || 72);
        const invite = await createCanvasInvite({
          id: id("invite"),
          canvasId: _cim[1],
          ownerId: requestUser.id,
          code: inviteCode(),
          role: body.role === "viewer" ? "viewer" : "editor",
          maxUses: Number.isFinite(Number(body.maxUses)) ? Math.max(1, Number(body.maxUses)) : 1,
          expiresAt: Number.isFinite(expiresHours) && expiresHours > 0
            ? new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString()
            : undefined,
          createdAt: timestamp,
        });
        send(res, 201, { invite });
        return;
      }
    }

    if (pg && req.method === "GET" && pathname === "/api/assets") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const projectId = url.searchParams.get("projectId");
      if (projectId) {
        const access = await getProjectAccess(projectId, requestUser.id);
        if (!access) return notFound(res);
        if (!access.allowed) return forbidden(res);
      }
      const assets = await listAssetsView(projectId || "");
      send(res, 200, { assets });
      return;
    }

    if (pg && req.method === "GET") {
      const _tm = pathname.match(/^\/api\/ai\/tasks\/([^/]+)$/);
      if (_tm) {
        try {
          const task = await getTaskView(_tm[1]);
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
    }

    if (pg && req.method === "GET" && internalPathname === "/internal/overview") {
      const overview = await getAdminOverviewView();
      send(res, 200, { overview });
      return;
    }

    if (pg && req.method === "GET" && internalPathname === "/internal/tasks") {
      const limit = url.searchParams.get("limit") || 200;
      const tasks = await listAdminTasksView(limit);
      send(res, 200, { tasks });
      return;
    }

    if (pg && req.method === "GET") {
      const _itm = internalPathname.match(/^\/internal\/tasks\/([^/]+)$/);
      if (_itm) {
        const task = await getAdminTaskView(_itm[1]);
        if (!task) return notFound(res);
        send(res, 200, { task });
        return;
      }
    }

    if (pg && req.method === "GET" && internalPathname === "/internal/system-events") {
      const result = await listSystemEventsView({
        level: url.searchParams.get("level"),
        category: url.searchParams.get("category"),
        limit: url.searchParams.get("limit"),
      });
      send(res, 200, result);
      return;
    }

    if (pg && req.method === "GET" && internalPathname === "/internal/users") {
      send(res, 200, { users: await listAdminUsersView() });
      return;
    }

    if (pg && req.method === "POST" && internalPathname === "/internal/users") {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || email || "User").trim();
      if (!email || !email.includes("@")) return badRequest(res, "Valid email is required");
      if (password.length < 6) return badRequest(res, "Password must be at least 6 characters");
      const existing = await findUserForLogin(email);
      if (existing) return badRequest(res, "Email already registered");
      const timestamp = now();
      const user = {
        id: id("user"),
        name,
        displayName: name,
        email,
        passwordHash: await hashPassword(password),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await createUser(user);
      await recordRuntimeEvent({
        level: "info",
        category: "security",
        source: "admin",
        message: "后台创建用户",
        metadata: { userId: user.id, email },
      });
      send(res, 201, { user: publicUser(user) });
      return;
    }

    if (pg && req.method === "DELETE") {
      const _adm = internalPathname.match(/^\/internal\/users\/([^/]+)$/);
      if (_adm) {
        const result = await deleteAdminUserRecord(_adm[1]);
        if (!result) return notFound(res);
        if (result.error === "user_owns_content") {
          return badRequest(res, `该用户仍拥有 ${result.projectCount || 0} 个项目、${result.ownedCanvasCount || 0} 个画布，请先转移或删除后再删除用户`);
        }
        await recordRuntimeEvent({
          level: "info",
          category: "security",
          source: "admin",
          message: "后台删除用户",
          metadata: { userId: result.user?.id },
        });
        send(res, 200, result);
        return;
      }
    }

    if (pg && req.method === "GET" && internalPathname === "/internal/providers") {
      send(res, 200, { providers: (await listProvidersView()).map(publicProvider) });
      return;
    }

    if (pg && req.method === "POST") {
      const _ptm = internalPathname.match(/^\/internal\/providers\/([^/]+)\/test$/);
      if (_ptm) {
        const provider = (await listProvidersView()).find((item) => item.id === _ptm[1]);
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
    }

    if (pg && req.method === "GET" && internalPathname === "/internal/models") {
      send(res, 200, { models: await listModelsView() });
      return;
    }

    if (pg && req.method === "POST" && internalPathname === "/internal/models/seedance-2/sync") {
      const result = await upsertSeedanceDefaults();
      await recordRuntimeEvent({
        level: "info",
        category: "model",
        source: "admin",
        message: "Seedance 2.0 视频模型配置已同步",
        metadata: { providerId: result.provider?.id, modelIds: (result.models || []).map((model) => model.id) },
      });
      send(res, 200, result);
      return;
    }

    if (pg && req.method === "GET") {
      const _yhm = pathname.match(/^\/api\/canvases\/([^/]+)\/yjs-history$/);
      if (_yhm) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(_yhm[1], requestUser.id);
        if (!access) return notFound(res);
        if (!access.allowed) return forbidden(res);
        const snapshots = await listYjsHistoryView(_yhm[1]);
        send(res, 200, { snapshots });
        return;
      }
    }

    if (pg && req.method === "GET") {
      const _yhdm = pathname.match(/^\/api\/canvases\/([^/]+)\/yjs-history\/([^/]+)$/);
      if (_yhdm) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(_yhdm[1], requestUser.id);
        if (!access) return notFound(res);
        if (!access.allowed) return forbidden(res);
        const detail = await getYjsHistorySnapshotView(_yhdm[1], _yhdm[2]);
        if (!detail) return notFound(res);
        send(res, 200, detail);
        return;
      }
    }

    if (pg && req.method === "DELETE") {
      const _cmdm = pathname.match(/^\/api\/canvases\/([^/]+)\/members\/([^/]+)$/);
      if (_cmdm) {
        const [, canvasId, userId] = _cmdm;
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(canvasId, requestUser.id);
        if (!access) return notFound(res);
        if (access.role !== "owner" && requestUser.id !== userId) return forbidden(res);
        const canvas = await getCanvasView(canvasId);
        if (!canvas) return notFound(res);
        if (canvas.ownerId === userId) return badRequest(res, "Cannot remove the canvas owner");
        const removed = await removeCanvasMember(canvasId, userId);
        if (!removed) return notFound(res);
        notifyCanvasAccessRevoked(canvasId, userId);
        send(res, 200, { removed: true });
        return;
      }
    }

    // ── 未命中 PostgreSQL 专用路径，回退到 readJson() ──

    if (pg && req.method === "PATCH") {
      const _aum = internalPathname.match(/^\/internal\/users\/([^/]+)$/);
      if (_aum) {
        const body = await parseBody(req);
        const updated = await updateAdminUserRecord(_aum[1], body);
        if (!updated) return notFound(res);
        send(res, 200, { user: publicUser(updated) });
        return;
      }
    }

    if (pg && req.method === "PATCH") {
      const _cmu = pathname.match(/^\/api\/canvases\/([^/]+)$/);
      if (_cmu) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(_cmu[1], requestUser.id);
        if (!access) return notFound(res);
        if (!["owner", "editor"].includes(access.role)) return forbidden(res);
        const body = await parseBody(req);
        const updatedCanvas = await updateCanvasMeta(_cmu[1], { name: body.name });
        if (!updatedCanvas) return notFound(res);
        send(res, 200, { canvas: updatedCanvas });
        return;
      }
    }

    if (pg && req.method === "PUT") {
      const _psm = pathname.match(/^\/api\/canvases\/([^/]+)\/snapshot$/);
      if (_psm) {
        const requestUser = await requireRequestUser(req, res, url);
        if (!requestUser) return;
        const access = await getCanvasAccess(_psm[1], requestUser.id);
        if (!access) return notFound(res);
        if (!["owner", "editor"].includes(access.role)) return forbidden(res);
        const body = await parseBody(req);
        const shouldBackup = body.backupOperation === "history-restore";
        const minimalResponse = url.searchParams.get("minimal") === "1";
        const backup = shouldBackup ? await createRequiredDbBackup("history-restore") : undefined;
        const updatedAt = now();
        const updatedCanvas = await updateCanvasSnapshot(_psm[1], body.snapshot || emptySnapshot, updatedAt, {
          returnSnapshot: !minimalResponse,
        });
        if (!updatedCanvas) return notFound(res);
        if (minimalResponse) {
          send(res, 200, {
            ok: true,
            canvas: { id: updatedCanvas.id, updatedAt: updatedCanvas.updatedAt || updatedAt },
            updatedAt: updatedCanvas.updatedAt || updatedAt,
            ...(backup ? { backup } : {}),
          });
          return;
        }
        send(res, 200, { canvas: updatedCanvas, backup });
        return;
      }
    }

    if (pg && req.method === "POST" && pathname === "/api/ai/tasks") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const body = await parseBody(req);
      if (body.canvasId) {
        const access = await getCanvasAccess(body.canvasId, requestUser.id);
        if (!access) return notFound(res);
        if (!["owner", "editor"].includes(access.role)) return forbidden(res);
        if (body.projectId && access.projectId !== body.projectId) return badRequest(res, "canvasId does not belong to projectId");
      }
      const result = await createAiTask({ ...body, userId: requestUser.id, createdBy: requestUser.id });
      if (result.error) return badRequest(res, result.error);
      send(res, 201, result);
      return;
    }

    if (pg && req.method === "POST" && pathname === "/api/assets") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const body = await parseBody(req);
      if (!body.projectId || !body.url || !body.type) return badRequest(res, "projectId, type and url are required");
      let writeAccess = null;
      if (body.canvasId) {
        const canvasAccess = await getCanvasAccess(body.canvasId, requestUser.id);
        if (!canvasAccess) return notFound(res);
        if (canvasAccess.projectId !== body.projectId) return badRequest(res, "canvasId does not belong to projectId");
        writeAccess = canvasAccess;
      } else {
        writeAccess = await getProjectAccess(body.projectId, requestUser.id);
        if (!writeAccess) return notFound(res);
      }
      if (!["owner", "editor"].includes(writeAccess.role)) return forbidden(res);
      const assetId = id("asset");
      const stored = await storeAssetObject({
        userId: requestUser.id,
        projectId: body.projectId,
        assetId,
        mediaType: body.type,
        sourceUrl: body.url,
        mimeType: body.mimeType,
        name: body.name,
      });
      const asset = {
        id: assetId,
        projectId: body.projectId,
        type: body.type,
        url: stored.url,
        thumbnailUrl: body.thumbnailUrl && !String(body.thumbnailUrl).startsWith("data:") ? body.thumbnailUrl : stored.url,
        mimeType: stored.mimeType || body.mimeType || "application/octet-stream",
        size: Number(stored.size || body.size || 0),
        source: body.source || "upload",
        name: body.name || undefined,
        storage: stored.storage,
        objectName: stored.objectName,
        bucket: stored.bucket,
        createdBy: requestUser.id,
        createdAt: now(),
      };
      await createAsset(asset);
      send(res, 201, { asset });
      return;
    }

    const db = await readJson();

    if (req.method === "GET" && pathname === "/api/models") {
      const models = (db.models || [])
        .filter((model) => model.enabled !== false)
        .sort((left, right) => Number(left.sortOrder || 100) - Number(right.sortOrder || 100))
        .map(publicModel);
      send(res, 200, { models });
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const requestUserId = requestUser.id;
      const allProjects = buildProjectList(db);
      const projects = requestUserId
        ? allProjects.filter((project) => {
            if (project.ownerId === requestUserId) return true;
            const members = Array.isArray(db.projectMembers) ? db.projectMembers : [];
            return members.some((m) => m.projectId === project.id && m.userId === requestUserId);
          })
        : allProjects;
      send(res, 200, { projects });
      return;
    }

    if (pg && req.method === "GET" && internalPathname === "/internal/users") {
      send(res, 200, { users: await listAdminUsersView() });
      return;
    }

    if (pg && req.method === "POST" && internalPathname === "/internal/users") {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || email || "User").trim();
      if (!email || !email.includes("@")) return badRequest(res, "Valid email is required");
      if (password.length < 6) return badRequest(res, "Password must be at least 6 characters");
      const existing = await findUserForLogin(email);
      if (existing) return badRequest(res, "Email already registered");
      const timestamp = now();
      const user = {
        id: id("user"),
        name,
        displayName: name,
        email,
        passwordHash: await hashPassword(password),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await createUser(user);
      await recordRuntimeEvent({
        level: "info",
        category: "security",
        source: "admin",
        message: "后台创建用户",
        metadata: { userId: user.id, email },
      });
      send(res, 201, { user: publicUser(user) });
      return;
    }

    const pgAdminUserMatch = internalPathname.match(/^\/internal\/users\/([^/]+)$/);
    if (pg && pgAdminUserMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const patch = { ...body };
      if (typeof patch.password === "string" && patch.password.length > 0) {
        if (patch.password.length < 6) return badRequest(res, "Password must be at least 6 characters");
        patch.passwordHash = await hashPassword(patch.password);
        delete patch.password;
      }
      const updatedUser = await updateAdminUserRecord(pgAdminUserMatch[1], patch);
      if (!updatedUser) return notFound(res);
      await recordRuntimeEvent({
        level: "info",
        category: "security",
        source: "admin",
        message: patch.passwordHash ? "后台重置用户密码" : "后台更新用户",
        metadata: { userId: updatedUser.id, email: updatedUser.email },
      });
      send(res, 200, { user: publicUser(updatedUser) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/users") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      send(res, 200, { users: [requestUser] });
      return;
    }

    if (req.method === "POST" && pathname === "/api/users") {
      send(res, 410, { error: "Use /api/auth/register to create users" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const body = await parseBody(req);
      const timestamp = now();
      const ownerId = requestUser.id;
      const project = {
        id: id("project"),
        name: String(body.name || "未命名动漫项目"),
        ownerId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const canvas = {
        id: id("canvas"),
        projectId: project.id,
        ownerId,
        name: "主画布",
        snapshot: emptySnapshot,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await createProject(project);
      await createCanvas(canvas);
      send(res, 201, { project, canvas });
      return;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === "GET") {
      const project = db.projects.find((item) => item.id === projectMatch[1]);
      if (!project) return notFound(res);
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getProjectAccess(project.id, requestUser.id);
      if (!access?.allowed) return forbidden(res);
      const requestUserId = requestUser.id;
      const canvases = db.canvases.filter((item) => {
        if (item.projectId !== project.id) return false;
        if (item.ownerId === requestUserId) return true;
        const members = Array.isArray(db.canvasMembers) ? db.canvasMembers : [];
        return members.some((m) => m.canvasId === item.id && m.userId === requestUserId);
      });
      send(res, 200, { project, canvases });
      return;
    }

    const projectCanvasMatch = pathname.match(/^\/api\/projects\/([^/]+)\/canvases$/);
    if (projectCanvasMatch && req.method === "POST") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const body = await parseBody(req);
      const project = db.projects.find((item) => item.id === projectCanvasMatch[1]);
      if (!project) return notFound(res);
      if (project.ownerId !== requestUser.id) return forbidden(res, "Only the project owner can create canvases");
      const timestamp = now();
      const requestUserId = requestUser.id;
      const canvas = {
        id: id("canvas"),
        projectId: project.id,
        ownerId: requestUserId,
        name: String(body.name || `画布 ${db.canvases.filter((item) => item.projectId === project.id).length + 1}`),
        snapshot: emptySnapshot,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await createCanvas(canvas);
      send(res, 201, { canvas });
      return;
    }

    if (projectMatch && req.method === "PATCH") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getProjectAccess(projectMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (access.role !== "owner") return forbidden(res, "Only the project owner can rename the project");
      const body = await parseBody(req);
      const updatedProject = await updateProject(projectMatch[1], { name: body.name });
      if (!updatedProject) return notFound(res);
      send(res, 200, { project: updatedProject });
      return;
    }

    const projectCopyMatch = pathname.match(/^\/api\/projects\/([^/]+)\/copy$/);
    if (projectCopyMatch && req.method === "POST") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getProjectAccess(projectCopyMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!access.allowed) return forbidden(res);
      const body = await parseBody(req);
      const copied = await updateJson((latestDb) => copyProject(latestDb, projectCopyMatch[1], {
        name: body.name,
        ownerId: requestUser.id,
      }));
      if (!copied) return notFound(res);
      send(res, 201, copied);
      return;
    }

    const projectExportMatch = pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
    if (projectExportMatch && req.method === "GET") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getProjectAccess(projectExportMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!access.allowed) return forbidden(res);
      const bundle = buildProjectBundle(db, projectExportMatch[1]);
      if (!bundle) return notFound(res);
      send(res, 200, { bundle });
      return;
    }

    const projectImportMatch = pathname.match(/^\/api\/projects\/import$/);
    if (projectImportMatch && req.method === "POST") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const body = await parseBody(req);
      const validation = validateProjectBundle(body.bundle || body);
      if (!validation.ok) return badRequest(res, validation.error);
      const backup = await createRequiredDbBackup("project-import");
      const imported = await updateJson((latestDb) => importProjectBundle(latestDb, body.bundle || body, {
        name: body.name,
        ownerId: requestUser.id,
      }));
      if (!imported) return badRequest(res, "Invalid project bundle");
      send(res, 201, { ...imported, backup });
      return;
    }

    if (projectMatch && req.method === "DELETE") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getProjectAccess(projectMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (access.role !== "owner") return forbidden(res, "Only the project owner can delete the project");
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
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(canvasMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!access.allowed) return forbidden(res);
      const canvas = db.canvases.find((item) => item.id === canvasMatch[1]);
      if (!canvas) return notFound(res);
      send(res, 200, { canvas, access });
      return;
    }

    if (canvasMatch && req.method === "PATCH") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(canvasMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!["owner", "editor"].includes(access.role)) return forbidden(res);
      const body = await parseBody(req);
      const updatedCanvas = await updateCanvasMeta(canvasMatch[1], { name: body.name });
      if (!updatedCanvas) return notFound(res);
      send(res, 200, { canvas: updatedCanvas });
      return;
    }

    if (canvasMatch && req.method === "DELETE") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(canvasMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (access.role !== "owner") return forbidden(res, "Only the canvas owner can delete the canvas");
      const result = await updateJson((latestDb) => {
        const canvas = latestDb.canvases.find((item) => item.id === canvasMatch[1]);
        if (!canvas) return null;
        const projectCanvases = latestDb.canvases.filter((item) => item.projectId === canvas.projectId);
        if (projectCanvases.length <= 1) return { error: "至少保留一个画布" };
        latestDb.canvases = latestDb.canvases.filter((item) => item.id !== canvas.id);
        if (Array.isArray(latestDb.canvasMembers)) {
          latestDb.canvasMembers = latestDb.canvasMembers.filter((m) => m.canvasId !== canvas.id);
        }
        const latestProject = latestDb.projects.find((item) => item.id === canvas.projectId);
        if (latestProject) latestProject.updatedAt = now();
        return { deletedCanvas: canvas, nextCanvas: projectCanvases.find((item) => item.id !== canvas.id) };
      });
      if (!result) return notFound(res);
      if (result.error) return badRequest(res, result.error);
      send(res, 200, result);
      return;
    }

    // 画布成员管理：列出画布的所有成员
    const canvasMembersMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/members$/);
    if (canvasMembersMatch && req.method === "GET") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(canvasMembersMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (access.role !== "owner") return forbidden(res, "Only the canvas owner can manage members");
      const canvas = db.canvases.find((item) => item.id === canvasMembersMatch[1]);
      if (!canvas) return notFound(res);
      const members = (Array.isArray(db.canvasMembers) ? db.canvasMembers : [])
        .filter((m) => m.canvasId === canvas.id)
        .map((m) => ({ ...m }));
      const ownerEntry = { canvasId: canvas.id, userId: canvas.ownerId || canvas.projectId, role: "owner", addedAt: canvas.createdAt };
      const filteredMembers = members.some((m) => m.userId === ownerEntry.userId)
        ? members
        : [ownerEntry, ...members];
      send(res, 200, { members: filteredMembers });
      return;
    }

    // 画布成员管理：邀请用户加入画布
    const canvasInvitesMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/invites$/);
    if (canvasInvitesMatch && req.method === "POST") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(canvasInvitesMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (access.role !== "owner") return forbidden(res, "Only the canvas owner can create invite codes");
      const body = await parseBody(req);
      const timestamp = now();
      const expiresHours = Number(body.expiresHours || 72);
      const invite = await createCanvasInvite({
        id: id("invite"),
        canvasId: canvasInvitesMatch[1],
        ownerId: requestUser.id,
        code: inviteCode(),
        role: body.role === "viewer" ? "viewer" : "editor",
        maxUses: 1,
        expiresAt: Number.isFinite(expiresHours) && expiresHours > 0
          ? new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString()
          : undefined,
        createdAt: timestamp,
      });
      send(res, 201, { invite });
      return;
    }

    if (canvasMembersMatch && req.method === "POST") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(canvasMembersMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (access.role !== "owner") return forbidden(res, "Only the canvas owner can manage members");
      const body = await parseBody(req);
      const canvas = db.canvases.find((item) => item.id === canvasMembersMatch[1]);
      if (!canvas) return notFound(res);
      if (!body.userId) return badRequest(res, "userId is required");
      const role = body.role === "viewer" ? "viewer" : "editor";
      const addedAt = now();
      const member = await upsertCanvasMember(canvas.id, String(body.userId), role, addedAt);
      send(res, 201, { member });
      return;
    }

    // 画布成员管理：移除成员
    const canvasMemberMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/members\/([^/]+)$/);
    if (canvasMemberMatch && req.method === "DELETE") {
      const [, canvasId, userId] = canvasMemberMatch;
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(canvasId, requestUser.id);
      if (!access) return notFound(res);
      if (access.role !== "owner" && requestUser.id !== userId) return forbidden(res);
      const canvas = db.canvases.find((item) => item.id === canvasId);
      if (!canvas) return notFound(res);
      if (canvas.ownerId === userId) return badRequest(res, "不能移除画布归属者");
      const removed = await removeCanvasMember(canvasId, userId);
      if (!removed) return notFound(res);
      notifyCanvasAccessRevoked(canvasId, userId);
      send(res, 200, { removed: true });
      return;
    }

    const canvasCopyMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/copy$/);
    if (canvasCopyMatch && req.method === "POST") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(canvasCopyMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!access.allowed) return forbidden(res);
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
      canvas.ownerId = requestUser.id;
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
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(snapshotMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!["owner", "editor"].includes(access.role)) return forbidden(res);
      const body = await parseBody(req);
      const shouldBackup = body.backupOperation === "history-restore";
      const minimalResponse = url.searchParams.get("minimal") === "1";
      const backup = shouldBackup ? await createRequiredDbBackup("history-restore") : undefined;
      // 直接更新单条 canvas snapshot，避免 PostgreSQL 全表重写导致的性能问题
      const updatedAt = now();
      const updatedCanvas = await updateCanvasSnapshot(snapshotMatch[1], body.snapshot || emptySnapshot, updatedAt, {
        returnSnapshot: !minimalResponse,
      });
      if (!updatedCanvas) return notFound(res);
      if (minimalResponse) {
        send(res, 200, {
          ok: true,
          canvas: { id: updatedCanvas.id, updatedAt: updatedCanvas.updatedAt || updatedAt },
          updatedAt: updatedCanvas.updatedAt || updatedAt,
          ...(backup ? { backup } : {}),
        });
        return;
      }
      send(res, 200, { canvas: updatedCanvas, backup });
      return;
    }

    const yjsHistoryMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/yjs-history$/);
    if (yjsHistoryMatch && req.method === "GET") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(yjsHistoryMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!access.allowed) return forbidden(res);
      const canvas = db.canvases.find((item) => item.id === yjsHistoryMatch[1]);
      if (!canvas) return notFound(res);
      send(res, 200, { snapshots: await listCanvasYjsHistory(canvas.id) });
      return;
    }

    const yjsHistoryDetailMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/yjs-history\/([^/]+)$/);
    if (yjsHistoryDetailMatch && req.method === "GET") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(yjsHistoryDetailMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!access.allowed) return forbidden(res);
      const canvas = db.canvases.find((item) => item.id === yjsHistoryDetailMatch[1]);
      if (!canvas) return notFound(res);
      const detail = await getCanvasYjsHistorySnapshot(canvas.id, yjsHistoryDetailMatch[2]);
      if (!detail) return notFound(res);
      send(res, 200, detail);
      return;
    }

    const yjsCompactMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/yjs-compact$/);
    if (yjsCompactMatch && req.method === "POST") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const access = await getCanvasAccess(yjsCompactMatch[1], requestUser.id);
      if (!access) return notFound(res);
      if (!["owner", "editor"].includes(access.role)) return forbidden(res);
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
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const projectId = url.searchParams.get("projectId");
      if (projectId) {
        const access = await getProjectAccess(projectId, requestUser.id);
        if (!access) return notFound(res);
        if (!access.allowed) return forbidden(res);
      }
      const assets = projectId ? db.assets.filter((item) => item.projectId === projectId) : db.assets;
      send(res, 200, { assets });
      return;
    }

    if (req.method === "POST" && pathname === "/api/assets") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const body = await parseBody(req);
      if (!body.projectId || !body.url || !body.type) return badRequest(res, "projectId, type and url are required");
      let writeAccess = null;
      if (body.canvasId) {
        const canvasAccess = await getCanvasAccess(body.canvasId, requestUser.id);
        if (!canvasAccess) return notFound(res);
        if (canvasAccess.projectId !== body.projectId) return badRequest(res, "canvasId does not belong to projectId");
        writeAccess = canvasAccess;
      } else {
        writeAccess = await getProjectAccess(body.projectId, requestUser.id);
        if (!writeAccess) return notFound(res);
      }
      if (!["owner", "editor"].includes(writeAccess.role)) return forbidden(res);
      const assetId = id("asset");
      const stored = await storeAssetObject({
        userId: requestUser.id,
        projectId: body.projectId,
        assetId,
        mediaType: body.type,
        sourceUrl: body.url,
        mimeType: body.mimeType,
        name: body.name,
      });
      const asset = {
        id: assetId,
        projectId: body.projectId,
        type: body.type,
        url: stored.url,
        thumbnailUrl: body.thumbnailUrl && !String(body.thumbnailUrl).startsWith("data:") ? body.thumbnailUrl : stored.url,
        mimeType: stored.mimeType || body.mimeType || "application/octet-stream",
        size: Number(stored.size || body.size || 0),
        source: body.source || "upload",
        name: body.name || undefined,
        storage: stored.storage,
        objectName: stored.objectName,
        bucket: stored.bucket,
        createdBy: requestUser.id,
        createdAt: now(),
      };
      await createAsset(asset);
      send(res, 201, { asset });
      return;
    }

    const assetMatch = pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (assetMatch && req.method === "PATCH") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const existingAsset = db.assets.find((item) => item.id === assetMatch[1]);
      if (!existingAsset) return notFound(res);
      const access = await getProjectAccess(existingAsset.projectId, requestUser.id);
      if (!access?.allowed || !["owner", "editor"].includes(access.role)) return forbidden(res);
      const body = await parseBody(req);
      const updatedAsset = await updateAsset(assetMatch[1], { name: body.name });
      if (!updatedAsset) return notFound(res);
      send(res, 200, { asset: updatedAsset });
      return;
    }

    if (assetMatch && req.method === "DELETE") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const existingAsset = db.assets.find((item) => item.id === assetMatch[1]);
      if (!existingAsset) return notFound(res);
      const access = await getProjectAccess(existingAsset.projectId, requestUser.id);
      if (!access?.allowed || !["owner", "editor"].includes(access.role)) return forbidden(res);
      const deletedAsset = await deleteAssetDirect(assetMatch[1]);
      if (!deletedAsset) return notFound(res);
      send(res, 200, { asset: deletedAsset });
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai/tasks") {
      const requestUser = await requireRequestUser(req, res, url);
      if (!requestUser) return;
      const body = await parseBody(req);
      if (body.canvasId) {
        const access = await getCanvasAccess(body.canvasId, requestUser.id);
        if (!access) return notFound(res);
        if (!["owner", "editor"].includes(access.role)) return forbidden(res);
      }
      const result = await createAiTask({ ...body, userId: requestUser.id, createdBy: requestUser.id });
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

    if (req.method === "GET" && internalPathname === "/internal/users") {
      const projects = Array.isArray(db.projects) ? db.projects : [];
      const canvases = Array.isArray(db.canvases) ? db.canvases : [];
      const canvasMembers = Array.isArray(db.canvasMembers) ? db.canvasMembers : [];
      const users = (db.users || []).map((user) => publicUser({
        ...user,
        projectCount: projects.filter((project) => project.ownerId === user.id).length,
        ownedCanvasCount: canvases.filter((canvas) => canvas.ownerId === user.id).length,
        sharedCanvasCount: canvasMembers.filter((member) => member.userId === user.id).length,
      }));
      send(res, 200, { users });
      return;
    }

    if (req.method === "POST" && internalPathname === "/internal/users") {
      const body = await parseBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const name = String(body.name || email || "User").trim();
      if (!email || !email.includes("@")) return badRequest(res, "Valid email is required");
      if (password.length < 6) return badRequest(res, "Password must be at least 6 characters");
      const existing = await findUserForLogin(email);
      if (existing) return badRequest(res, "Email already registered");
      const timestamp = now();
      const user = {
        id: id("user"),
        name,
        displayName: name,
        email,
        passwordHash: await hashPassword(password),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await createUser(user);
      send(res, 201, { user: publicUser(user) });
      return;
    }

    const adminUserMatch = internalPathname.match(/^\/internal\/users\/([^/]+)$/);
    if (adminUserMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      let nextPasswordHash;
      if (typeof body.password === "string" && body.password.length > 0) {
        if (body.password.length < 6) return badRequest(res, "Password must be at least 6 characters");
        nextPasswordHash = await hashPassword(body.password);
      }
      const updated = await updateJson((latestDb) => {
        const user = (latestDb.users || []).find((item) => item.id === adminUserMatch[1]);
        if (!user) return null;
        if ("name" in body || "displayName" in body) {
          user.name = String(body.displayName || body.name || user.name || user.id).trim();
          user.displayName = user.name;
        }
        if ("email" in body) user.email = String(body.email || "").trim().toLowerCase() || undefined;
        if (nextPasswordHash) user.passwordHash = nextPasswordHash;
        user.updatedAt = now();
        return user;
      });
      if (!updated) return notFound(res);
      send(res, 200, { user: publicUser(updated) });
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
      await createProvider(provider);
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
      const updatedProvider = await updateProvider(providerMatch[1], body);
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

    if (req.method === "POST" && internalPathname === "/internal/models/seedance-2/sync") {
      const result = await upsertSeedanceDefaults();
      await recordRuntimeEvent({
        level: "info",
        category: "model",
        source: "admin",
        message: "Seedance 2.0 视频模型配置已同步",
        metadata: { providerId: result.provider?.id, modelIds: (result.models || []).map((model) => model.id) },
      });
      send(res, 200, result);
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
      await createModel(model);
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
      const updatedModel = await updateModel(modelMatch[1], body);
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
      console.error(`[api] ${req.method} ${pathname} backup failed`, error instanceof Error ? error.stack || error.message : error);
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
    console.error(`[api] ${req.method} ${pathname} failed`, error instanceof Error ? error.stack || error.message : error);
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
// 预加载缓存，避免首次请求超时
try {
  if (await usePostgresBackend()) {
    console.log("database cache preload skipped for postgres");
  } else {
    await readJson();
    console.log("database cache preloaded");
  }
} catch (error) {
  console.warn("failed to preload database cache:", error instanceof Error ? error.message : String(error));
}
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
