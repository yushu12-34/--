import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { id, now } from "./utils/http.js";
import { createPostgresStore, listProjectsView, getProjectView, getCanvasView, listCanvasMembersView, listAssetsView, getTaskView, getAdminOverviewView, listAdminTasksView, getAdminTaskView, listSystemEventsView, listYjsHistoryView, getYjsHistorySnapshotView } from "./services/postgresStore.js";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DATA_BACKEND = String(process.env.DATA_BACKEND || "json").toLowerCase();

export const emptySnapshot = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

function defaultProvider(timestamp) {
  return {
    id: "z-image-local",
    name: "Z-Image Turbo 本地服务",
    type: "custom-http",
    baseUrl: process.env.Z_IMAGE_BASE_URL || "http://localhost:8192",
    authType: "none",
    timeoutSeconds: 30,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultZImageProvider(timestamp) {
  return {
    id: "z-image-remote",
    name: "Z-Image 本地服务",
    type: "custom-http",
    baseUrl: process.env.Z_IMAGE_REMOTE_BASE_URL || "http://192.168.100.100:8191",
    authType: "none",
    timeoutSeconds: 60,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultModel(timestamp) {
  return {
    id: "z-image-turbo",
    providerId: "z-image-local",
    name: "z-image-turbo",
    displayName: "Z-Image Turbo",
    type: "image",
    capabilities: ["text-to-image", "image-to-image"],
    defaultParams: {
      size: "1k",
      aspect_ratio: "1:1",
      n: 1,
      response_format: "url",
      num_inference_steps: 9,
    },
    defaultPublicParams: {
      size: "1k",
      aspect_ratio: "1:1",
    },
    paramSchema: {
      size: createParamSchemaConfig("尺寸", ["480p", "720p", "1k", "2k", "1280x720"], { defaultValue: "1k" }),
      aspect_ratio: createParamSchemaConfig("宽高比", ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"], { defaultValue: "1:1" }),
      n: createParamSchemaConfig("生成张数", [], { type: "number", control: "input", defaultValue: 1, publicVisible: false }),
      response_format: createParamSchemaConfig("返回格式", ["url", "b64_json"], { defaultValue: "url", publicVisible: false }),
      num_inference_steps: createParamSchemaConfig("推理步数", [], { type: "number", control: "input", defaultValue: 9, publicVisible: false }),
    },
    publicParamSchema: {
      size: createParamSchemaConfig("尺寸", ["480p", "720p", "1k", "2k", "1280x720"], { defaultValue: "1k" }),
      aspect_ratio: createParamSchemaConfig("宽高比", ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"], { defaultValue: "1:1" }),
    },
    adapter: {
      kind: "custom-http",
      submitMethod: "POST",
      submitPath: "/v1/images/generations",
      requestTemplate: {
        prompt: "{prompt}",
        size: "{params.size}",
        aspect_ratio: "{params.aspect_ratio}",
        n: "{params.n}",
        response_format: "{params.response_format}",
        num_inference_steps: "{params.num_inference_steps}",
      },
      taskIdPath: "task_id",
      pollMethod: "GET",
      taskPathTemplate: "/v1/tasks/{task_id}",
      statusPath: "status",
      successStatusValues: ["finished"],
      failureStatusValues: ["failed"],
      resultPath: "data.0.url",
      b64Path: "data.0.b64_json",
      errorPath: "error",
      pollIntervalMs: 2000,
      timeoutMs: 120000,
    },
    enabled: true,
    allowMockFallback: false,
    sortOrder: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultZImageModel(timestamp) {
  return {
    id: "z-image",
    providerId: "z-image-remote",
    name: "z-image",
    displayName: "Z-Image",
    type: "image",
    capabilities: ["text-to-image"],
    defaultParams: {
      size: "1k",
      aspect_ratio: "1:1",
      n: 1,
      response_format: "url",
      num_inference_steps: 50,
      guidance_scale: 4.0,
      cfg_normalization: false,
    },
    defaultPublicParams: {
      size: "1k",
      aspect_ratio: "1:1",
    },
    paramSchema: {
      size: createParamSchemaConfig("尺寸", ["480p", "720p", "1k", "2k"], { defaultValue: "1k" }),
      aspect_ratio: createParamSchemaConfig("宽高比", ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"], { defaultValue: "1:1" }),
      n: createParamSchemaConfig("生成张数", [], { type: "number", control: "input", defaultValue: 1, publicVisible: false }),
      response_format: createParamSchemaConfig("返回格式", ["url", "b64_json"], { defaultValue: "url", publicVisible: false }),
      num_inference_steps: createParamSchemaConfig("推理步数", [], { type: "number", control: "input", defaultValue: 50, publicVisible: false }),
      guidance_scale: createParamSchemaConfig("引导强度", [], { type: "number", control: "input", defaultValue: 4, publicVisible: false }),
      cfg_normalization: createParamSchemaConfig("CFG 归一化", [], { type: "boolean", control: "checkbox", defaultValue: false, publicVisible: false }),
    },
    publicParamSchema: {
      size: createParamSchemaConfig("尺寸", ["480p", "720p", "1k", "2k"], { defaultValue: "1k" }),
      aspect_ratio: createParamSchemaConfig("宽高比", ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"], { defaultValue: "1:1" }),
    },
    adapter: {
      kind: "custom-http",
      submitMethod: "POST",
      submitPath: "/v1/images/generations",
      requestTemplate: {
        prompt: "{prompt}",
        size: "{params.size}",
        aspect_ratio: "{params.aspect_ratio}",
        n: "{params.n}",
        response_format: "{params.response_format}",
        num_inference_steps: "{params.num_inference_steps}",
        guidance_scale: "{params.guidance_scale}",
        cfg_normalization: "{params.cfg_normalization}",
      },
      taskIdPath: "task_id",
      pollMethod: "GET",
      taskPathTemplate: "/v1/tasks/{task_id}",
      statusPath: "status",
      successStatusValues: ["finished"],
      failureStatusValues: ["failed"],
      resultPath: "data.0.url",
      b64Path: "data.0.b64_json",
      errorPath: "error",
      pollIntervalMs: 3000,
      timeoutMs: 300000,
    },
    enabled: true,
    allowMockFallback: false,
    sortOrder: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultUser(timestamp) {
  return {
    id: "default-user",
    name: "默认用户",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function pickPublicDefaultParams(defaultParams = {}, publicParamSchema = {}) {
  const keys = Object.keys(publicParamSchema || {});
  if (!keys.length) return defaultParams || {};
  return Object.fromEntries(
    keys
      .filter((key) => Object.prototype.hasOwnProperty.call(defaultParams || {}, key))
      .map((key) => [key, defaultParams[key]]),
  );
}

function isSameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inferParamType(value) {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function createParamSchemaConfig(label, options = [], overrides = {}) {
  const defaultValue = overrides.defaultValue !== undefined ? overrides.defaultValue : options[0];
  const type = overrides.type || inferParamType(defaultValue);
  const control = overrides.control || (options.length > 0 ? "select" : type === "boolean" ? "checkbox" : "input");
  const config = {
    label,
    type,
    control,
    required: overrides.required === true,
    publicVisible: overrides.publicVisible !== false,
  };
  if (options.length > 0) config.options = options;
  if (defaultValue !== undefined) config.defaultValue = defaultValue;
  return config;
}

function humanizeParamKey(key) {
  const labels = {
    aspect_ratio: "宽高比",
    cfg_normalization: "CFG 归一化",
    guidance_scale: "引导强度",
    n: "生成张数",
    num_inference_steps: "推理步数",
    response_format: "返回格式",
    size: "尺寸",
  };
  return labels[key] || key;
}

function normalizeParamSchema(schema = {}, defaults = {}, options = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  return Object.fromEntries(
    Object.entries(schema).map(([key, config]) => {
      const isPublicVisible = options.publicVisibleKeys instanceof Set
        ? options.publicVisibleKeys.has(key)
        : options.publicVisible !== false;
      if (Array.isArray(config)) {
        return [
          key,
          createParamSchemaConfig(humanizeParamKey(key), config, {
            defaultValue: defaults[key] !== undefined ? defaults[key] : config[0],
            publicVisible: isPublicVisible,
          }),
        ];
      }
      if (config && typeof config === "object") {
        const values = Array.isArray(config.options) ? config.options : Array.isArray(config.values) ? config.values : [];
        const defaultValue = config.defaultValue !== undefined ? config.defaultValue : defaults[key] !== undefined ? defaults[key] : values[0];
        return [
          key,
          {
            label: String(config.label || humanizeParamKey(key)),
            type: config.type === "number" || config.type === "boolean" ? config.type : inferParamType(defaultValue),
            control: config.control === "select" || config.control === "input" || config.control === "checkbox"
              ? config.control
              : values.length > 0
                ? "select"
                : inferParamType(defaultValue) === "boolean"
                  ? "checkbox"
                  : "input",
            ...(values.length > 0 ? { options: values } : {}),
            ...(defaultValue !== undefined ? { defaultValue } : {}),
            required: config.required === true,
            publicVisible: config.publicVisible !== false && isPublicVisible,
          },
        ];
      }
      return [
        key,
        createParamSchemaConfig(humanizeParamKey(key), [], {
          defaultValue: defaults[key] !== undefined ? defaults[key] : config,
          publicVisible: isPublicVisible,
        }),
      ];
    }),
  );
}

function hasLegacyParamSchema(schema = {}) {
  return Object.values(schema || {}).some((config) => Array.isArray(config) || !config || typeof config !== "object");
}

function syncInternalPublicFlags(model) {
  if (!model.paramSchema || typeof model.paramSchema !== "object") return false;
  const publicKeys = new Set(Object.keys(model.publicParamSchema || {}));
  let changed = false;
  for (const [key, config] of Object.entries(model.paramSchema)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    const shouldBePublic = publicKeys.has(key);
    if (config.publicVisible !== shouldBePublic) {
      config.publicVisible = shouldBePublic;
      changed = true;
    }
  }
  return changed;
}

function completeInternalParamSchema(model) {
  if (!model.paramSchema || typeof model.paramSchema !== "object" || Array.isArray(model.paramSchema)) {
    model.paramSchema = {};
  }
  let changed = false;
  const publicKeys = new Set(Object.keys(model.publicParamSchema || {}));
  for (const [key, value] of Object.entries(model.defaultParams || {})) {
    if (model.paramSchema[key]) continue;
    model.paramSchema[key] = createParamSchemaConfig(humanizeParamKey(key), [], {
      defaultValue: value,
      type: inferParamType(value),
      control: inferParamType(value) === "boolean" ? "checkbox" : "input",
      publicVisible: publicKeys.has(key),
    });
    changed = true;
  }
  return changed;
}

function buildAdapterRequestTemplate(model) {
  return {
    prompt: "{prompt}",
    ...Object.fromEntries(
      Object.keys(model.defaultParams || {}).map((key) => [key, `{params.${key}}`]),
    ),
  };
}

function completeHttpAdapterConfig(model) {
  if (!model.adapter || typeof model.adapter !== "object" || Array.isArray(model.adapter)) {
    model.adapter = { kind: "custom-http" };
  }
  const adapter = model.adapter;
  const kind = String(adapter.kind || "custom-http");
  if (!adapter.kind) adapter.kind = kind;
  if (!["custom-http", "z-image", "z-image-turbo"].includes(kind)) return false;

  const defaults = {
    submitMethod: "POST",
    submitPath: "/v1/images/generations",
    requestTemplate: buildAdapterRequestTemplate(model),
    taskIdPath: "task_id",
    pollMethod: "GET",
    taskPathTemplate: "/v1/tasks/{task_id}",
    statusPath: "status",
    successStatusValues: ["finished", "succeeded", "success", "completed", "done"],
    failureStatusValues: ["failed", "failure", "error", "cancelled"],
    resultPath: "data.0.url",
    b64Path: "data.0.b64_json",
    errorPath: "error",
    pollIntervalMs: 2000,
    timeoutMs: 120000,
  };

  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (adapter[key] !== undefined && adapter[key] !== "") continue;
    adapter[key] = value;
    changed = true;
  }
  return changed;
}

function isDbObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function tryReadDbFile(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    if (!isDbObject(data)) return null;
    const fileStat = await stat(file);
    return { file, data, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  } catch {
    return null;
  }
}

async function tryRecoverTruncatedDbFile() {
  try {
    const raw = await readFile(DB_FILE, "utf8");
    for (let i = raw.length - 1; i > 0; i--) {
      if (raw[i] !== "}") continue;
      try {
        const data = JSON.parse(raw.slice(0, i + 1));
        if (!isDbObject(data)) continue;
        const tmpFile = `${DB_FILE}.recover-${process.pid}-${Date.now()}.tmp`;
        await writeFile(tmpFile, raw.slice(0, i + 1), "utf8");
        await rename(tmpFile, DB_FILE);
        return data;
      } catch {}
    }
  } catch {}
  return null;
}

async function listRecoveryCandidateFiles() {
  const files = [];
  try {
    for (const name of await readdir(DATA_DIR)) {
      if (name === "db.json.tmp" || /^db\.json\..+\.tmp$/.test(name)) files.push(path.join(DATA_DIR, name));
    }
  } catch {}
  try {
    for (const name of await readdir(BACKUP_DIR)) {
      if (name.endsWith(".json")) files.push(path.join(BACKUP_DIR, name));
    }
  } catch {}
  return files;
}

async function recoverDbFromCandidates() {
  const candidates = [];
  for (const file of await listRecoveryCandidateFiles()) {
    const candidate = await tryReadDbFile(file);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.size - left.size);
  const candidate = candidates[0];
  if (!candidate) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const corruptBackup = `${DB_FILE}.corrupt-${timestamp}.bak`;
  await rename(DB_FILE, corruptBackup).catch(() => {});
  const recoveryTmp = `${DB_FILE}.recovered-${process.pid}-${Date.now()}.tmp`;
  await copyFile(candidate.file, recoveryTmp);
  await rename(recoveryTmp, DB_FILE);
  console.warn(`Recovered db.json from ${candidate.file}; corrupt file preserved as ${corruptBackup}`);
  return candidate.data;
}

async function readDbWithRecovery() {
  const parsed = await tryReadDbFile(DB_FILE);
  if (parsed) return parsed.data;
  const truncated = await tryRecoverTruncatedDbFile();
  if (truncated) return truncated;
  const recovered = await recoverDbFromCandidates();
  if (recovered) return recovered;
  throw new Error("鏁版嵁搴撴枃浠舵崯鍧忎笖鏃犳硶鎭㈠");
}

async function renameWithRetry(source, target) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function createDefaultDb(timestamp = now()) {
  return {
    users: [defaultUser(timestamp)],
    userDevices: [],
    projectMembers: [],
    canvasMembers: [],
    projects: [],
    canvases: [],
    assets: [],
    tasks: [],
    systemEvents: [],
    workflowUpdates: [],
    workflowSnapshots: [],
    providers: [defaultProvider(timestamp), defaultZImageProvider(timestamp)],
    models: [defaultModel(timestamp), defaultZImageModel(timestamp)],
  };
}

export function normalizeDb(db, timestamp = now()) {
  if (!isDbObject(db)) db = createDefaultDb(timestamp);
  let changed = false;
  if (!Array.isArray(db.users) || db.users.length === 0) { db.users = [defaultUser(timestamp)]; changed = true; }
  if (!Array.isArray(db.userDevices)) { db.userDevices = []; changed = true; }
  if (!Array.isArray(db.projectMembers)) { db.projectMembers = []; changed = true; }
  if (!Array.isArray(db.canvasMembers)) { db.canvasMembers = []; changed = true; }
  if (!Array.isArray(db.providers)) { db.providers = []; changed = true; }
  if (!Array.isArray(db.models)) { db.models = []; changed = true; }
  if (!Array.isArray(db.projects)) { db.projects = []; changed = true; }
  if (!Array.isArray(db.canvases)) { db.canvases = []; changed = true; }
  if (!Array.isArray(db.assets)) { db.assets = []; changed = true; }
  if (!Array.isArray(db.tasks)) { db.tasks = []; changed = true; }
  if (!Array.isArray(db.systemEvents)) { db.systemEvents = []; changed = true; }
  if (!Array.isArray(db.workflowUpdates)) { db.workflowUpdates = []; changed = true; }
  if (!Array.isArray(db.workflowSnapshots)) { db.workflowSnapshots = []; changed = true; }

  for (const provider of db.providers) {
    if (provider.encryptedSecret && !provider.secretValue) {
      provider.secretValue = provider.encryptedSecret;
      delete provider.encryptedSecret;
      provider.secretStorage = "plain-local-json";
      provider.updatedAt = timestamp;
      changed = true;
    }
  }

  if (!db.providers.some((provider) => provider.id === "z-image-local")) {
    db.providers.push(defaultProvider(timestamp));
    changed = true;
  }

  if (!db.providers.some((provider) => provider.id === "z-image-remote")) {
    db.providers.push(defaultZImageProvider(timestamp));
    changed = true;
  }

  if (!db.models.some((model) => model.id === "z-image-turbo")) {
    db.models.push(defaultModel(timestamp));
    changed = true;
  }

  if (!db.models.some((model) => model.id === "z-image")) {
    db.models.push(defaultZImageModel(timestamp));
    changed = true;
  }

  for (const model of db.models) {
    if (!model.publicParamSchema) {
      model.publicParamSchema = model.paramSchema || {};
      model.updatedAt = timestamp;
      changed = true;
    }
    if (hasLegacyParamSchema(model.publicParamSchema)) {
      model.publicParamSchema = normalizeParamSchema(model.publicParamSchema, model.defaultPublicParams || model.defaultParams, { publicVisible: true });
      model.updatedAt = timestamp;
      changed = true;
    }
    if (hasLegacyParamSchema(model.paramSchema)) {
      model.paramSchema = normalizeParamSchema(model.paramSchema, model.defaultParams, {
        publicVisibleKeys: new Set(Object.keys(model.publicParamSchema || {})),
      });
      model.updatedAt = timestamp;
      changed = true;
    }
    if (completeInternalParamSchema(model)) {
      model.updatedAt = timestamp;
      changed = true;
    }
    if (syncInternalPublicFlags(model)) {
      model.updatedAt = timestamp;
      changed = true;
    }
    if (completeHttpAdapterConfig(model)) {
      model.updatedAt = timestamp;
      changed = true;
    }
    const filteredPublicDefaults = pickPublicDefaultParams(model.defaultPublicParams || model.defaultParams, model.publicParamSchema);
    if (!isSameJson(model.defaultPublicParams, filteredPublicDefaults)) {
      model.defaultPublicParams = filteredPublicDefaults;
      model.updatedAt = timestamp;
      changed = true;
    }
  }

  return { db, changed };
}

let postgresStore;
let postgresReachable = null;
let postgresReachableCheckedAt = 0;
const POSTGRES_REACHABLE_CACHE_MS = 15_000;

async function isPostgresBackend() {
  const configured = DATA_BACKEND === "postgres" || DATA_BACKEND === "postgresql";
  if (!configured || !process.env.DATABASE_URL) return false;
  const now = Date.now();
  if (postgresReachable !== null && now - postgresReachableCheckedAt < POSTGRES_REACHABLE_CACHE_MS) {
    return postgresReachable;
  }
  try {
    // 复用现有连接池，避免每次都创建新池测试连接
    const store = getPostgresStore();
    const pool = await store.getPool();
    const client = await pool.connect();
    client.release();
    postgresReachable = true;
  } catch {
    postgresReachable = false;
  }
  postgresReachableCheckedAt = now;
  return postgresReachable;
}

export function resetPostgresReachability() {
  postgresReachable = null;
  postgresReachableCheckedAt = 0;
}

// 供 server.js 判断当前是否使用 PostgreSQL 后端
export async function usePostgresBackend() {
  return isPostgresBackend();
}

// 导出 PostgreSQL 专用只读视图方法
export {
  listProjectsView,
  getProjectView,
  getCanvasView,
  listCanvasMembersView,
  listAssetsView,
  getTaskView,
  getAdminOverviewView,
  listAdminTasksView,
  getAdminTaskView,
  listSystemEventsView,
  listYjsHistoryView,
  getYjsHistorySnapshotView,
};

let readCache = null;
let readCachePromise = null;

function invalidateReadCache() {
  readCache = null;
  readCachePromise = null;
}

// 直接更新缓存中的单个实体，避免失效整个缓存导致下次读取重新加载所有数据
function updateCacheEntry(collection, id, updater) {
  if (!readCache || !Array.isArray(readCache[collection])) return;
  const list = readCache[collection];
  const index = list.findIndex((item) => item && item.id === id);
  if (index >= 0) {
    const updated = updater(list[index]);
    if (updated) list[index] = updated;
  } else if (updater(null)) {
    list.push(updater(null));
  }
}

// 从缓存中添加新实体
function addCacheEntry(collection, entity) {
  if (!readCache || !Array.isArray(readCache[collection])) return;
  const list = readCache[collection];
  if (!list.some((item) => item && item.id === entity.id)) {
    list.push(entity);
  }
}

function removeCacheEntries(collection, predicate) {
  if (!readCache || !Array.isArray(readCache[collection])) return;
  readCache[collection] = readCache[collection].filter((item) => !predicate(item));
}

function getPostgresStore() {
  if (!postgresStore) postgresStore = createPostgresStore({ createDefaultDb, normalizeDb });
  return postgresStore;
}

async function ensureJsonDb() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    const recovered = await recoverDbFromCandidates();
    if (recovered) {
      const normalized = normalizeDb(recovered);
      if (normalized.changed) await writeJsonFile(normalized.db);
      return;
    }
    await writeJsonFile(createDefaultDb());
    return;
  }

  const normalized = normalizeDb(await readDbWithRecovery());
  if (normalized.changed) await writeJsonFile(normalized.db);
}

let dataBackendLogged = false;
let postgresEnsured = false;
let postgresEnsurePromise = null;

export async function ensureDb() {
  const pg = await isPostgresBackend();
  if (!dataBackendLogged) {
    dataBackendLogged = true;
    console.log(`data backend: ${pg ? "postgres" : "json"}`);
  }
  if (pg) {
    // PostgreSQL 的 ensureDb 会获取全局 advisory lock 并可能全表重写，
    // 只在进程启动后执行一次即可，后续读操作直接走 readJson。
    // 使用 Promise 互斥锁确保并发的第一次调用只执行一次 ensureDb。
    if (postgresEnsured) return;
    if (!postgresEnsurePromise) {
      postgresEnsurePromise = (async () => {
        await getPostgresStore().ensureDb();
        postgresEnsured = true;
      })();
    }
    await postgresEnsurePromise;
    return;
  }
  return ensureJsonDb();
}

export async function readJson(shouldEnsure = true) {
  if (await isPostgresBackend()) {
    if (shouldEnsure) await ensureDb();
    // 使用内存缓存避免每次 readJson 都从 PostgreSQL 加载整个数据库快照（15MB+）。
    // 多个并发请求共享同一个加载 Promise，避免并发 loadPostgresSnapshot 导致卡死。
    if (readCache) return readCache;
    if (!readCachePromise) {
      readCachePromise = (async () => {
        const data = await getPostgresStore().readJson();
        readCache = data;
        readCachePromise = null;
        return data;
      })();
    }
    return readCachePromise;
  }
  if (shouldEnsure) await ensureDb();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readDbWithRecovery();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("数据库读取失败，请重试");
}

let dbQueue = Promise.resolve();

async function writeJsonFile(data) {
  const content = JSON.stringify(data, null, 2);
  const tmpFile = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpFile, content, "utf8");
    JSON.parse(await readFile(tmpFile, "utf8"));
    await renameWithRetry(tmpFile, DB_FILE);
  } catch (error) {
    const validTmp = await tryReadDbFile(tmpFile);
    if (!validTmp) await unlink(tmpFile).catch(() => {});
    throw error;
  }
}

export async function writeJson(data) {
  if (await isPostgresBackend()) {
    const next = dbQueue.then(() => getPostgresStore().writeJson(data));
    dbQueue = next.catch(() => {});
    await next;
    invalidateReadCache();
    return;
  }
  const next = dbQueue.then(() => writeJsonFile(data));
  dbQueue = next.catch(() => {});
  await next;
  invalidateReadCache();
}

export async function readJsonQueued() {
  await dbQueue.catch(() => {});
  return readJson(false);
}

export async function updateJson(mutator) {
  if (await isPostgresBackend()) {
    const next = dbQueue.then(() => getPostgresStore().updateJson(mutator));
    dbQueue = next.then(() => undefined, () => undefined);
    const result = await next;
    // 写操作完成后再清除缓存，避免写操作期间所有读请求都穿透到 PostgreSQL
    invalidateReadCache();
    return result;
  }
  const next = dbQueue.then(async () => {
    const db = await readJson(false);
    const result = await mutator(db);
    await writeJsonFile(db);
    return result;
  });
  dbQueue = next.then(() => undefined, () => undefined);
  const result = await next;
  invalidateReadCache();
  return result;
}

// 直接更新单个 canvas 的 snapshot，避免 updateJson 的全表重写。
// 仅在 PostgreSQL 模式下生效；JSON 模式回退到 updateJson。
export async function updateCanvasSnapshot(canvasId, snapshot, updatedAt) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().updateCanvasSnapshot(canvasId, snapshot, updatedAt);
    if (result) updateCacheEntry("canvases", canvasId, (existing) => ({ ...(existing || result), ...result, snapshot: snapshot || emptySnapshot, updatedAt }));
    return result;
  }
  return updateJson((db) => {
    const canvas = db.canvases.find((item) => item.id === canvasId);
    if (!canvas) return null;
    canvas.snapshot = snapshot || emptySnapshot;
    canvas.updatedAt = updatedAt;
    return canvas;
  });
}

// 直接更新单个 model，避免 updateJson 的全表重写。
export async function persistYjsUpdateDirect(canvasId, encodedUpdate, options = {}) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().persistYjsUpdate(canvasId, encodedUpdate, {
      id: id("yupdate"),
      snapshotId: id("ysnapshot"),
      timestamp: now(),
      ...options,
    });
    if (result?.update) addCacheEntry("workflowUpdates", result.update);
    if (result?.snapshot) {
      addCacheEntry("workflowSnapshots", result.snapshot);
      removeCacheEntries("workflowUpdates", (record) => (
        record?.canvasId === canvasId && Number(record.clock || 0) <= Number(result.snapshot.clock || 0)
      ));
    }
    return { handled: true, result };
  }
  return { handled: false, result: null };
}

export async function saveYjsSnapshotDirect(canvasId, encodedSnapshotUpdate, options = {}) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().saveYjsSnapshot(canvasId, encodedSnapshotUpdate, {
      id: id("ysnapshot"),
      timestamp: now(),
      ...options,
    });
    if (result) {
      addCacheEntry("workflowSnapshots", result);
      removeCacheEntries("workflowUpdates", (record) => record?.canvasId === canvasId);
    }
    return { handled: true, result };
  }
  return { handled: false, result: null };
}

export async function updateModel(modelId, patch) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().updateModel(modelId, patch);
    if (result) updateCacheEntry("models", modelId, (existing) => ({ ...(existing || result), ...result }));
    return result;
  }
  return updateJson((db) => {
    const model = db.models.find((item) => item.id === modelId);
    if (!model) return null;
    for (const key of ["providerId", "name", "displayName", "type", "capabilities", "defaultParams", "defaultPublicParams", "paramSchema", "publicParamSchema", "adapter", "enabled", "sortOrder", "allowMockFallback"]) {
      if (key in patch) model[key] = patch[key];
    }
    model.updatedAt = now();
    return model;
  });
}

// 直接更新单个 provider，避免 updateJson 的全表重写。
export async function updateProvider(providerId, patch) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().updateProvider(providerId, patch);
    if (result) updateCacheEntry("providers", providerId, (existing) => ({ ...(existing || result), ...result }));
    return result;
  }
  return updateJson((db) => {
    const provider = db.providers.find((item) => item.id === providerId);
    if (!provider) return null;
    for (const key of ["name", "type", "baseUrl", "authType", "timeoutSeconds", "enabled"]) {
      if (key in patch) provider[key] = patch[key];
    }
    if ("secret" in patch || "secretValue" in patch) {
      provider.secretValue = patch.secret || patch.secretValue || undefined;
      provider.secretStorage = provider.secretValue ? "plain-local-json" : undefined;
    }
    provider.updatedAt = now();
    return provider;
  });
}

// 直接插入 user，避免 updateJson 的全表重写。
export async function createUser(user) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().createUser(user);
    addCacheEntry("users", user);
    return result;
  }
  return updateJson((db) => {
    if (!db.users) db.users = [];
    db.users.push(user);
    return user;
  });
}

// 直接插入 project，避免 updateJson 的全表重写。
export async function createProject(project) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().createProject(project);
    addCacheEntry("projects", project);
    return result;
  }
  return updateJson((db) => {
    db.projects.push(project);
    return project;
  });
}

// 直接插入 canvas，避免 updateJson 的全表重写。
export async function createCanvas(canvas) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().createCanvas(canvas);
    addCacheEntry("canvases", canvas);
    return result;
  }
  return updateJson((db) => {
    db.canvases.push(canvas);
    return canvas;
  });
}

// 直接插入 task，避免 updateJson 的全表重写。
export async function createTask(task) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().createTask(task);
    addCacheEntry("tasks", task);
    return result;
  }
  return updateJson((db) => {
    db.tasks.unshift(task);
    return task;
  });
}

// 直接更新 task，避免 updateJson 的全表重写。
export async function updateTask(taskId, patch) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().updateTask(taskId, patch);
    if (result) updateCacheEntry("tasks", taskId, (existing) => ({ ...(existing || {}), ...result }));
    return result;
  }
  return updateJson((db) => {
    const task = db.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: now() });
    return task;
  });
}

// 直接插入 asset，避免 updateJson 的全表重写。
export async function createAsset(asset) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().createAsset(asset);
    addCacheEntry("assets", asset);
    return result;
  }
  return updateJson((db) => {
    db.assets.unshift(asset);
    return asset;
  });
}

// 直接插入 system_event，避免 updateJson 的全表重写。
export async function appendSystemEventDirect(event) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().appendSystemEvent(event);
    addCacheEntry("systemEvents", event);
    return result;
  }
  return updateJson((db) => {
    if (!Array.isArray(db.systemEvents)) db.systemEvents = [];
    db.systemEvents.unshift(event);
    db.systemEvents = db.systemEvents.slice(0, 500);
    return event;
  });
}
