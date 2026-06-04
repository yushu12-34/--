import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    paramSchema: {
      size: ["480p", "720p", "1k", "2k", "1280x720"],
      aspect_ratio: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"],
    },
    adapter: {
      kind: "z-image-turbo",
      submitPath: "/v1/images/generations",
      taskPathTemplate: "/v1/tasks/{task_id}",
      resultPath: "data.0.url",
      b64Path: "data.0.b64_json",
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
    paramSchema: {
      size: ["480p", "720p", "1k", "2k"],
      aspect_ratio: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"],
    },
    adapter: {
      kind: "z-image",
      submitPath: "/v1/images/generations",
      taskPathTemplate: "/v1/tasks/{task_id}",
      resultPath: "data.0.url",
      b64Path: "data.0.b64_json",
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

export async function ensureDb() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    const timestamp = now();
    await writeJson({
      projects: [],
      canvases: [],
      assets: [],
      tasks: [],
      providers: [defaultProvider(timestamp)],
      models: [defaultModel(timestamp)],
    });
    return;
  }

  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  const timestamp = now();
  db.providers ||= [];
  db.models ||= [];
  db.projects ||= [];
  db.canvases ||= [];
  db.assets ||= [];
  db.tasks ||= [];

  for (const provider of db.providers) {
    if (provider.encryptedSecret && !provider.secretValue) {
      provider.secretValue = provider.encryptedSecret;
      delete provider.encryptedSecret;
      provider.secretStorage = "plain-local-json";
      provider.updatedAt = timestamp;
    }
  }

  if (!db.providers.some((provider) => provider.id === "z-image-local")) {
    db.providers.push(defaultProvider(timestamp));
  }

  if (!db.providers.some((provider) => provider.id === "z-image-remote")) {
    db.providers.push(defaultZImageProvider(timestamp));
  }

  if (!db.models.some((model) => model.id === "z-image-turbo")) {
    db.models.push(defaultModel(timestamp));
  }

  if (!db.models.some((model) => model.id === "z-image")) {
    db.models.push(defaultZImageModel(timestamp));
  }

  await writeJson(db);
}

export async function readJson() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

export async function writeJson(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

export async function updateJson(mutator) {
  const db = await readJson();
  const result = await mutator(db);
  await writeJson(db);
  return result;
}
