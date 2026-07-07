import { Buffer } from "node:buffer";
import { Client } from "minio";

const rawEndpoint = process.env.MINIO_ENDPOINT || "";
const endpointParts = rawEndpoint.match(/^(.+):(\d+)$/);
const endpoint = endpointParts ? endpointParts[1] : rawEndpoint;
const port = Number(process.env.MINIO_PORT || endpointParts?.[2] || 9000);
const useSSL = process.env.MINIO_USE_SSL === "true";
const accessKey = process.env.MINIO_ACCESS_KEY || "minioadmin";
const secretKey = process.env.MINIO_SECRET_KEY || "minioadmin";
const bucket = process.env.MINIO_BUCKET || "anime-canvas-assets";
let client;
let bucketReady = false;

export function isObjectStorageEnabled() {
  return Boolean(endpoint);
}

function getClient() {
  if (!isObjectStorageEnabled()) return null;
  if (!client) {
    client = new Client({ endPoint: endpoint, port, useSSL, accessKey, secretKey });
  }
  return client;
}

async function ensureBucket() {
  const activeClient = getClient();
  if (!activeClient || bucketReady) return;
  const exists = await activeClient.bucketExists(bucket).catch(() => false);
  if (!exists) await activeClient.makeBucket(bucket);
  bucketReady = true;
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const body = match[3] || "";
  return {
    mimeType,
    buffer: isBase64 ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8"),
  };
}

function extensionForMime(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "audio/mpeg") return "mp3";
  if (mimeType === "video/mp4") return "mp4";
  return "bin";
}

function publicUrlForObject(objectName) {
  return `/api/storage/${encodeURIComponent(objectName)}`;
}

export function resolveStoredObjectUrl(objectName) {
  if (!objectName) return "";
  return publicUrlForObject(objectName);
}

function objectNameFromUrl(url) {
  const value = String(url || "");
  if (!value || value.startsWith("/api/storage/")) return "";
  try {
    const parsed = new URL(value, "http://local.invalid");
    const marker = `/${bucket}/`;
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) return "";
    return decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length));
  } catch {
    return "";
  }
}

export function resolveStoredAssetUrl(url, objectName) {
  const resolvedObjectName = objectName || objectNameFromUrl(url);
  return resolvedObjectName ? resolveStoredObjectUrl(resolvedObjectName) : String(url || "");
}

function normalizeMediaType(type, mimeType) {
  if (["image", "audio", "video"].includes(type)) return type;
  if (String(mimeType || "").startsWith("audio/")) return "audio";
  if (String(mimeType || "").startsWith("video/")) return "video";
  return "image";
}

function safePathPart(value, fallback = "unknown") {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || fallback;
}

async function readSourceObject(sourceUrl, mimeType) {
  const parsed = parseDataUrl(sourceUrl);
  if (parsed) return parsed;
  const response = await fetch(String(sourceUrl));
  if (!response.ok) {
    throw new Error(`Failed to download remote asset: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    mimeType: mimeType || response.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
    buffer: Buffer.from(arrayBuffer),
  };
}

export async function storeAssetObject({ userId, projectId, assetId, mediaType, sourceUrl, mimeType, name }) {
  if (!isObjectStorageEnabled()) {
    throw new Error("Object storage is required. Set MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY and MINIO_BUCKET.");
  }

  await ensureBucket();
  const parsed = await readSourceObject(sourceUrl, mimeType);
  const resolvedMimeType = mimeType || parsed.mimeType;
  const objectName = `${safePathPart(userId, "user")}/${safePathPart(projectId, "project")}/${normalizeMediaType(mediaType, resolvedMimeType)}/${safePathPart(assetId, "asset")}-${Date.now()}.${extensionForMime(resolvedMimeType)}`;
  await getClient().putObject(bucket, objectName, parsed.buffer, parsed.buffer.length, {
    "Content-Type": resolvedMimeType,
    ...(name ? { "X-Amz-Meta-Name": encodeURIComponent(String(name)) } : {}),
  });
  return {
    url: publicUrlForObject(objectName),
    mimeType: resolvedMimeType,
    size: parsed.buffer.length,
    storage: "minio",
    objectName,
    bucket,
  };
}

export async function storeGeneratedAsset({ userId, projectId, taskId, mediaType, sourceUrl }) {
  if (!isObjectStorageEnabled()) {
    throw new Error("Object storage is required. Set MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY and MINIO_BUCKET.");
  }

  await ensureBucket();
  const parsed = await readSourceObject(sourceUrl);
  const objectName = `${safePathPart(userId, "user")}/${safePathPart(projectId, "project")}/${normalizeMediaType(mediaType, parsed.mimeType)}/${safePathPart(taskId, "task")}.${extensionForMime(parsed.mimeType)}`;
  await getClient().putObject(bucket, objectName, parsed.buffer, parsed.buffer.length, { "Content-Type": parsed.mimeType });
  return {
    url: publicUrlForObject(objectName),
    mimeType: parsed.mimeType,
    size: parsed.buffer.length,
    storage: "minio",
    objectName,
    bucket,
  };
}

export async function getStoredObject(objectName) {
  if (!isObjectStorageEnabled()) {
    throw new Error("Object storage is not configured.");
  }
  const activeClient = getClient();
  const stat = await activeClient.statObject(bucket, objectName);
  const stream = await activeClient.getObject(bucket, objectName);
  return { bucket, objectName, stat, stream };
}
