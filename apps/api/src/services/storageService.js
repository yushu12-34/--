import { Buffer } from "node:buffer";
import { Client } from "minio";

const endpoint = process.env.MINIO_ENDPOINT || "";
const port = Number(process.env.MINIO_PORT || 9000);
const useSSL = process.env.MINIO_USE_SSL === "true";
const accessKey = process.env.MINIO_ACCESS_KEY || "minioadmin";
const secretKey = process.env.MINIO_SECRET_KEY || "minioadmin";
const bucket = process.env.MINIO_BUCKET || "anime-canvas-assets";
const publicBaseUrl = process.env.MINIO_PUBLIC_URL || "";

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
  if (publicBaseUrl) return `${publicBaseUrl.replace(/\/+$/, "")}/${objectName}`;
  return `${useSSL ? "https" : "http"}://${endpoint}:${port}/${bucket}/${objectName}`;
}

export async function storeGeneratedAsset({ projectId, taskId, mediaType, sourceUrl }) {
  if (!isObjectStorageEnabled()) {
    return {
      url: sourceUrl,
      mimeType: sourceUrl.startsWith("data:image/png") ? "image/png" : "image/svg+xml",
      size: sourceUrl.length,
      storage: "inline",
    };
  }

  const parsed = parseDataUrl(sourceUrl);
  if (!parsed) {
    return {
      url: sourceUrl,
      mimeType: "application/octet-stream",
      size: 0,
      storage: "remote-url",
    };
  }

  await ensureBucket();
  const objectName = `${projectId}/${mediaType}/${taskId}.${extensionForMime(parsed.mimeType)}`;
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
