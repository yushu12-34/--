import crypto from "node:crypto";

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function now() {
  return new Date().toISOString();
}

export async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function send(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  });
  res.end(JSON.stringify(payload));
}

export function notFound(res) {
  send(res, 404, { error: "Not Found" });
}

export function badRequest(res, message) {
  send(res, 400, { error: message });
}

export function publicProvider(provider) {
  const { secretValue, encryptedSecret, ...safeProvider } = provider;
  return {
    ...safeProvider,
    hasSecret: Boolean(secretValue || encryptedSecret),
  };
}
