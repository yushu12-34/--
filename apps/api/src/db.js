import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { now } from "./utils/http.js";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const DB_FILE = path.join(DATA_DIR, "db.json");

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

export async function ensureDb() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    const timestamp = now();
    await writeJson({
      users: [defaultUser(timestamp)],
      projects: [],
      canvases: [],
      assets: [],
      tasks: [],
      workflowUpdates: [],
      workflowSnapshots: [],
      providers: [defaultProvider(timestamp), defaultZImageProvider(timestamp)],
      models: [defaultModel(timestamp), defaultZImageModel(timestamp)],
    });
    return;
  }

  let db;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    const raw = await readFile(DB_FILE, "utf8");
    db = null;
    for (let i = raw.length - 1; i > 0; i--) {
      if (raw[i] === "}") {
        try {
          db = JSON.parse(raw.slice(0, i + 1));
          await writeFile(DB_FILE + ".tmp", raw.slice(0, i + 1), "utf8");
          await rename(DB_FILE + ".tmp", DB_FILE);
          break;
        } catch {}
      }
    }
    if (!db) throw new Error("数据库文件损坏且无法恢复");
  }
  const timestamp = now();
  let changed = false;
  if (!db.users) { db.users = [defaultUser(timestamp)]; changed = true; }
  if (!db.providers) { db.providers = []; changed = true; }
  if (!db.models) { db.models = []; changed = true; }
  if (!db.projects) { db.projects = []; changed = true; }
  if (!db.canvases) { db.canvases = []; changed = true; }
  if (!db.assets) { db.assets = []; changed = true; }
  if (!db.tasks) { db.tasks = []; changed = true; }
  if (!db.workflowUpdates) { db.workflowUpdates = []; changed = true; }
  if (!db.workflowSnapshots) { db.workflowSnapshots = []; changed = true; }

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

  if (changed) await writeJson(db);
}

export async function readJson(shouldEnsure = true) {
  if (shouldEnsure) await ensureDb();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(await readFile(DB_FILE, "utf8"));
    } catch {
      try {
        const raw = await readFile(DB_FILE, "utf8");
        for (let i = raw.length - 1; i > 0; i--) {
          if (raw[i] === "}") {
            try {
              const data = JSON.parse(raw.slice(0, i + 1));
              await writeFile(DB_FILE + ".tmp", raw.slice(0, i + 1), "utf8");
              await rename(DB_FILE + ".tmp", DB_FILE);
              return data;
            } catch {}
          }
        }
      } catch {}
    }
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
    await rename(tmpFile, DB_FILE);
  } catch {
    // Windows: rename fails if target is locked; fall back to direct write
    await unlink(tmpFile).catch(() => {});
    await writeFile(DB_FILE, content, "utf8");
  }
}

export async function writeJson(data) {
  const next = dbQueue.then(() => writeJsonFile(data));
  dbQueue = next.catch(() => {});
  await next;
}

export async function readJsonQueued() {
  await dbQueue.catch(() => {});
  return readJson(false);
}

export async function updateJson(mutator) {
  const next = dbQueue.then(async () => {
    const db = await readJson(false);
    const result = await mutator(db);
    await writeJsonFile(db);
    return result;
  });
  dbQueue = next.then(() => undefined, () => undefined);
  return next;
}
