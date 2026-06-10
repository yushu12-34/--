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

function sanitizePublicParamConfig(key, config) {
  if (Array.isArray(config)) return config;
  if (!config || typeof config !== "object") return config;

  const result = {};
  if (config.label !== undefined) result.label = String(config.label || key);
  if (config.type === "string" || config.type === "number" || config.type === "boolean") result.type = config.type;
  if (config.control === "select" || config.control === "input" || config.control === "checkbox") result.control = config.control;
  if (Array.isArray(config.options)) result.options = config.options;
  if (Array.isArray(config.values)) result.options = config.values;
  if (config.defaultValue !== undefined) result.defaultValue = config.defaultValue;
  if (config.required === true) result.required = true;
  return result;
}

function sanitizePublicParamSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([, config]) => {
        if (!config || typeof config !== "object" || Array.isArray(config)) return true;
        return config.publicVisible !== false;
      })
      .map(([key, config]) => [key, sanitizePublicParamConfig(key, config)]),
  );
}

export function publicModel(model) {
  const publicParamSchema = sanitizePublicParamSchema(model.publicParamSchema || model.paramSchema || {});
  const rawDefaultPublicParams = model.defaultPublicParams || model.defaultParams || {};
  const publicParamKeys = Object.keys(publicParamSchema);
  const defaultPublicParams = publicParamKeys.length > 0
    ? Object.fromEntries(
      publicParamKeys
        .filter((key) => Object.prototype.hasOwnProperty.call(rawDefaultPublicParams, key))
        .map((key) => [key, rawDefaultPublicParams[key]]),
    )
    : rawDefaultPublicParams;

  return {
    id: model.id,
    displayName: String(model.displayName || model.name || model.id),
    type: model.type || "image",
    capabilities: Array.isArray(model.capabilities) ? model.capabilities : [],
    publicParamSchema,
    defaultPublicParams,
    enabled: model.enabled !== false,
  };
}

export function isInternalAdminRequest(req) {
  const expectedToken = process.env.INTERNAL_ADMIN_TOKEN;
  const authorization = String(req.headers.authorization || "");
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const headerToken = String(req.headers["x-internal-admin-token"] || "");
  if (expectedToken) return bearerToken === expectedToken || headerToken === expectedToken;

  const remoteAddress = String(req.socket?.remoteAddress || "");
  const normalizedAddress = remoteAddress.replace(/^::ffff:/, "");
  return normalizedAddress === "127.0.0.1" || normalizedAddress === "::1" || normalizedAddress === "localhost";
}
