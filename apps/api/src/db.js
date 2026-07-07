import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { id, now } from "./utils/http.js";
import { createPostgresStore, listProjectsView, getProjectView, getCanvasView, listCollaborativeCanvasesView, listCanvasMembersView, listAssetsView, getTaskView, getAdminOverviewView, listAdminTasksView, getAdminTaskView, listSystemEventsView, listYjsHistoryView, getYjsHistorySnapshotView, listAdminUsersView, listProvidersView, listModelsView, updateAdminUserRecord, deleteAdminUserRecord, getAuthUserByLogin, getAuthUserByTokenHash, createAuthTokenRecord, revokeAuthTokenRecord, getCanvasAccessView, getProjectAccessView, createCanvasInviteRecord, acceptCanvasInviteRecord } from "./services/postgresStore.js";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DATA_BACKEND = String(process.env.DATA_BACKEND || "json").toLowerCase();
const Z_IMAGE_API_CONFIG_VERSION = "2026-07-03-images-tasks";
const SEEDANCE_API_CONFIG_VERSION = "2026-07-02-contents-generations-tasks";
const Z_IMAGE_SIZE_OPTIONS = ["480p", "720p", "1k", "2k", "1280x720"];
const Z_IMAGE_ASPECT_RATIO_OPTIONS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"];
const SEEDANCE_RATIO_OPTIONS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];

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

function defaultSeedanceProvider(timestamp) {
  const secretValue = process.env.ARK_API_KEY || undefined;
  return {
    id: "volcengine-ark",
    name: "火山方舟 Ark",
    type: "custom-http",
    baseUrl: process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
    authType: "bearer",
    ...(secretValue ? { secretValue, secretStorage: "env:ARK_API_KEY" } : {}),
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
      model: "z-image-turbo",
    },
    defaultPublicParams: {
      size: "1k",
      aspect_ratio: "1:1",
    },
    paramSchema: {
      size: createParamSchemaConfig("尺寸", Z_IMAGE_SIZE_OPTIONS, { defaultValue: "1k" }),
      aspect_ratio: createParamSchemaConfig("宽高比", Z_IMAGE_ASPECT_RATIO_OPTIONS, { defaultValue: "1:1" }),
      n: createParamSchemaConfig("生成张数", [], { type: "number", control: "input", defaultValue: 1, publicVisible: false }),
      response_format: createParamSchemaConfig("返回格式", ["url", "b64_json"], { defaultValue: "url", publicVisible: false }),
      num_inference_steps: createParamSchemaConfig("推理步数", [], { type: "number", control: "input", defaultValue: 9, publicVisible: false }),
      model: createParamSchemaConfig("Model", [], { defaultValue: "z-image-turbo", publicVisible: false }),
    },
    publicParamSchema: {
      size: createParamSchemaConfig("尺寸", Z_IMAGE_SIZE_OPTIONS, { defaultValue: "1k" }),
      aspect_ratio: createParamSchemaConfig("宽高比", Z_IMAGE_ASPECT_RATIO_OPTIONS, { defaultValue: "1:1" }),
    },
    adapter: {
      kind: "z-image-turbo",
      configVersion: Z_IMAGE_API_CONFIG_VERSION,
      submitMethod: "POST",
      submitPath: "/v1/images/generations",
      requestTemplate: {
        prompt: "{prompt}",
        size: "{params.size}",
        aspect_ratio: "{params.aspect_ratio}",
        n: "{params.n}",
        response_format: "{params.response_format}",
        num_inference_steps: "{params.num_inference_steps}",
        model: "{params.model}",
      },
      taskIdPath: "task_id",
      pollMethod: "GET",
      taskPathTemplate: "/v1/images/tasks/{task_id}",
      statusPath: "status",
      successStatusValues: ["finished", "succeeded", "success", "completed", "done"],
      failureStatusValues: ["failed", "failure", "error", "cancelled"],
      resultPath: "data.0.url",
      b64Path: "data.0.b64_json",
      errorPath: "error",
      pollIntervalMs: 2000,
      taskNotFoundRetryMs: 60000,
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
      num_inference_steps: 40,
      negative_prompt: "",
      guidance_scale: 4.0,
      cfg_normalization: false,
    },
    defaultPublicParams: {
      size: "1k",
      aspect_ratio: "1:1",
    },
    paramSchema: {
      size: createParamSchemaConfig("尺寸", Z_IMAGE_SIZE_OPTIONS, { defaultValue: "1k" }),
      aspect_ratio: createParamSchemaConfig("宽高比", Z_IMAGE_ASPECT_RATIO_OPTIONS, { defaultValue: "1:1" }),
      n: createParamSchemaConfig("生成张数", [], { type: "number", control: "input", defaultValue: 1, publicVisible: false }),
      response_format: createParamSchemaConfig("返回格式", ["url", "b64_json"], { defaultValue: "url", publicVisible: false }),
      num_inference_steps: createParamSchemaConfig("推理步数", [], { type: "number", control: "input", defaultValue: 40, publicVisible: false }),
      negative_prompt: createParamSchemaConfig("Negative Prompt", [], { defaultValue: "", publicVisible: false }),
      guidance_scale: createParamSchemaConfig("引导强度", [], { type: "number", control: "input", defaultValue: 4, publicVisible: false }),
      cfg_normalization: createParamSchemaConfig("CFG 归一化", [], { type: "boolean", control: "checkbox", defaultValue: false, publicVisible: false }),
    },
    publicParamSchema: {
      size: createParamSchemaConfig("尺寸", Z_IMAGE_SIZE_OPTIONS, { defaultValue: "1k" }),
      aspect_ratio: createParamSchemaConfig("宽高比", Z_IMAGE_ASPECT_RATIO_OPTIONS, { defaultValue: "1:1" }),
    },
    adapter: {
      kind: "z-image",
      configVersion: Z_IMAGE_API_CONFIG_VERSION,
      submitMethod: "POST",
      submitPath: "/v1/images/generations",
      requestTemplate: {
        prompt: "{prompt}",
        size: "{params.size}",
        aspect_ratio: "{params.aspect_ratio}",
        n: "{params.n}",
        response_format: "{params.response_format}",
        num_inference_steps: "{params.num_inference_steps}",
        negative_prompt: "{params.negative_prompt}",
        guidance_scale: "{params.guidance_scale}",
        cfg_normalization: "{params.cfg_normalization}",
      },
      taskIdPath: "task_id",
      pollMethod: "GET",
      taskPathTemplate: "/v1/images/tasks/{task_id}",
      statusPath: "status",
      successStatusValues: ["finished", "succeeded", "success", "completed", "done"],
      failureStatusValues: ["failed", "failure", "error", "cancelled"],
      resultPath: "data.0.url",
      b64Path: "data.0.b64_json",
      errorPath: "error",
      pollIntervalMs: 3000,
      taskNotFoundRetryMs: 60000,
      timeoutMs: 300000,
    },
    enabled: true,
    allowMockFallback: false,
    sortOrder: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultSeedanceModel(timestamp, { fast = false } = {}) {
  const modelId = fast ? "doubao-seedance-2-0-fast-260128" : "doubao-seedance-2-0-260128";
  const resolutionOptions = fast ? ["480p", "720p"] : ["480p", "720p", "1080p", "4k"];
  return {
    id: fast ? "seedance-2-fast" : "seedance-2",
    providerId: "volcengine-ark",
    name: modelId,
    displayName: fast ? "Seedance 2.0 Fast" : "Seedance 2.0",
    type: "video",
    capabilities: ["text-to-video", "image-to-video", "video-to-video", "audio-reference", "video-with-audio"],
    defaultParams: {
      model: modelId,
      resolution: "720p",
      ratio: "adaptive",
      duration: 5,
      generate_audio: true,
      watermark: false,
      return_last_frame: false,
      priority: 0,
      web_search: false,
    },
    defaultPublicParams: {
      resolution: "720p",
      ratio: "adaptive",
      duration: 5,
      generate_audio: true,
      watermark: false,
      web_search: false,
      priority: 0,
    },
    paramSchema: {
      model: createParamSchemaConfig("Model", [], { defaultValue: modelId, publicVisible: false }),
      resolution: createParamSchemaConfig("分辨率", resolutionOptions, { defaultValue: "720p" }),
      ratio: createParamSchemaConfig("宽高比", SEEDANCE_RATIO_OPTIONS, { defaultValue: "adaptive" }),
      duration: createParamSchemaConfig("时长(秒)", [], { type: "number", control: "input", defaultValue: 5 }),
      generate_audio: createParamSchemaConfig("生成音频", [], { type: "boolean", control: "checkbox", defaultValue: true }),
      watermark: createParamSchemaConfig("水印", [], { type: "boolean", control: "checkbox", defaultValue: false }),
      return_last_frame: createParamSchemaConfig("返回尾帧", [], { type: "boolean", control: "checkbox", defaultValue: false, publicVisible: false }),
      priority: createParamSchemaConfig("优先级", [], { type: "number", control: "input", defaultValue: 0 }),
      web_search: createParamSchemaConfig("联网搜索", [], { type: "boolean", control: "checkbox", defaultValue: false }),
    },
    publicParamSchema: {
      resolution: createParamSchemaConfig("分辨率", resolutionOptions, { defaultValue: "720p" }),
      ratio: createParamSchemaConfig("宽高比", SEEDANCE_RATIO_OPTIONS, { defaultValue: "adaptive" }),
      duration: createParamSchemaConfig("时长(秒)", [], { type: "number", control: "input", defaultValue: 5 }),
      generate_audio: createParamSchemaConfig("生成音频", [], { type: "boolean", control: "checkbox", defaultValue: true }),
      watermark: createParamSchemaConfig("水印", [], { type: "boolean", control: "checkbox", defaultValue: false }),
      web_search: createParamSchemaConfig("联网搜索", [], { type: "boolean", control: "checkbox", defaultValue: false }),
      priority: createParamSchemaConfig("优先级", [], { type: "number", control: "input", defaultValue: 0 }),
    },
    adapter: {
      kind: "seedance-video",
      configVersion: SEEDANCE_API_CONFIG_VERSION,
      submitMethod: "POST",
      submitPath: "/contents/generations/tasks",
      taskIdPath: "id",
      pollMethod: "GET",
      taskPathTemplate: "/contents/generations/tasks/{task_id}",
      statusPath: "status",
      successStatusValues: ["succeeded"],
      failureStatusValues: ["failed", "cancelled", "expired"],
      resultPath: "content.video_url",
      errorPath: "error",
      pollIntervalMs: 10000,
      timeoutMs: 900000,
    },
    enabled: true,
    allowMockFallback: false,
    sortOrder: fast ? 11 : 10,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function seedanceDefaultBundle(timestamp = now()) {
  return {
    provider: defaultSeedanceProvider(timestamp),
    models: [defaultSeedanceModel(timestamp), defaultSeedanceModel(timestamp, { fast: true })],
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
    taskPathTemplate: "/v1/images/tasks/{task_id}",
    statusPath: "status",
    successStatusValues: ["finished", "succeeded", "success", "completed", "done"],
    failureStatusValues: ["failed", "failure", "error", "cancelled"],
    resultPath: "data.0.url",
    b64Path: "data.0.b64_json",
    errorPath: "error",
    pollIntervalMs: 2000,
    taskNotFoundRetryMs: 60000,
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

function syncBuiltInZImageModelConfig(model, timestamp) {
  const preset = model.id === "z-image-turbo"
    ? defaultModel(timestamp)
    : model.id === "z-image"
      ? defaultZImageModel(timestamp)
      : null;
  if (!preset) return false;
  if (model.adapter?.configVersion === preset.adapter.configVersion) return false;

  let changed = false;
  for (const key of ["name", "displayName", "type", "capabilities", "defaultParams", "defaultPublicParams", "paramSchema", "publicParamSchema", "adapter", "allowMockFallback"]) {
    if (isSameJson(model[key], preset[key])) continue;
    model[key] = preset[key];
    changed = true;
  }
  return changed;
}

function syncBuiltInSeedanceModelConfig(model, timestamp) {
  const preset = model.id === "seedance-2"
    ? defaultSeedanceModel(timestamp)
    : model.id === "seedance-2-fast"
      ? defaultSeedanceModel(timestamp, { fast: true })
      : null;
  if (!preset) return false;
  if (model.adapter?.configVersion === preset.adapter.configVersion) return false;

  let changed = false;
  for (const key of ["name", "displayName", "type", "capabilities", "defaultParams", "defaultPublicParams", "paramSchema", "publicParamSchema", "adapter", "allowMockFallback"]) {
    if (isSameJson(model[key], preset[key])) continue;
    model[key] = preset[key];
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
    authTokens: [],
    canvasInvites: [],
    projectMembers: [],
    canvasMembers: [],
    projects: [],
    canvases: [],
    assets: [],
    tasks: [],
    systemEvents: [],
    workflowUpdates: [],
    workflowSnapshots: [],
    providers: [defaultProvider(timestamp), defaultZImageProvider(timestamp), defaultSeedanceProvider(timestamp)],
    models: [defaultModel(timestamp), defaultZImageModel(timestamp), defaultSeedanceModel(timestamp), defaultSeedanceModel(timestamp, { fast: true })],
  };
}

export function normalizeDb(db, timestamp = now()) {
  if (!isDbObject(db)) db = createDefaultDb(timestamp);
  let changed = false;
  if (!Array.isArray(db.users) || db.users.length === 0) { db.users = [defaultUser(timestamp)]; changed = true; }
  if (!Array.isArray(db.userDevices)) { db.userDevices = []; changed = true; }
  if (!Array.isArray(db.authTokens)) { db.authTokens = []; changed = true; }
  if (!Array.isArray(db.canvasInvites)) { db.canvasInvites = []; changed = true; }
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

  if (!db.providers.some((provider) => provider.id === "volcengine-ark")) {
    db.providers.push(defaultSeedanceProvider(timestamp));
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

  if (!db.models.some((model) => model.id === "seedance-2")) {
    db.models.push(defaultSeedanceModel(timestamp));
    changed = true;
  }

  if (!db.models.some((model) => model.id === "seedance-2-fast")) {
    db.models.push(defaultSeedanceModel(timestamp, { fast: true }));
    changed = true;
  }

  for (const model of db.models) {
    if (syncBuiltInZImageModelConfig(model, timestamp)) {
      model.updatedAt = timestamp;
      changed = true;
    }
    if (syncBuiltInSeedanceModelConfig(model, timestamp)) {
      model.updatedAt = timestamp;
      changed = true;
    }
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
  if (!configured) return false;
  if (!process.env.DATABASE_URL) {
    throw new Error("PostgreSQL backend is required but DATABASE_URL is not set");
  }
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
  } catch (error) {
    postgresReachable = false;
    if (configured) {
      throw new Error(`PostgreSQL backend is required but unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  listCollaborativeCanvasesView,
  listCanvasMembersView,
  listAssetsView,
  getTaskView,
  getAdminOverviewView,
  listAdminTasksView,
  getAdminTaskView,
  listSystemEventsView,
  listYjsHistoryView,
  getYjsHistorySnapshotView,
  listAdminUsersView,
  listProvidersView,
  listModelsView,
  updateAdminUserRecord,
  deleteAdminUserRecord,
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
export async function updateCanvasSnapshot(canvasId, snapshot, updatedAt, options = {}) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().updateCanvasSnapshot(canvasId, snapshot, updatedAt, options);
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

export async function upsertSeedanceDefaults() {
  const timestamp = now();
  const bundle = seedanceDefaultBundle(timestamp);
  const result = await updateJson((db) => {
    if (!Array.isArray(db.providers)) db.providers = [];
    if (!Array.isArray(db.models)) db.models = [];

    const existingProvider = db.providers.find((provider) => provider.id === bundle.provider.id);
    if (existingProvider) {
      const preservedSecret = existingProvider.secretValue || existingProvider.secret || existingProvider.encryptedSecret;
      Object.assign(existingProvider, {
        ...bundle.provider,
        secretValue: bundle.provider.secretValue || preservedSecret,
        secretStorage: bundle.provider.secretStorage || (preservedSecret ? existingProvider.secretStorage || "plain-local-json" : undefined),
        createdAt: existingProvider.createdAt || bundle.provider.createdAt,
        updatedAt: timestamp,
      });
    } else {
      db.providers.push(bundle.provider);
    }

    const models = [];
    for (const seedanceModel of bundle.models) {
      const existingModel = db.models.find((model) => model.id === seedanceModel.id);
      if (existingModel) {
        Object.assign(existingModel, {
          ...seedanceModel,
          enabled: existingModel.enabled !== false,
          createdAt: existingModel.createdAt || seedanceModel.createdAt,
          updatedAt: timestamp,
        });
        models.push(existingModel);
      } else {
        db.models.push(seedanceModel);
        models.push(seedanceModel);
      }
    }
    return { provider: existingProvider || bundle.provider, models };
  });
  readCache = null;
  return result;
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
export async function findUserForLogin(login) {
  if (await isPostgresBackend()) return getAuthUserByLogin(login);
  const db = await readJson();
  const normalized = String(login || "").trim().toLowerCase();
  return (db.users || []).find((user) => (
    String(user.email || "").toLowerCase() === normalized
    || String(user.id || "") === String(login || "").trim()
  )) || null;
}

export async function getUserByAuthTokenHash(tokenHash) {
  if (await isPostgresBackend()) return getAuthUserByTokenHash(tokenHash);
  const timestamp = now();
  return updateJson((db) => {
    if (!Array.isArray(db.authTokens)) db.authTokens = [];
    const token = db.authTokens.find((item) => item.tokenHash === tokenHash);
    if (!token || new Date(token.expiresAt).getTime() <= Date.now()) return null;
    token.lastUsedAt = timestamp;
    return (db.users || []).find((user) => user.id === token.userId) || null;
  });
}

export async function createAuthToken(tokenHash, userId, expiresAt, createdAt = now()) {
  if (await isPostgresBackend()) {
    await createAuthTokenRecord(tokenHash, userId, expiresAt, createdAt);
    return { tokenHash, userId, expiresAt, createdAt, lastUsedAt: createdAt };
  }
  return updateJson((db) => {
    if (!Array.isArray(db.authTokens)) db.authTokens = [];
    const record = { tokenHash, userId, expiresAt, createdAt, lastUsedAt: createdAt };
    db.authTokens.push(record);
    return record;
  });
}

export async function revokeAuthToken(tokenHash) {
  if (await isPostgresBackend()) {
    await revokeAuthTokenRecord(tokenHash);
    return true;
  }
  return updateJson((db) => {
    if (!Array.isArray(db.authTokens)) db.authTokens = [];
    const before = db.authTokens.length;
    db.authTokens = db.authTokens.filter((item) => item.tokenHash !== tokenHash);
    return db.authTokens.length !== before;
  });
}

function getJsonCanvasAccess(db, canvasId, userId) {
  const canvas = (db.canvases || []).find((item) => item.id === canvasId);
  if (!canvas) return null;
  if (canvas.ownerId === userId) {
    return { exists: true, allowed: true, role: "owner", canvasId, projectId: canvas.projectId, ownerId: canvas.ownerId };
  }
  const member = (db.canvasMembers || []).find((item) => item.canvasId === canvasId && item.userId === userId);
  if (member) {
    return { exists: true, allowed: true, role: member.role || "viewer", canvasId, projectId: canvas.projectId, ownerId: canvas.ownerId };
  }
  return { exists: true, allowed: false, canvasId, projectId: canvas.projectId, ownerId: canvas.ownerId };
}

export async function getCanvasAccess(canvasId, userId) {
  if (await isPostgresBackend()) return getCanvasAccessView(canvasId, userId);
  return getJsonCanvasAccess(await readJson(), canvasId, userId);
}

export async function getProjectAccess(projectId, userId) {
  if (await isPostgresBackend()) return getProjectAccessView(projectId, userId);
  const db = await readJson();
  const project = (db.projects || []).find((item) => item.id === projectId);
  if (!project) return null;
  if (project.ownerId === userId) return { exists: true, allowed: true, role: "owner" };
  const projectMember = (db.projectMembers || []).find((item) => item.projectId === projectId && item.userId === userId);
  if (projectMember) return { exists: true, allowed: true, role: projectMember.role || "viewer" };
  return { exists: true, allowed: false, role: null };
}

export async function listCollaborativeCanvases(userId) {
  if (await isPostgresBackend()) return listCollaborativeCanvasesView(userId);
  const db = await readJson();
  const users = new Map((db.users || []).map((user) => [user.id, user]));
  const projects = new Map((db.projects || []).map((project) => [project.id, project]));
  return (db.canvasMembers || [])
    .filter((member) => member.userId === userId)
    .map((member) => {
      const canvas = (db.canvases || []).find((item) => item.id === member.canvasId);
      if (!canvas || canvas.ownerId === userId) return null;
      const owner = users.get(canvas.ownerId) || { id: canvas.ownerId, name: canvas.ownerId };
      const project = projects.get(canvas.projectId);
      return {
        canvas,
        role: member.role || "viewer",
        addedAt: member.addedAt,
        projectName: project?.name,
        owner: {
          id: owner.id,
          name: owner.name || owner.displayName || owner.id,
          email: owner.email,
        },
      };
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right.canvas.updatedAt).getTime() - new Date(left.canvas.updatedAt).getTime());
}

export async function createCanvasInvite(invite) {
  if (await isPostgresBackend()) return createCanvasInviteRecord(invite);
  return updateJson((db) => {
    if (!Array.isArray(db.canvasInvites)) db.canvasInvites = [];
    const record = { ...invite, usedCount: 0 };
    db.canvasInvites.push(record);
    return record;
  });
}

export async function acceptCanvasInvite(code, userId, acceptedAt = now()) {
  if (await isPostgresBackend()) return acceptCanvasInviteRecord(code, userId, acceptedAt);
  return updateJson((db) => {
    if (!Array.isArray(db.canvasInvites)) db.canvasInvites = [];
    if (!Array.isArray(db.canvasMembers)) db.canvasMembers = [];
    const invite = db.canvasInvites.find((item) => item.code === code);
    if (!invite) return null;
    const canvas = db.canvases.find((item) => item.id === invite.canvasId);
    if (!canvas) return { invite, error: "canvas_not_found" };
    if (canvas.ownerId === userId) return { invite, member: { canvasId: canvas.id, userId, role: "owner", addedAt: acceptedAt } };
    const existing = db.canvasMembers.find((item) => item.canvasId === canvas.id && item.userId === userId);
    if (existing) {
      return { invite, member: { canvasId: canvas.id, userId, role: existing.role || "viewer", addedAt: existing.addedAt || acceptedAt } };
    }
    const expired = invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now();
    const overUsed = invite.maxUses !== undefined && Number(invite.usedCount || 0) >= Number(invite.maxUses);
    if (invite.revokedAt || expired || overUsed) {
      return { invite, error: expired ? "expired" : overUsed ? "used_up" : "revoked" };
    }
    db.canvasMembers.push({ canvasId: canvas.id, userId, role: invite.role, addedAt: acceptedAt });
    invite.usedCount = Number(invite.usedCount || 0) + 1;
    return { invite, member: { canvasId: canvas.id, userId, role: invite.role, addedAt: acceptedAt } };
  });
}

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
export async function createProjectWithCanvas(project, canvas) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().createProjectWithCanvas(project, canvas);
    addCacheEntry("projects", result.project);
    addCacheEntry("canvases", result.canvas);
    return result;
  }
  return updateJson((db) => {
    db.projects.push(project);
    db.canvases.push(canvas);
    return { project, canvas };
  });
}
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

// 直接查询单个 canvas 的 Yjs 持久化数据，避免 readJson() 全库加载。
// 用于 collaborationService.getRoomYDoc 的按需加载。
export async function getCanvasYjsPersistenceDirect(canvasId) {
  if (await isPostgresBackend()) {
    return getPostgresStore().getCanvasYjsPersistence(canvasId);
  }
  // JSON 后备：动态导入以避免与 yjsPersistenceService 的循环依赖
  const { getCanvasYjsPersistence } = await import("./services/yjsPersistenceService.js");
  const db = await readJson();
  return getCanvasYjsPersistence(db, canvasId);
}

// 直接更新单个 project，避免 updateJson 全表重写。
export async function updateProject(projectId, patch) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().updateProject(projectId, patch);
    if (result) updateCacheEntry("projects", projectId, (existing) => ({ ...(existing || result), ...result }));
    return result;
  }
  return updateJson((db) => {
    const project = db.projects.find((item) => item.id === projectId);
    if (!project) return null;
    if ("name" in patch) project.name = String(patch.name || project.name);
    project.updatedAt = now();
    return project;
  });
}

// 直接更新 canvas 元数据（名称），避免 updateJson 全表重写。
export async function updateCanvasMeta(canvasId, patch) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().updateCanvasMeta(canvasId, patch);
    if (result) updateCacheEntry("canvases", canvasId, (existing) => ({ ...(existing || result), ...result }));
    return result;
  }
  return updateJson((db) => {
    const canvas = db.canvases.find((item) => item.id === canvasId);
    if (!canvas) return null;
    if ("name" in patch) canvas.name = String(patch.name || canvas.name);
    canvas.updatedAt = now();
    return canvas;
  });
}

// 直接删除 canvas（含成员清理），避免 updateJson 全表重写。
export async function deleteProjectDirect(projectId, userId) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().deleteProjectGraph(projectId, userId);
    if (result) {
      removeCacheEntries("projects", (item) => item?.id === projectId);
      const deletedCanvasIds = new Set((result.deletedCanvases || []).map((canvas) => canvas.id));
      removeCacheEntries("canvases", (item) => deletedCanvasIds.has(item?.id));
      removeCacheEntries("assets", (item) => item?.projectId === projectId);
      removeCacheEntries("canvasMembers", (item) => deletedCanvasIds.has(item?.canvasId));
      removeCacheEntries("workflowUpdates", (item) => deletedCanvasIds.has(item?.canvasId));
      removeCacheEntries("workflowSnapshots", (item) => deletedCanvasIds.has(item?.canvasId));
    }
    return result;
  }
  return null;
}

export async function deleteCanvasDirect(canvasId) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().deleteCanvas(canvasId);
    if (result) {
      removeCacheEntries("canvases", (item) => item?.id === canvasId);
      removeCacheEntries("canvasMembers", (m) => m?.canvasId === canvasId);
    }
    return result;
  }
  return updateJson((db) => {
    const canvas = db.canvases.find((item) => item.id === canvasId);
    if (!canvas) return null;
    db.canvases = db.canvases.filter((item) => item.id !== canvasId);
    if (Array.isArray(db.canvasMembers)) {
      db.canvasMembers = db.canvasMembers.filter((m) => m.canvasId !== canvasId);
    }
    return canvas;
  });
}

// 直接 upsert canvas 成员，避免 updateJson 全表重写。
export async function upsertCanvasMember(canvasId, userId, role, addedAt) {
  if (await isPostgresBackend()) {
    const member = await getPostgresStore().upsertCanvasMember(canvasId, userId, role, addedAt);
    if (member) {
      addCacheEntry("canvasMembers", member);
    }
    return member;
  }
  return updateJson((db) => {
    if (!Array.isArray(db.canvasMembers)) db.canvasMembers = [];
    const existing = db.canvasMembers.find((m) => m.canvasId === canvasId && m.userId === userId);
    if (existing) {
      existing.role = role;
      existing.addedAt = addedAt;
    } else {
      db.canvasMembers.push({ canvasId, userId, role, addedAt });
    }
    return { canvasId, userId, role, addedAt };
  });
}

// 直接删除 canvas 成员，避免 updateJson 全表重写。
export async function removeCanvasMember(canvasId, userId) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().removeCanvasMember(canvasId, userId);
    if (result) {
      removeCacheEntries("canvasMembers", (m) => m?.canvasId === canvasId && m?.userId === userId);
    }
    return result;
  }
  return updateJson((db) => {
    if (!Array.isArray(db.canvasMembers)) return null;
    const existing = db.canvasMembers.find((m) => m.canvasId === canvasId && m.userId === userId);
    if (!existing) return null;
    db.canvasMembers = db.canvasMembers.filter((m) => !(m.canvasId === canvasId && m.userId === userId));
    return { canvasId, userId };
  });
}

// 直接更新 asset，避免 updateJson 全表重写。
export async function updateAsset(assetId, patch) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().updateAsset(assetId, patch);
    if (result) updateCacheEntry("assets", assetId, (existing) => ({ ...(existing || result), ...result }));
    return result;
  }
  return updateJson((db) => {
    const asset = db.assets.find((item) => item.id === assetId);
    if (!asset) return null;
    if ("name" in patch) asset.name = String(patch.name || "");
    asset.updatedAt = now();
    return asset;
  });
}

// 直接删除 asset，避免 updateJson 全表重写。
export async function deleteAssetDirect(assetId) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().deleteAsset(assetId);
    if (result) removeCacheEntries("assets", (item) => item?.id === assetId);
    return result;
  }
  return updateJson((db) => {
    const asset = db.assets.find((item) => item.id === assetId);
    if (!asset) return null;
    db.assets = db.assets.filter((item) => item.id !== assetId);
    return asset;
  });
}

// 直接创建 provider，避免 updateJson 全表重写。
export async function createProvider(provider) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().createProvider(provider);
    if (result) addCacheEntry("providers", provider);
    return result;
  }
  return updateJson((db) => {
    db.providers.push(provider);
    return provider;
  });
}

// 直接创建 model，避免 updateJson 全表重写。
export async function createModel(model) {
  if (await isPostgresBackend()) {
    const result = await getPostgresStore().createModel(model);
    if (result) addCacheEntry("models", model);
    return result;
  }
  return updateJson((db) => {
    db.models.push(model);
    return model;
  });
}
