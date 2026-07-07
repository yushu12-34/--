import { resolveStoredAssetUrl } from "./storageService.js";

export const REQUIRED_TABLES = [
  "users",
  "user_devices",
  "projects",
  "project_members",
  "canvas_members",
  "canvases",
  "assets",
  "tasks",
  "providers",
  "models",
  "system_events",
  "yjs_updates",
  "yjs_snapshots",
  "auth_tokens",
  "canvas_invites",
];

const TASK_META_KEY = "__animeCanvasTaskMeta";
const YJS_PAYLOAD_KEY = "__animeCanvasYjsPayload";

let pool;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function toIso(value, fallback) {
  const candidate = value || fallback;
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizePgLevel(level) {
  if (level === "warning") return "warn";
  return level;
}

function jsonb(value, fallback = {}) {
  return JSON.stringify(value === undefined || value === null ? fallback : value);
}

function stripKeys(source, keys) {
  const copy = { ...asObject(source) };
  for (const key of keys) delete copy[key];
  return copy;
}

function decodeJsonBuffer(buffer) {
  if (!buffer) return null;
  try {
    return JSON.parse(Buffer.from(buffer).toString("utf8"));
  } catch {
    return null;
  }
}

function projectOwnerMap(projects = []) {
  return new Map(asArray(projects).map((project) => [project.id, project.ownerId || project.ownerUserId || "default-user"]));
}

function addSyntheticUser(users, seenUserIds, userId, timestamp) {
  const id = String(userId || "").trim();
  if (!id || seenUserIds.has(id)) return;
  users.push({
    id,
    name: id,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  seenUserIds.add(id);
}

export function encodeYjsPayload(record = {}) {
  const update = typeof record.update === "string"
    ? record.update
    : Buffer.from(record.update || []).toString("base64");
  return Buffer.from(JSON.stringify(compactObject({
    [YJS_PAYLOAD_KEY]: 1,
    update,
    clock: record.clock === undefined ? undefined : toNumber(record.clock),
    updateCount: record.updateCount === undefined ? undefined : toNumber(record.updateCount),
  })), "utf8");
}

export function decodeYjsPayload(buffer, fallback = {}) {
  const parsed = decodeJsonBuffer(buffer);
  if (parsed?.[YJS_PAYLOAD_KEY] === 1) {
    return compactObject({
      update: typeof parsed.update === "string" ? parsed.update : "",
      clock: parsed.clock === undefined ? fallback.clock : toNumber(parsed.clock, fallback.clock),
      updateCount: parsed.updateCount === undefined ? fallback.updateCount : toNumber(parsed.updateCount, fallback.updateCount),
    });
  }
  return compactObject({
    update: buffer ? Buffer.from(buffer).toString("base64") : "",
    clock: fallback.clock,
    updateCount: fallback.updateCount,
  });
}

export function rowToUser(row = {}) {
  return compactObject({
    id: String(row.id),
    name: row.display_name || row.id,
    email: row.email || undefined,
    hasPassword: row.password_hash === undefined ? undefined : Boolean(row.password_hash),
    fingerprintHash: row.fingerprint_hash || undefined,
    fingerprintVersion: row.fingerprint_version === undefined ? undefined : toNumber(row.fingerprint_version, 1),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastSeenAt: row.last_seen_at ? toIso(row.last_seen_at) : undefined,
  });
}

export function userToRow(user = {}, timestamp) {
  return {
    id: String(user.id),
    displayName: String(user.displayName || user.name || user.id),
    email: user.email ? String(user.email).toLowerCase() : null,
    passwordHash: user.passwordHash || user.password_hash || null,
    fingerprintHash: user.fingerprintHash || user.fingerprint_hash || null,
    fingerprintVersion: toNumber(user.fingerprintVersion || user.fingerprint_version, 1),
    createdAt: toIso(user.createdAt || user.created_at, timestamp),
    updatedAt: toIso(user.updatedAt || user.updated_at, timestamp),
    lastSeenAt: user.lastSeenAt || user.last_seen_at ? toIso(user.lastSeenAt || user.last_seen_at, timestamp) : null,
  };
}

export function rowToUserDevice(row = {}) {
  return compactObject({
    id: String(row.id),
    userId: row.user_id,
    fingerprintHash: row.fingerprint_hash,
    userAgentHash: row.user_agent_hash || undefined,
    ipPrefixHash: row.ip_prefix_hash || undefined,
    createdAt: toIso(row.created_at),
    lastSeenAt: toIso(row.last_seen_at || row.created_at),
  });
}

export function userDeviceToRow(device = {}, timestamp) {
  return {
    id: String(device.id),
    userId: String(device.userId || device.user_id),
    fingerprintHash: String(device.fingerprintHash || device.fingerprint_hash),
    userAgentHash: device.userAgentHash || device.user_agent_hash || null,
    ipPrefixHash: device.ipPrefixHash || device.ip_prefix_hash || null,
    createdAt: toIso(device.createdAt || device.created_at, timestamp),
    lastSeenAt: toIso(device.lastSeenAt || device.last_seen_at || device.createdAt || device.created_at, timestamp),
  };
}

export function rowToProject(row = {}) {
  return compactObject({
    id: String(row.id),
    name: row.name || "Untitled Project",
    ownerId: row.owner_user_id || "default-user",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export function projectToRow(project = {}, timestamp) {
  return {
    id: String(project.id),
    ownerUserId: String(project.ownerId || project.ownerUserId || "default-user"),
    name: String(project.name || "Untitled Project"),
    createdAt: toIso(project.createdAt || project.created_at, timestamp),
    updatedAt: toIso(project.updatedAt || project.updated_at || project.createdAt || project.created_at, timestamp),
  };
}

export function rowToProjectMember(row = {}) {
  return compactObject({
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role || "viewer",
    createdAt: toIso(row.created_at),
  });
}

export function projectMemberToRow(member = {}, timestamp) {
  return {
    projectId: String(member.projectId || member.project_id),
    userId: String(member.userId || member.user_id),
    role: ["owner", "editor", "viewer"].includes(member.role) ? member.role : "viewer",
    createdAt: toIso(member.createdAt || member.created_at, timestamp),
  };
}

export function rowToCanvasMember(row = {}) {
  return compactObject({
    canvasId: row.canvas_id,
    userId: row.user_id,
    role: row.role || "viewer",
    addedAt: toIso(row.added_at || row.created_at),
  });
}

export function canvasMemberToRow(member = {}, timestamp) {
  return {
    canvasId: String(member.canvasId || member.canvas_id),
    userId: String(member.userId || member.user_id),
    role: ["owner", "editor", "viewer"].includes(member.role) ? member.role : "viewer",
    addedAt: toIso(member.addedAt || member.added_at || member.createdAt || member.created_at, timestamp),
  };
}

function rewriteSnapshotStorageUrls(snapshot = {}) {
  const next = cloneJson(snapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  const rewriteData = (data) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    for (const key of ["url", "resultUrl", "thumbnailUrl"]) {
      if (typeof data[key] === "string") data[key] = resolveStoredAssetUrl(data[key]);
    }
    for (const key of ["inputImages", "images", "referenceImages"]) {
      if (Array.isArray(data[key])) {
        data[key] = data[key].map((item) => (typeof item === "string" ? resolveStoredAssetUrl(item) : item));
      }
    }
  };
  if (Array.isArray(next.nodes)) {
    for (const node of next.nodes) rewriteData(node?.data);
  }
  return next;
}

export function rowToCanvas(row = {}) {
  return compactObject({
    id: String(row.id),
    projectId: row.project_id,
    ownerId: row.owner_user_id || undefined,
    name: row.name || "Canvas",
    snapshot: rewriteSnapshotStorageUrls(row.snapshot),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export function canvasToRow(canvas = {}, projectOwners = new Map(), timestamp) {
  return {
    id: String(canvas.id),
    projectId: String(canvas.projectId || canvas.project_id),
    ownerUserId: String(canvas.ownerId || canvas.ownerUserId || projectOwners.get(canvas.projectId || canvas.project_id) || "default-user"),
    name: String(canvas.name || "Canvas"),
    snapshot: canvas.snapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    createdAt: toIso(canvas.createdAt || canvas.created_at, timestamp),
    updatedAt: toIso(canvas.updatedAt || canvas.updated_at || canvas.createdAt || canvas.created_at, timestamp),
  };
}

export function rowToAsset(row = {}) {
  const metadata = asObject(row.metadata);
  const title = row.title && row.title !== row.id ? row.title : undefined;
  const objectName = metadata.objectName || metadata.object_name;
  const objectUrl = resolveStoredAssetUrl(row.url, objectName);
  return compactObject({
    ...metadata,
    id: String(row.id),
    projectId: row.project_id,
    type: row.type,
    url: objectUrl || row.url,
    thumbnailUrl: objectUrl || metadata.thumbnailUrl,
    name: metadata.name ?? title,
    createdBy: metadata.createdBy || row.owner_user_id || undefined,
    createdAt: toIso(row.created_at),
    updatedAt: row.updated_at ? toIso(row.updated_at) : undefined,
  });
}

export function assetToRow(asset = {}, projectOwners = new Map(), timestamp) {
  const metadata = stripKeys(asset, ["id", "projectId", "project_id", "type", "url", "createdAt", "created_at", "updatedAt", "updated_at"]);
  const projectId = String(asset.projectId || asset.project_id);
  return {
    id: String(asset.id),
    projectId,
    ownerUserId: String(asset.ownerId || asset.ownerUserId || asset.createdBy || projectOwners.get(projectId) || "default-user"),
    type: String(asset.type || "image"),
    title: String(asset.name || asset.title || asset.id),
    url: String(asset.url || ""),
    metadata,
    createdAt: toIso(asset.createdAt || asset.created_at, timestamp),
    updatedAt: toIso(asset.updatedAt || asset.updated_at || asset.createdAt || asset.created_at, timestamp),
  };
}

export function rowToTask(row = {}) {
  const input = cloneJson(row.input || {});
  const meta = asObject(input[TASK_META_KEY]);
  const output = row.output ? cloneJson(row.output) : undefined;
  if (output?.objectName || output?.url) output.url = resolveStoredAssetUrl(output.url, output.objectName);
  delete input[TASK_META_KEY];
  return compactObject({
    ...meta,
    id: String(row.id),
    projectId: row.project_id || undefined,
    canvasId: row.canvas_id || undefined,
    nodeId: row.node_id || undefined,
    userId: row.user_id || meta.userId || undefined,
    modelId: row.model_id || undefined,
    type: row.type,
    status: row.status,
    progress: toNumber(row.progress, 0),
    input,
    output,
    error: row.error || undefined,
    createdBy: meta.createdBy || row.user_id || undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

export function taskToRow(task = {}, validRefs = {}, timestamp) {
  const meta = stripKeys(task, [
    "id",
    "projectId",
    "project_id",
    "canvasId",
    "canvas_id",
    "nodeId",
    "node_id",
    "userId",
    "user_id",
    "type",
    "modelId",
    "model_id",
    "status",
    "progress",
    "input",
    "output",
    "error",
    "createdAt",
    "created_at",
    "updatedAt",
    "updated_at",
  ]);
  const input = cloneJson(task.input || {});
  if (Object.keys(meta).length) input[TASK_META_KEY] = meta;
  const projectId = task.projectId || task.project_id;
  const canvasId = task.canvasId || task.canvas_id;
  return {
    id: String(task.id),
    projectId: validRefs.projectIds?.has(projectId) ? String(projectId) : null,
    canvasId: validRefs.canvasIds?.has(canvasId) ? String(canvasId) : null,
    nodeId: task.nodeId || task.node_id || null,
    userId: task.userId || task.user_id || task.createdBy || null,
    type: String(task.type || "image.generate"),
    modelId: task.modelId || task.model_id || null,
    status: String(task.status || "pending"),
    progress: toNumber(task.progress, 0),
    input,
    output: task.output || null,
    error: task.error || null,
    createdAt: toIso(task.createdAt || task.created_at, timestamp),
    updatedAt: toIso(task.updatedAt || task.updated_at || task.createdAt || task.created_at, timestamp),
  };
}

export function rowToProvider(row = {}) {
  const body = asObject(row.body);
  return compactObject({
    ...body,
    id: body.id || row.id,
    createdAt: body.createdAt || toIso(row.created_at),
    updatedAt: body.updatedAt || toIso(row.updated_at),
  });
}

export function providerToRow(provider = {}, timestamp) {
  return {
    id: String(provider.id),
    body: provider,
    createdAt: toIso(provider.createdAt || provider.created_at, timestamp),
    updatedAt: toIso(provider.updatedAt || provider.updated_at || provider.createdAt || provider.created_at, timestamp),
  };
}

export function rowToModel(row = {}) {
  const body = asObject(row.body);
  return compactObject({
    ...body,
    id: body.id || row.id,
    providerId: body.providerId || row.provider_id || undefined,
    createdAt: body.createdAt || toIso(row.created_at),
    updatedAt: body.updatedAt || toIso(row.updated_at),
  });
}

export function modelToRow(model = {}, providerIds = new Set(), timestamp) {
  return {
    id: String(model.id),
    providerId: providerIds.has(model.providerId) ? model.providerId : null,
    body: model,
    createdAt: toIso(model.createdAt || model.created_at, timestamp),
    updatedAt: toIso(model.updatedAt || model.updated_at || model.createdAt || model.created_at, timestamp),
  };
}

export function rowToSystemEvent(row = {}) {
  return compactObject({
    id: String(row.id),
    userId: row.user_id || undefined,
    level: row.level,
    category: row.category,
    source: row.source,
    message: row.message,
    metadata: row.metadata || {},
    createdAt: toIso(row.created_at),
  });
}

export function systemEventToRow(event = {}, timestamp) {
  return {
    id: String(event.id),
    userId: event.userId || event.user_id || null,
    level: normalizePgLevel(String(event.level || "info")),
    category: String(event.category || "system"),
    source: String(event.source || "api"),
    message: String(event.message || ""),
    metadata: event.metadata || {},
    createdAt: toIso(event.createdAt || event.created_at, timestamp),
  };
}

export function rowToWorkflowUpdate(row = {}, fallbackClock = 0) {
  const payload = decodeYjsPayload(row.update_data, { clock: fallbackClock });
  return compactObject({
    id: String(row.id),
    canvasId: row.canvas_id,
    userId: row.user_id || undefined,
    clock: toNumber(payload.clock, fallbackClock),
    update: payload.update || "",
    createdAt: toIso(row.created_at),
  });
}

export function workflowUpdateToRow(record = {}, validCanvasIds = new Set(), timestamp) {
  return {
    id: String(record.id),
    canvasId: validCanvasIds.has(record.canvasId || record.canvas_id) ? String(record.canvasId || record.canvas_id) : null,
    userId: record.userId || record.user_id || null,
    updateData: encodeYjsPayload(record),
    createdAt: toIso(record.createdAt || record.created_at, timestamp),
  };
}

export function rowToWorkflowSnapshot(row = {}, fallbackClock = 0) {
  const snapshot = asObject(row.snapshot);
  const payload = decodeYjsPayload(row.update_data, {
    clock: snapshot.clock ?? fallbackClock,
    updateCount: snapshot.updateCount,
  });
  return compactObject({
    id: String(row.id),
    canvasId: row.canvas_id,
    clock: toNumber(payload.clock, fallbackClock),
    update: payload.update || "",
    updateCount: payload.updateCount === undefined ? undefined : toNumber(payload.updateCount),
    createdAt: toIso(row.created_at),
  });
}

export function workflowSnapshotToRow(record = {}, validCanvasIds = new Set(), timestamp) {
  return {
    id: String(record.id),
    canvasId: validCanvasIds.has(record.canvasId || record.canvas_id) ? String(record.canvasId || record.canvas_id) : null,
    snapshot: compactObject({
      clock: record.clock === undefined ? undefined : toNumber(record.clock),
      updateCount: record.updateCount === undefined ? undefined : toNumber(record.updateCount),
    }),
    updateData: record.update ? encodeYjsPayload(record) : null,
    createdAt: toIso(record.createdAt || record.created_at, timestamp),
  };
}

function decodeWorkflowUpdateRows(rows = [], initialClock = 0) {
  const records = [];
  let currentClock = toNumber(initialClock, 0);
  for (const row of rows) {
    const fallbackClock = currentClock + 1;
    const record = rowToWorkflowUpdate(row, fallbackClock);
    currentClock = Math.max(currentClock, toNumber(record.clock, fallbackClock));
    records.push(record);
  }
  return records;
}

function decodeWorkflowSnapshotRows(rows = []) {
  const records = [];
  let currentClock = 0;
  for (const row of rows) {
    const fallbackClock = currentClock + 1;
    const record = rowToWorkflowSnapshot(row, fallbackClock);
    currentClock = Math.max(currentClock, toNumber(record.clock, fallbackClock));
    records.push(record);
  }
  return records;
}

async function getCanvasYjsPersistenceRows(client, canvasId) {
  const snapshotResult = await client.query(
    "select * from yjs_snapshots where canvas_id = $1 order by created_at desc, id desc limit 1",
    [canvasId],
  );
  const snapshot = decodeWorkflowSnapshotRows([...snapshotResult.rows].reverse()).at(-1) || null;
  const sinceClock = toNumber(snapshot?.clock, 0);
  const updatesResult = await client.query(
    "select * from yjs_updates where canvas_id = $1 order by created_at asc, id asc",
    [canvasId],
  );
  const updates = decodeWorkflowUpdateRows(updatesResult.rows, sinceClock)
    .filter((record) => toNumber(record.clock, 0) > sinceClock);
  return { snapshot, updates };
}

function rowToAuthUser(row = {}) {
  return compactObject({
    ...rowToUser(row),
    passwordHash: row.password_hash || undefined,
  });
}

export async function getAuthUserByLogin(login) {
  const normalized = String(login || "").trim().toLowerCase();
  if (!normalized) return null;
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(
      `select id, display_name, email, password_hash, fingerprint_hash, fingerprint_version, created_at, updated_at, last_seen_at
       from users
       where lower(coalesce(email, '')) = $1 or id = $2
       limit 1`,
      [normalized, String(login || "").trim()],
    );
    if (result.rowCount === 0) return null;
    return rowToAuthUser(result.rows[0]);
  } finally {
    client.release();
  }
}

export async function getAuthUserByTokenHash(tokenHash) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(
      `select u.id, u.display_name, u.email, u.fingerprint_hash, u.fingerprint_version, u.created_at, u.updated_at, u.last_seen_at
       from auth_tokens t
       join users u on u.id = t.user_id
       where t.token_hash = $1 and t.expires_at > now()
       limit 1`,
      [tokenHash],
    );
    if (result.rowCount === 0) return null;
    await client.query("update auth_tokens set last_used_at = now() where token_hash = $1", [tokenHash]);
    return rowToUser(result.rows[0]);
  } finally {
    client.release();
  }
}

export async function createAuthTokenRecord(tokenHash, userId, expiresAt, createdAt) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    await client.query(
      "insert into auth_tokens (token_hash, user_id, created_at, expires_at, last_used_at) values ($1, $2, $3, $4, $3)",
      [tokenHash, userId, createdAt, expiresAt],
    );
  } finally {
    client.release();
  }
}

export async function revokeAuthTokenRecord(tokenHash) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    await client.query("delete from auth_tokens where token_hash = $1", [tokenHash]);
  } finally {
    client.release();
  }
}

export async function getCanvasAccessView(canvasId, userId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(
      `select c.id, c.project_id, c.owner_user_id, c.created_at,
        case
          when c.owner_user_id = $2 then 'owner'
          when cm.role is not null then cm.role
          else null
        end as role
       from canvases c
       left join canvas_members cm on cm.canvas_id = c.id and cm.user_id = $2
       where c.id = $1
       limit 1`,
      [canvasId, userId || ""],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    if (!row.role) return { exists: true, allowed: false };
    return {
      exists: true,
      allowed: true,
      role: row.role,
      canvasId: row.id,
      projectId: row.project_id,
      ownerId: row.owner_user_id,
    };
  } finally {
    client.release();
  }
}

export async function getProjectAccessView(projectId, userId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(
      `select p.id,
        case
          when p.owner_user_id = $2 then 'owner'
          when pm.role is not null then pm.role
          else null
        end as role
       from projects p
       left join project_members pm on pm.project_id = p.id and pm.user_id = $2
       where p.id = $1
       limit 1`,
      [projectId, userId || ""],
    );
    if (result.rowCount === 0) return null;
    const role = result.rows[0].role;
    return { exists: true, allowed: Boolean(role), role };
  } finally {
    client.release();
  }
}

export async function createCanvasInviteRecord(invite) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(
      `insert into canvas_invites (id, canvas_id, owner_user_id, code, role, max_uses, used_count, expires_at, created_at)
       values ($1, $2, $3, $4, $5, $6, 0, $7, $8)
       returning id, canvas_id, owner_user_id, code, role, max_uses, used_count, expires_at, revoked_at, created_at`,
      [invite.id, invite.canvasId, invite.ownerId, invite.code, invite.role, invite.maxUses ?? null, invite.expiresAt || null, invite.createdAt],
    );
    return rowToCanvasInvite(result.rows[0]);
  } finally {
    client.release();
  }
}

export function rowToCanvasInvite(row = {}) {
  return compactObject({
    id: String(row.id),
    canvasId: row.canvas_id,
    ownerId: row.owner_user_id,
    code: row.code,
    role: row.role || "editor",
    maxUses: row.max_uses === null || row.max_uses === undefined ? undefined : toNumber(row.max_uses),
    usedCount: toNumber(row.used_count, 0),
    expiresAt: row.expires_at ? toIso(row.expires_at) : undefined,
    revokedAt: row.revoked_at ? toIso(row.revoked_at) : undefined,
    createdAt: toIso(row.created_at),
  });
}

export async function acceptCanvasInviteRecord(code, userId, acceptedAt) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    await client.query("begin");
    try {
      const inviteResult = await client.query(
        `select id, canvas_id, owner_user_id, code, role, max_uses, used_count, expires_at, revoked_at, created_at
         from canvas_invites
         where code = $1
         for update`,
        [code],
      );
      if (inviteResult.rowCount === 0) {
        await client.query("rollback");
        return null;
      }
      const invite = rowToCanvasInvite(inviteResult.rows[0]);
      const access = await client.query("select owner_user_id from canvases where id = $1", [invite.canvasId]);
      if (access.rowCount === 0) {
        await client.query("rollback");
        return { invite, error: "canvas_not_found" };
      }
      if (access.rows[0].owner_user_id === userId) {
        await client.query("commit");
        return { invite, member: { canvasId: invite.canvasId, userId, role: "owner", addedAt: acceptedAt } };
      }
      const existingMember = await client.query(
        "select canvas_id, user_id, role, added_at from canvas_members where canvas_id = $1 and user_id = $2",
        [invite.canvasId, userId],
      );
      if (existingMember.rowCount > 0) {
        await client.query("commit");
        return { invite, member: rowToCanvasMember(existingMember.rows[0]) };
      }
      const expired = invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now();
      const overUsed = invite.maxUses !== undefined && invite.usedCount >= invite.maxUses;
      if (invite.revokedAt || expired || overUsed) {
        await client.query("rollback");
        return { invite, error: expired ? "expired" : overUsed ? "used_up" : "revoked" };
      }
      const memberResult = await client.query(
        `insert into canvas_members (canvas_id, user_id, role, added_at)
         values ($1, $2, $3, $4)
         on conflict (canvas_id, user_id) do update set role = excluded.role, added_at = excluded.added_at
         returning canvas_id, user_id, role, added_at`,
        [invite.canvasId, userId, invite.role, acceptedAt],
      );
      await client.query("update canvas_invites set used_count = used_count + 1 where id = $1", [invite.id]);
      await client.query("commit");
      return { invite, member: rowToCanvasMember(memberResult.rows[0]) };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

export function preparePostgresSnapshot(db = {}, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const next = {
    users: cloneJson(asArray(db.users)),
    userDevices: cloneJson(asArray(db.userDevices)),
    projectMembers: cloneJson(asArray(db.projectMembers)),
    canvasMembers: cloneJson(asArray(db.canvasMembers)),
    projects: cloneJson(asArray(db.projects)),
    canvases: cloneJson(asArray(db.canvases)),
    assets: cloneJson(asArray(db.assets)),
    tasks: cloneJson(asArray(db.tasks)),
    systemEvents: cloneJson(asArray(db.systemEvents)),
    workflowUpdates: cloneJson(asArray(db.workflowUpdates)),
    workflowSnapshots: cloneJson(asArray(db.workflowSnapshots)),
    providers: cloneJson(asArray(db.providers)),
    models: cloneJson(asArray(db.models)),
  };

  const seenUserIds = new Set(next.users.map((user) => user.id).filter(Boolean));
  addSyntheticUser(next.users, seenUserIds, "default-user", timestamp);

  for (const project of next.projects) {
    project.ownerId = String(project.ownerId || project.ownerUserId || "default-user");
    addSyntheticUser(next.users, seenUserIds, project.ownerId, timestamp);
  }

  const owners = projectOwnerMap(next.projects);
  for (const member of next.projectMembers) addSyntheticUser(next.users, seenUserIds, member.userId || member.user_id, timestamp);
  for (const member of next.canvasMembers) addSyntheticUser(next.users, seenUserIds, member.userId || member.user_id, timestamp);
  for (const device of next.userDevices) addSyntheticUser(next.users, seenUserIds, device.userId || device.user_id, timestamp);
  for (const asset of next.assets) addSyntheticUser(next.users, seenUserIds, asset.createdBy || asset.ownerId || owners.get(asset.projectId), timestamp);
  for (const task of next.tasks) addSyntheticUser(next.users, seenUserIds, task.userId || task.createdBy || owners.get(task.projectId), timestamp);
  for (const event of next.systemEvents) addSyntheticUser(next.users, seenUserIds, event.userId || event.user_id, timestamp);

  const membersByKey = new Map();
  for (const member of next.projectMembers) {
    const row = projectMemberToRow(member, timestamp);
    if (!row.projectId || !row.userId) continue;
    membersByKey.set(`${row.projectId}:${row.userId}`, row);
  }
  for (const project of next.projects) {
    const row = projectMemberToRow({
      projectId: project.id,
      userId: project.ownerId || "default-user",
      role: "owner",
      createdAt: project.createdAt || timestamp,
    }, timestamp);
    membersByKey.set(`${row.projectId}:${row.userId}`, row);
  }
  next.projectMembers = [...membersByKey.values()];

  return next;
}

export function preserveExistingUserAuthFields(users = [], existingUsers = []) {
  const existingById = new Map(asArray(existingUsers).filter((user) => user?.id).map((user) => [String(user.id), user]));
  return asArray(users).map((user) => {
    const existing = existingById.get(String(user?.id || ""));
    if (!existing) return user;
    return {
      ...user,
      email: user.email || user.email_address || existing.email || existing.email_address,
      passwordHash: user.passwordHash || user.password_hash || existing.passwordHash || existing.password_hash,
      fingerprintHash: user.fingerprintHash || user.fingerprint_hash || existing.fingerprintHash || existing.fingerprint_hash,
      fingerprintVersion: user.fingerprintVersion || user.fingerprint_version || existing.fingerprintVersion || existing.fingerprint_version,
    };
  });
}

async function loadPgPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATA_BACKEND=postgres requires DATABASE_URL");
  }
  let pg;
  try {
    pg = await import("pg");
  } catch (error) {
    throw new Error(`PostgreSQL driver is not installed. Run "npm --prefix apps/api install pg". ${error instanceof Error ? error.message : String(error)}`);
  }
  const ssl = process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
    : undefined;
  // 生产环境调优：
  // - max 连接数提升以支持并发（默认 10，生产建议 20-30）
  // - statement_timeout 防止慢查询阻塞连接池
  // - idle_in_transaction_session_timeout 防止事务泄漏耗尽连接
  // - query_timeout 应用层超时，避免请求无限等待
  // options 通过启动包设置会话参数，避免 connect 事件的竞态问题
  const statementTimeoutMs = Number(process.env.POSTGRES_STATEMENT_TIMEOUT_MS || 15000);
  const idleInTransactionTimeoutMs = Number(process.env.POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS || 10000);
  const queryTimeoutMs = Number(process.env.POSTGRES_QUERY_TIMEOUT_MS || 30000);
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.POSTGRES_POOL_MAX || 10),
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 5000),
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
    query_timeout: queryTimeoutMs,
    options: `-c statement_timeout=${statementTimeoutMs} -c idle_in_transaction_session_timeout=${idleInTransactionTimeoutMs}`,
    ssl,
  });
  pool.on("error", (error) => {
    console.warn(`PostgreSQL idle client error: ${error instanceof Error ? error.message : String(error)}`);
  });
  return pool;
}

export async function assertRequiredTables(client) {
  const result = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])",
    [REQUIRED_TABLES],
  );
  const found = new Set(result.rows.map((row) => row.table_name));
  // 自动创建 canvas_members 表（向后兼容旧 schema）
  if (!found.has("canvas_members")) {
    await client.query(
      "create table if not exists canvas_members (canvas_id text not null, user_id text not null, role text not null check (role in ('owner', 'editor', 'viewer')), added_at timestamptz not null default now(), primary key (canvas_id, user_id))",
    );
    await client.query("create index if not exists canvas_members_user_id_idx on canvas_members(user_id)");
    found.add("canvas_members");
  }
  await client.query("alter table users add column if not exists email text");
  await client.query("alter table users add column if not exists password_hash text");
  await client.query("create unique index if not exists users_email_lower_unique_idx on users(lower(email)) where email is not null and email <> ''");
  if (!found.has("auth_tokens")) {
    await client.query(
      "create table if not exists auth_tokens (token_hash text primary key, user_id text not null references users(id) on delete cascade, created_at timestamptz not null, expires_at timestamptz not null, last_used_at timestamptz)",
    );
    found.add("auth_tokens");
  }
  if (!found.has("canvas_invites")) {
    await client.query(
      "create table if not exists canvas_invites (id text primary key, canvas_id text not null references canvases(id) on delete cascade, owner_user_id text not null references users(id) on delete cascade, code text not null unique, role text not null check (role in ('editor', 'viewer')), max_uses integer, used_count integer not null default 0, expires_at timestamptz, revoked_at timestamptz, created_at timestamptz not null)",
    );
    found.add("canvas_invites");
  }
  const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
  if (missing.length) {
    throw new Error(`PostgreSQL schema is missing required tables: ${missing.join(", ")}`);
  }
  await client.query("create index if not exists yjs_updates_canvas_created_idx on yjs_updates(canvas_id, created_at, id)");
  await client.query("create index if not exists yjs_snapshots_canvas_created_idx on yjs_snapshots(canvas_id, created_at desc, id desc)");
  await client.query("create index if not exists canvases_project_updated_idx on canvases(project_id, updated_at desc)");
  await client.query("create index if not exists assets_project_created_idx on assets(project_id, created_at desc)");
  await client.query("create index if not exists tasks_canvas_updated_idx on tasks(canvas_id, updated_at desc)");
  await client.query("create index if not exists system_events_created_idx on system_events(created_at desc)");
  await client.query("create index if not exists project_members_user_project_idx on project_members(user_id, project_id)");
  await client.query("create index if not exists canvas_members_user_canvas_idx on canvas_members(user_id, canvas_id)");
  await client.query("create index if not exists auth_tokens_user_expires_idx on auth_tokens(user_id, expires_at)");
  await client.query("create index if not exists canvas_invites_canvas_idx on canvas_invites(canvas_id, created_at desc)");
}

export async function lockSnapshotWrite(client) {
  await client.query("select pg_advisory_xact_lock(hashtext('anime_canvas_snapshot_store'))");
}

export async function loadPostgresSnapshotParallel(pool) {
  // 使用连接池并行执行所有查询，避免串行网络延迟累积
  const [
    users, userDevices, projects, projectMembers, canvasMembers,
    canvases, assets, tasks, providers, models, systemEvents,
    yjsSnapshots, yjsUpdates,
  ] = await Promise.all([
    pool.query("select * from users order by created_at asc, id asc"),
    pool.query("select * from user_devices order by created_at asc, id asc"),
    pool.query("select * from projects order by created_at asc, id asc"),
    pool.query("select * from project_members order by created_at asc, project_id asc, user_id asc"),
    pool.query("select * from canvas_members order by added_at asc, canvas_id asc, user_id asc"),
    pool.query("select * from canvases order by created_at asc, id asc"),
    pool.query("select * from assets order by created_at desc, id asc"),
    pool.query("select * from tasks order by created_at desc, id asc"),
    pool.query("select * from providers order by created_at asc, id asc"),
    pool.query("select * from models order by created_at asc, id asc"),
    pool.query("select * from system_events order by created_at desc, id asc"),
    pool.query("select * from yjs_snapshots order by canvas_id asc, created_at asc, id asc"),
    pool.query("select * from yjs_updates order by canvas_id asc, created_at asc, id asc"),
  ]);
  return buildSnapshotFromRows({ users, userDevices, projects, projectMembers, canvasMembers, canvases, assets, tasks, providers, models, systemEvents, yjsSnapshots, yjsUpdates });
}

function buildSnapshotFromRows(results) {
  const { users, userDevices, projects, projectMembers, canvasMembers, canvases, assets, tasks, providers, models, systemEvents, yjsSnapshots, yjsUpdates } = results;
  const snapshotClockByCanvas = new Map();
  const workflowSnapshots = yjsSnapshots.rows.map((row, index) => {
    const fallbackClock = toNumber(snapshotClockByCanvas.get(row.canvas_id), index) + 1;
    const record = rowToWorkflowSnapshot(row, fallbackClock);
    snapshotClockByCanvas.set(row.canvas_id, Math.max(toNumber(snapshotClockByCanvas.get(row.canvas_id), 0), toNumber(record.clock, fallbackClock)));
    return record;
  });

  const updateClockByCanvas = new Map(snapshotClockByCanvas);
  const workflowUpdates = yjsUpdates.rows.map((row, index) => {
    const fallbackClock = toNumber(updateClockByCanvas.get(row.canvas_id), index) + 1;
    const record = rowToWorkflowUpdate(row, fallbackClock);
    updateClockByCanvas.set(row.canvas_id, Math.max(fallbackClock, toNumber(record.clock, fallbackClock)));
    return record;
  });

  return {
    users: users.rows.map(rowToUser),
    userDevices: userDevices.rows.map(rowToUserDevice),
    projects: projects.rows.map(rowToProject),
    projectMembers: projectMembers.rows.map(rowToProjectMember),
    canvasMembers: canvasMembers.rows.map(rowToCanvasMember),
    canvases: canvases.rows.map(rowToCanvas),
    assets: assets.rows.map(rowToAsset),
    tasks: tasks.rows.map(rowToTask),
    providers: providers.rows.map(rowToProvider),
    models: models.rows.map(rowToModel),
    systemEvents: systemEvents.rows.map(rowToSystemEvent),
    workflowUpdates,
    workflowSnapshots,
  };
}

export async function loadPostgresSnapshot(client) {
  // 串行执行查询（用于事务中，pg client 不支持同一 client 并行查询）
  const users = await client.query("select * from users order by created_at asc, id asc");
  const userDevices = await client.query("select * from user_devices order by created_at asc, id asc");
  const projects = await client.query("select * from projects order by created_at asc, id asc");
  const projectMembers = await client.query("select * from project_members order by created_at asc, project_id asc, user_id asc");
  const canvasMembers = await client.query("select * from canvas_members order by added_at asc, canvas_id asc, user_id asc");
  const canvases = await client.query("select * from canvases order by created_at asc, id asc");
  const assets = await client.query("select * from assets order by created_at desc, id asc");
  const tasks = await client.query("select * from tasks order by created_at desc, id asc");
  const providers = await client.query("select * from providers order by created_at asc, id asc");
  const models = await client.query("select * from models order by created_at asc, id asc");
  const systemEvents = await client.query("select * from system_events order by created_at desc, id asc");
  const yjsSnapshots = await client.query("select * from yjs_snapshots order by canvas_id asc, created_at asc, id asc");
  const yjsUpdates = await client.query("select * from yjs_updates order by canvas_id asc, created_at asc, id asc");
  return buildSnapshotFromRows({ users, userDevices, projects, projectMembers, canvasMembers, canvases, assets, tasks, providers, models, systemEvents, yjsSnapshots, yjsUpdates });
}

async function clearTables(client) {
  await client.query("delete from yjs_updates");
  await client.query("delete from yjs_snapshots");
  await client.query("delete from system_events");
  await client.query("delete from tasks");
  await client.query("delete from assets");
  await client.query("delete from canvas_members");
  await client.query("delete from canvases");
  await client.query("delete from project_members");
  await client.query("delete from projects");
  await client.query("delete from models");
  await client.query("delete from providers");
  await client.query("delete from user_devices");
  await client.query("delete from users");
}

export async function replacePostgresSnapshot(client, db = {}) {
  const timestamp = new Date().toISOString();
  const snapshot = preparePostgresSnapshot(db, { timestamp });
  const existingUsersResult = await client.query(
    "select id, email, password_hash, fingerprint_hash, fingerprint_version from users",
  ).catch(() => ({ rows: [] }));
  snapshot.users = preserveExistingUserAuthFields(snapshot.users, existingUsersResult.rows.map((row) => ({
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    fingerprintHash: row.fingerprint_hash,
    fingerprintVersion: row.fingerprint_version,
  })));
  const projectOwners = projectOwnerMap(snapshot.projects);
  const userIds = new Set(snapshot.users.map((user) => user.id));
  const projectIds = new Set(snapshot.projects.map((project) => project.id));
  const canvasIds = new Set(snapshot.canvases.map((canvas) => canvas.id).filter((canvasId) => projectIds.has(snapshot.canvases.find((canvas) => canvas.id === canvasId)?.projectId)));
  const providerIds = new Set(snapshot.providers.map((provider) => provider.id));
  const validRefs = { projectIds, canvasIds };

  await clearTables(client);

  for (const user of snapshot.users) {
    if (!user?.id) continue;
    const row = userToRow(user, timestamp);
    await client.query(
      "insert into users (id, display_name, email, password_hash, fingerprint_hash, fingerprint_version, created_at, updated_at, last_seen_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [row.id, row.displayName, row.email, row.passwordHash, row.fingerprintHash, row.fingerprintVersion, row.createdAt, row.updatedAt, row.lastSeenAt],
    );
  }

  for (const device of snapshot.userDevices) {
    if (!device?.id) continue;
    const row = userDeviceToRow(device, timestamp);
    if (!userIds.has(row.userId) || !row.fingerprintHash) continue;
    await client.query(
      "insert into user_devices (id, user_id, fingerprint_hash, user_agent_hash, ip_prefix_hash, created_at, last_seen_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [row.id, row.userId, row.fingerprintHash, row.userAgentHash, row.ipPrefixHash, row.createdAt, row.lastSeenAt],
    );
  }

  for (const provider of snapshot.providers) {
    if (!provider?.id) continue;
    const row = providerToRow(provider, timestamp);
    await client.query(
      "insert into providers (id, body, created_at, updated_at) values ($1, $2::jsonb, $3, $4)",
      [row.id, jsonb(row.body), row.createdAt, row.updatedAt],
    );
  }

  for (const model of snapshot.models) {
    if (!model?.id) continue;
    const row = modelToRow(model, providerIds, timestamp);
    await client.query(
      "insert into models (id, provider_id, body, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $5)",
      [row.id, row.providerId, jsonb(row.body), row.createdAt, row.updatedAt],
    );
  }

  for (const project of snapshot.projects) {
    if (!project?.id) continue;
    const row = projectToRow(project, timestamp);
    if (!userIds.has(row.ownerUserId)) continue;
    await client.query(
      "insert into projects (id, owner_user_id, name, created_at, updated_at) values ($1, $2, $3, $4, $5)",
      [row.id, row.ownerUserId, row.name, row.createdAt, row.updatedAt],
    );
  }

  for (const member of snapshot.projectMembers) {
    const row = projectMemberToRow(member, timestamp);
    if (!projectIds.has(row.projectId) || !userIds.has(row.userId)) continue;
    await client.query(
      "insert into project_members (project_id, user_id, role, created_at) values ($1, $2, $3, $4) on conflict (project_id, user_id) do update set role = excluded.role",
      [row.projectId, row.userId, row.role, row.createdAt],
    );
  }

  for (const canvas of snapshot.canvases) {
    if (!canvas?.id || !projectIds.has(canvas.projectId)) continue;
    const row = canvasToRow(canvas, projectOwners, timestamp);
    await client.query(
      "insert into canvases (id, project_id, owner_user_id, name, snapshot, created_at, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7)",
      [row.id, row.projectId, row.ownerUserId, row.name, jsonb(row.snapshot), row.createdAt, row.updatedAt],
    );
  }

  for (const member of snapshot.canvasMembers) {
    if (!member?.canvasId || !canvasIds.has(member.canvasId)) continue;
    const row = canvasMemberToRow(member, timestamp);
    if (!userIds.has(row.userId)) continue;
    await client.query(
      "insert into canvas_members (canvas_id, user_id, role, added_at) values ($1, $2, $3, $4) on conflict (canvas_id, user_id) do update set role = excluded.role",
      [row.canvasId, row.userId, row.role, row.addedAt],
    );
  }

  for (const asset of snapshot.assets) {
    if (!asset?.id || !projectIds.has(asset.projectId)) continue;
    const row = assetToRow(asset, projectOwners, timestamp);
    await client.query(
      "insert into assets (id, project_id, owner_user_id, type, title, url, metadata, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)",
      [row.id, row.projectId, row.ownerUserId, row.type, row.title, row.url, jsonb(row.metadata), row.createdAt, row.updatedAt],
    );
  }

  for (const task of snapshot.tasks) {
    if (!task?.id) continue;
    const row = taskToRow(task, validRefs, timestamp);
    if (row.userId && !userIds.has(row.userId)) row.userId = null;
    await client.query(
      "insert into tasks (id, project_id, canvas_id, node_id, user_id, type, model_id, status, progress, input, output, error, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)",
      [row.id, row.projectId, row.canvasId, row.nodeId, row.userId, row.type, row.modelId, row.status, row.progress, jsonb(row.input), row.output ? jsonb(row.output) : null, row.error, row.createdAt, row.updatedAt],
    );
  }

  for (const event of snapshot.systemEvents) {
    if (!event?.id) continue;
    const row = systemEventToRow(event, timestamp);
    if (row.userId && !userIds.has(row.userId)) row.userId = null;
    await client.query(
      "insert into system_events (id, user_id, level, category, source, message, metadata, created_at) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
      [row.id, row.userId, row.level, row.category, row.source, row.message, jsonb(row.metadata), row.createdAt],
    );
  }

  for (const record of snapshot.workflowSnapshots) {
    if (!record?.id) continue;
    const row = workflowSnapshotToRow(record, canvasIds, timestamp);
    if (!row.canvasId) continue;
    await client.query(
      "insert into yjs_snapshots (id, canvas_id, snapshot, update_data, created_at) values ($1, $2, $3::jsonb, $4, $5)",
      [row.id, row.canvasId, jsonb(row.snapshot), row.updateData, row.createdAt],
    );
  }

  for (const record of snapshot.workflowUpdates) {
    if (!record?.id || !record.update) continue;
    const row = workflowUpdateToRow(record, canvasIds, timestamp);
    if (!row.canvasId) continue;
    await client.query(
      "insert into yjs_updates (id, canvas_id, user_id, update_data, created_at) values ($1, $2, $3, $4, $5)",
      [row.id, row.canvasId, row.userId && userIds.has(row.userId) ? row.userId : null, row.updateData, row.createdAt],
    );
  }
}

// ──────────────────────────────────────────────────────────────
// PostgreSQL 专用只读视图方法
// 这些方法供 server.js 的 GET 路由直接调用，避免 readJson() 整库快照加载。
// ──────────────────────────────────────────────────────────────

export async function listProjectsView(userId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    // 基础项目 + 聚合统计，一条 SQL 完成
    const result = await client.query(`
      select
        p.id,
        p.name,
        p.owner_user_id as "ownerId",
        p.created_at as "createdAt",
        p.updated_at as "updatedAt",
        coalesce(c_agg.canvas_count, 0) as "canvasCount",
        c_agg.last_canvas_updated_at as "lastCanvasUpdatedAt",
        coalesce(a_agg.asset_count, 0) as "assetCount",
        coalesce(yu_agg.update_count, 0) as "historyUpdateCount",
        coalesce(ys_agg.snapshot_count, 0) as "historySnapshotCount"
      from projects p
      left join lateral (
        select count(*) as canvas_count, max(updated_at) as last_canvas_updated_at
        from canvases where project_id = p.id
      ) c_agg on true
      left join lateral (
        select count(*) as asset_count from assets where project_id = p.id
      ) a_agg on true
      left join lateral (
        select count(*) as update_count from yjs_updates yu
        join canvases c on c.id = yu.canvas_id and c.project_id = p.id
      ) yu_agg on true
      left join lateral (
        select count(*) as snapshot_count from yjs_snapshots ys
        join canvases c on c.id = ys.canvas_id and c.project_id = p.id
      ) ys_agg on true
      where $1 = '' or p.owner_user_id = $1 or exists (
        select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $1
      )
      order by p.updated_at desc
    `, [userId || ""]);
    return result.rows.map((row) => compactObject({
      id: String(row.id),
      name: row.name || "Untitled Project",
      ownerId: row.ownerId || "default-user",
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      canvasCount: toNumber(row.canvasCount, 0),
      assetCount: toNumber(row.assetCount, 0),
      historyUpdateCount: toNumber(row.historyUpdateCount, 0),
      historySnapshotCount: toNumber(row.historySnapshotCount, 0),
      lastCanvasUpdatedAt: row.lastCanvasUpdatedAt ? toIso(row.lastCanvasUpdatedAt) : undefined,
    }));
  } finally {
    client.release();
  }
}

export async function getProjectView(projectId, userId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const projectResult = await client.query(
      "select id, name, owner_user_id, created_at, updated_at from projects where id = $1",
      [projectId],
    );
    if (projectResult.rowCount === 0) return null;
    const projectRow = projectResult.rows[0];
    const project = rowToProject(projectRow);

    // 查询当前用户可访问的画布
    const canvasesResult = await client.query(`
      select id, project_id, owner_user_id, name, snapshot, created_at, updated_at from canvases
      where project_id = $1 and ($2 = '' or owner_user_id = $2 or exists (
        select 1 from canvas_members cm where cm.canvas_id = canvases.id and cm.user_id = $2
      ))
      order by created_at asc
    `, [projectId, userId || ""]);
    const canvases = canvasesResult.rows.map(rowToCanvas);
    return { project, canvases };
  } finally {
    client.release();
  }
}

export async function listCollaborativeCanvasesView(userId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(`
      select
        c.id,
        c.project_id,
        c.owner_user_id,
        c.name,
        c.snapshot,
        c.created_at,
        c.updated_at,
        cm.role,
        cm.added_at,
        p.name as project_name,
        u.display_name as owner_name,
        u.email as owner_email
      from canvas_members cm
      join canvases c on c.id = cm.canvas_id
      left join projects p on p.id = c.project_id
      left join users u on u.id = c.owner_user_id
      where cm.user_id = $1 and c.owner_user_id <> $1
      order by c.updated_at desc
    `, [userId || ""]);
    return result.rows.map((row) => compactObject({
      canvas: rowToCanvas(row),
      role: row.role || "viewer",
      addedAt: row.added_at ? toIso(row.added_at) : undefined,
      projectName: row.project_name || undefined,
      owner: compactObject({
        id: row.owner_user_id,
        name: row.owner_name || row.owner_user_id,
        email: row.owner_email || undefined,
      }),
    }));
  } finally {
    client.release();
  }
}

export async function getCanvasView(canvasId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(
      "select id, project_id, owner_user_id, name, snapshot, created_at, updated_at from canvases where id = $1",
      [canvasId],
    );
    if (result.rowCount === 0) return null;
    return rowToCanvas(result.rows[0]);
  } finally {
    client.release();
  }
}

export async function listCanvasMembersView(canvasId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    // 先查画布获取 owner 信息
    const canvasResult = await client.query(
      "select id, owner_user_id, created_at from canvases where id = $1",
      [canvasId],
    );
    if (canvasResult.rowCount === 0) return null;
    const canvas = canvasResult.rows[0];

    const membersResult = await client.query(
      `select cm.canvas_id, cm.user_id, cm.role, cm.added_at, u.display_name, u.email
       from canvas_members cm
       left join users u on u.id = cm.user_id
       where cm.canvas_id = $1
       order by cm.added_at asc`,
      [canvasId],
    );
    const members = membersResult.rows.map((row) => compactObject({
      ...rowToCanvasMember(row),
      userName: row.display_name || row.user_id,
      userEmail: row.email || undefined,
    }));
    const ownerEntry = {
      canvasId: canvas.id,
      userId: canvas.owner_user_id || "default-user",
      role: "owner",
      addedAt: toIso(canvas.created_at),
    };
    const hasOwner = members.some((m) => m.userId === ownerEntry.userId);
    return hasOwner ? members : [ownerEntry, ...members];
  } finally {
    client.release();
  }
}

export async function listAssetsView(projectId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    if (projectId) {
      const result = await client.query(
        "select id, project_id, owner_user_id, type, title, url, metadata, created_at, updated_at from assets where project_id = $1 order by created_at desc",
        [projectId],
      );
      return result.rows.map(rowToAsset);
    }
    // 无 projectId 时返回全部，但限制字段
    const result = await client.query(
      "select id, project_id, owner_user_id, type, title, url, metadata, created_at, updated_at from assets order by created_at desc",
    );
    return result.rows.map(rowToAsset);
  } finally {
    client.release();
  }
}

export async function listAdminUsersView() {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(`
      select
        u.id,
        u.display_name,
        u.email,
        u.password_hash,
        u.created_at,
        u.updated_at,
        u.last_seen_at,
        count(distinct p.id) as project_count,
        count(distinct c.id) as owned_canvas_count,
        count(distinct cm.canvas_id) as shared_canvas_count
      from users u
      left join projects p on p.owner_user_id = u.id
      left join canvases c on c.owner_user_id = u.id
      left join canvas_members cm on cm.user_id = u.id
      group by u.id, u.display_name, u.email, u.password_hash, u.created_at, u.updated_at, u.last_seen_at
      order by u.created_at desc
    `);
    return result.rows.map((row) => compactObject({
      ...rowToUser(row),
      projectCount: toNumber(row.project_count, 0),
      ownedCanvasCount: toNumber(row.owned_canvas_count, 0),
      sharedCanvasCount: toNumber(row.shared_canvas_count, 0),
    }));
  } finally {
    client.release();
  }
}

export async function listProvidersView() {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query("select * from providers order by created_at asc, id asc");
    return result.rows.map(rowToProvider);
  } finally {
    client.release();
  }
}

export async function listModelsView() {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query("select * from models order by created_at asc, id asc");
    return result.rows.map(rowToModel);
  } finally {
    client.release();
  }
}

export async function updateAdminUserRecord(userId, patch = {}) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const sets = [];
    const values = [];
    const set = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if ("name" in patch || "displayName" in patch) set("display_name", String(patch.displayName || patch.name || "").trim());
    if ("email" in patch) {
      const email = String(patch.email || "").trim().toLowerCase();
      set("email", email || null);
    }
    if ("passwordHash" in patch || "password_hash" in patch) {
      set("password_hash", patch.passwordHash || patch.password_hash || null);
    }
    set("updated_at", new Date().toISOString());
      values.push(userId);
      const result = await client.query(
        `update users set ${sets.join(", ")} where id = $${values.length}
       returning id, display_name, email, password_hash, fingerprint_hash, fingerprint_version, created_at, updated_at, last_seen_at`,
      values,
    );
    if (result.rowCount === 0) return null;
    return rowToUser(result.rows[0]);
  } finally {
    client.release();
  }
}

export async function deleteAdminUserRecord(userId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    await client.query("begin");
    try {
      const userResult = await client.query(
        "select id, display_name, email, fingerprint_hash, fingerprint_version, created_at, updated_at, last_seen_at from users where id = $1 for update",
        [userId],
      );
      if (userResult.rowCount === 0) {
        await client.query("rollback");
        return null;
      }
      const countsResult = await client.query(
        `select
          (select count(*) from projects where owner_user_id = $1) as project_count,
          (select count(*) from canvases where owner_user_id = $1) as owned_canvas_count`,
        [userId],
      );
      const projectCount = toNumber(countsResult.rows[0]?.project_count, 0);
      const ownedCanvasCount = toNumber(countsResult.rows[0]?.owned_canvas_count, 0);
      if (projectCount > 0 || ownedCanvasCount > 0) {
        await client.query("rollback");
        return {
          error: "user_owns_content",
          user: rowToUser(userResult.rows[0]),
          projectCount,
          ownedCanvasCount,
        };
      }
      await client.query("delete from auth_tokens where user_id = $1", [userId]);
      await client.query("delete from canvas_invites where owner_user_id = $1", [userId]);
      await client.query("delete from canvas_members where user_id = $1", [userId]);
      await client.query("delete from project_members where user_id = $1", [userId]);
      const deletedResult = await client.query(
        "delete from users where id = $1 returning id, display_name, email, fingerprint_hash, fingerprint_version, created_at, updated_at, last_seen_at",
        [userId],
      );
      await client.query("commit");
      return { deleted: true, user: rowToUser(deletedResult.rows[0]) };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function getTaskView(taskId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(
      "select id, project_id, canvas_id, node_id, user_id, type, model_id, status, progress, input, output, error, created_at, updated_at from tasks where id = $1",
      [taskId],
    );
    if (result.rowCount === 0) return null;
    return rowToTask(result.rows[0]);
  } finally {
    client.release();
  }
}

export async function getAdminOverviewView() {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    // 任务统计
    const taskStatsResult = await client.query(`
      select
        status,
        count(*) as cnt
      from tasks
      group by status
    `);
    const byStatus = { idle: 0, pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    let total = 0;
    for (const row of taskStatsResult.rows) {
      const status = String(row.status);
      if (Object.prototype.hasOwnProperty.call(byStatus, status)) {
        byStatus[status] = toNumber(row.cnt, 0);
      }
      total += toNumber(row.cnt, 0);
    }

    // 失败任务错误分类统计
    const errorCategoryResult = await client.query(`
      select error from tasks where status = 'failed'
    `);
    const byErrorCategory = { connection: 0, auth: 0, timeout: 0, non_json: 0, field_mapping: 0, model_error: 0, other: 0 };
    const { classifyTaskError } = await import("./adminOverviewService.js");
    for (const row of errorCategoryResult.rows) {
      const cat = classifyTaskError(row.error);
      if (Object.prototype.hasOwnProperty.call(byErrorCategory, cat)) {
        byErrorCategory[cat] += 1;
      }
    }

    // 平均耗时
    const durationResult = await client.query(`
      select avg(extract(epoch from (updated_at - created_at)) * 1000) as avg_ms
      from tasks where status in ('succeeded', 'failed') and created_at is not null and updated_at is not null
    `);
    const averageDurationMs = durationResult.rows[0]?.avg_ms ? Math.round(toNumber(durationResult.rows[0].avg_ms, 0)) : null;

    // 模型/供应商统计
    const providerCountResult = await client.query("select count(*) as total, count(*) filter (where (body->>'enabled')::boolean != false) as enabled from providers");
    const modelCountResult = await client.query("select count(*) as total, count(*) filter (where (body->>'enabled')::boolean != false) as enabled, (body->>'type') as type from models group by (body->>'type')");

    const providerStats = providerCountResult.rows[0] || {};
    const modelByType = {};
    let modelTotal = 0;
    let modelEnabled = 0;
    for (const row of modelCountResult.rows) {
      const type = String(row.type || "unknown");
      modelByType[type] = toNumber(row.total, 0);
      modelTotal += toNumber(row.total, 0);
      modelEnabled += toNumber(row.enabled, 0);
    }

    // 系统事件统计
    const eventStatsResult = await client.query(`
      select level, category, count(*) as cnt, max(created_at) as latest_at
      from system_events
      group by level, category
    `);
    const eventSummary = { total: 0, byLevel: { info: 0, warning: 0, error: 0 }, byCategory: { system: 0, api: 0, security: 0, task: 0, model: 0, backup: 0 }, latestErrorAt: null, latestWarningAt: null };
    for (const row of eventStatsResult.rows) {
      const level = String(row.level) === "warn" ? "warning" : String(row.level);
      const category = String(row.category);
      eventSummary.total += toNumber(row.cnt, 0);
      if (Object.prototype.hasOwnProperty.call(eventSummary.byLevel, level)) eventSummary.byLevel[level] += toNumber(row.cnt, 0);
      if (Object.prototype.hasOwnProperty.call(eventSummary.byCategory, category)) eventSummary.byCategory[category] += toNumber(row.cnt, 0);
      if (level === "error" && !eventSummary.latestErrorAt) eventSummary.latestErrorAt = row.latest_at ? toIso(row.latest_at) : null;
      if (level === "warning" && !eventSummary.latestWarningAt) eventSummary.latestWarningAt = row.latest_at ? toIso(row.latest_at) : null;
    }

    // 最近告警信号
    const recentSignalsResult = await client.query(
      "select id, user_id, level, category, source, message, metadata, created_at from system_events where level in ('error', 'warning') order by created_at desc limit 6",
    );
    const recentSignals = recentSignalsResult.rows.map(rowToSystemEvent);

    // 备份摘要
    const backupResult = await client.query(
      "select id, user_id, level, category, source, message, metadata, created_at from system_events where category = 'backup' order by created_at desc",
    );
    const backupEvents = backupResult.rows.map(rowToSystemEvent);
    const latestBackup = backupEvents[0] || null;
    const latestBackupError = backupEvents.find((e) => e.level === "error") || null;

    // 最近失败任务
    const recentFailedResult = await client.query(
      "select id, project_id, canvas_id, node_id, user_id, type, model_id, status, progress, input, output, error, created_at, updated_at from tasks where status = 'failed' order by updated_at desc limit 5",
    );
    const modelsResult = await client.query("select id, body from models");
    const providersResult = await client.query("select id, body from providers");
    const modelsList = modelsResult.rows.map(rowToModel);
    const providersList = providersResult.rows.map(rowToProvider);
    const { enrichAdminTask } = await import("./adminOverviewService.js");
    const recentFailedTasks = recentFailedResult.rows.map((row) => enrichAdminTask(rowToTask(row), modelsList, providersList));

    const completed = byStatus.succeeded + byStatus.failed + byStatus.cancelled;

    return {
      generatedAt: new Date().toISOString(),
      tasks: {
        total,
        byStatus,
        successRate: total ? Math.round((byStatus.succeeded / total) * 1000) / 10 : 0,
        failureRate: total ? Math.round((byStatus.failed / total) * 1000) / 10 : 0,
        active: byStatus.pending + byStatus.running,
        completed,
        averageDurationMs,
        byErrorCategory,
      },
      modelRuntime: {
        providers: {
          total: toNumber(providerStats.total, 0),
          enabled: toNumber(providerStats.enabled, 0),
          disabled: toNumber(providerStats.total, 0) - toNumber(providerStats.enabled, 0),
        },
        models: {
          total: modelTotal,
          enabled: modelEnabled,
          disabled: modelTotal - modelEnabled,
          byType: modelByType,
        },
      },
      events: { summary: eventSummary, recentSignals },
      backup: {
        latest: latestBackup,
        latestError: latestBackupError,
        total: backupEvents.length,
        errors: backupEvents.filter((e) => e.level === "error").length,
        warnings: backupEvents.filter((e) => e.level === "warning").length,
      },
      recentFailedTasks,
    };
  } finally {
    client.release();
  }
}

export async function listAdminTasksView(limit = 200) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const tasksResult = await client.query(
      "select id, project_id, canvas_id, node_id, user_id, type, model_id, status, progress, input, output, error, created_at, updated_at from tasks order by created_at desc limit $1",
      [safeLimit],
    );
    const modelsResult = await client.query("select id, body from models");
    const providersResult = await client.query("select id, body from providers");
    const modelsList = modelsResult.rows.map(rowToModel);
    const providersList = providersResult.rows.map(rowToProvider);
    const { enrichAdminTask } = await import("./adminOverviewService.js");
    return tasksResult.rows.map((row) => enrichAdminTask(rowToTask(row), modelsList, providersList));
  } finally {
    client.release();
  }
}

export async function getAdminTaskView(taskId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const taskResult = await client.query(
      "select id, project_id, canvas_id, node_id, user_id, type, model_id, status, progress, input, output, error, created_at, updated_at from tasks where id = $1",
      [taskId],
    );
    if (taskResult.rowCount === 0) return null;
    const modelsResult = await client.query("select id, body from models");
    const providersResult = await client.query("select id, body from providers");
    const modelsList = modelsResult.rows.map(rowToModel);
    const providersList = providersResult.rows.map(rowToProvider);
    const { enrichAdminTask } = await import("./adminOverviewService.js");
    return enrichAdminTask(rowToTask(taskResult.rows[0]), modelsList, providersList);
  } finally {
    client.release();
  }
}

export async function listSystemEventsView(filters = {}) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    const level = filters.level ? (String(filters.level).toLowerCase() === "warn" ? "warning" : String(filters.level).toLowerCase()) : "";
    if (level) {
      conditions.push(`level = $${paramIdx++}`);
      params.push(level);
    }
    const category = filters.category ? String(filters.category) : "";
    if (category) {
      conditions.push(`category = $${paramIdx++}`);
      params.push(category);
    }
    const limit = Math.min(Math.max(Number(filters.limit || 100), 1), 500);
    const where = conditions.length ? `where ${conditions.join(" and ")}` : "";

    // 事件列表
    const eventsResult = await client.query(
      `select id, user_id, level, category, source, message, metadata, created_at from system_events ${where} order by created_at desc limit $${paramIdx++}`,
      [...params, limit],
    );
    const events = eventsResult.rows.map(rowToSystemEvent);

    // 汇总统计（不受 limit 影响）
    const statsResult = await client.query(
      `select level, category, count(*) as cnt, max(created_at) as latest_at from system_events group by level, category`,
    );
    const summary = { total: 0, byLevel: { info: 0, warning: 0, error: 0 }, byCategory: { system: 0, api: 0, security: 0, task: 0, model: 0, backup: 0 }, latestErrorAt: null, latestWarningAt: null };
    for (const row of statsResult.rows) {
      const lvl = String(row.level) === "warn" ? "warning" : String(row.level);
      const cat = String(row.category);
      summary.total += toNumber(row.cnt, 0);
      if (Object.prototype.hasOwnProperty.call(summary.byLevel, lvl)) summary.byLevel[lvl] += toNumber(row.cnt, 0);
      if (Object.prototype.hasOwnProperty.call(summary.byCategory, cat)) summary.byCategory[cat] += toNumber(row.cnt, 0);
      if (lvl === "error" && !summary.latestErrorAt) summary.latestErrorAt = row.latest_at ? toIso(row.latest_at) : null;
      if (lvl === "warning" && !summary.latestWarningAt) summary.latestWarningAt = row.latest_at ? toIso(row.latest_at) : null;
    }

    return { events, summary };
  } finally {
    client.release();
  }
}

export async function listYjsHistoryView(canvasId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    // 不读取 update_data，只返回元信息
    const result = await client.query(
      "select id, canvas_id, snapshot, created_at from yjs_snapshots where canvas_id = $1 order by created_at desc, id desc",
      [canvasId],
    );
    return result.rows.map((row) => {
      const snapshot = asObject(row.snapshot);
      return compactObject({
        id: String(row.id),
        canvasId: row.canvas_id,
        clock: snapshot.clock === undefined ? undefined : toNumber(snapshot.clock),
        updateCount: snapshot.updateCount === undefined ? undefined : toNumber(snapshot.updateCount),
        updateSize: 0,
        createdAt: toIso(row.created_at),
      });
    });
  } finally {
    client.release();
  }
}

export async function getYjsHistorySnapshotView(canvasId, snapshotId) {
  const nextPool = await loadPgPool();
  const client = await nextPool.connect();
  try {
    const result = await client.query(
      "select id, canvas_id, snapshot, update_data, created_at from yjs_snapshots where canvas_id = $1 and id = $2",
      [canvasId, snapshotId],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    const record = rowToWorkflowSnapshot(row, 0);
    if (!record.update) return null;

    // 使用 Yjs 解码快照
    const { buildYDocFromPersistence, snapshotFromYDoc } = await import("./yjsPersistenceService.js");
    const doc = buildYDocFromPersistence({ snapshot: record, updates: [] });
    const snapshot = snapshotFromYDoc(doc);
    const { update, ...publicRecord } = record;
    return {
      record: {
        ...publicRecord,
        updateSize: typeof update === "string" ? Buffer.byteLength(update, "base64") : 0,
      },
      snapshot,
      summary: {
        nodes: snapshot.nodes.length,
        edges: snapshot.edges.length,
        groups: (snapshot.groups || []).length,
      },
    };
  } finally {
    client.release();
  }
}

export function createPostgresStore({ createDefaultDb, normalizeDb }) {
  async function withClient(callback) {
    const nextPool = await loadPgPool();
    const client = await nextPool.connect();
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  }

  // 暴露连接池供外部复用（如 isPostgresBackend 健康检查）
  async function getPool() {
    return loadPgPool();
  }

  async function writeSnapshot(db) {
    return withClient(async (client) => {
      await client.query("begin");
      try {
        await replacePostgresSnapshot(client, db);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    });
  }

  return {
    getPool,
    async ensureDb() {
      await withClient(async (client) => {
        await client.query("begin");
        try {
          await lockSnapshotWrite(client);
          await assertRequiredTables(client);
          // 快速检查是否有数据，避免加载整个快照
          const countResult = await client.query(
            "select (select count(*) from users) as users_count, (select count(*) from projects) as projects_count, (select count(*) from canvases) as canvases_count, (select count(*) from providers) as providers_count, (select count(*) from models) as models_count",
          );
          const counts = countResult.rows[0] || {};
          const hasData = Object.values(counts).some((count) => Number(count) > 0);
          if (!hasData) {
            // 数据库为空，初始化默认数据
            const base = createDefaultDb();
            const { db, changed } = normalizeDb(base);
            await replacePostgresSnapshot(client, changed ? db : base);
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    async readJson() {
      // 使用连接池并行查询，避免串行网络延迟累积导致超时
      const pool = await loadPgPool();
      return loadPostgresSnapshotParallel(pool);
    },
    async writeJson(db) {
      const normalized = normalizeDb(db).db;
      await writeSnapshot(normalized);
    },
    async updateJson(mutator) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          await assertRequiredTables(client);
          const db = normalizeDb(await loadPostgresSnapshot(client)).db;
          const result = await mutator(db);
          await replacePostgresSnapshot(client, normalizeDb(db).db);
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接更新单个 canvas 的 snapshot，避免全表重写导致的性能问题。
    // 返回更新后的 canvas 对象，找不到时返回 null。
    async updateCanvasSnapshot(canvasId, snapshot, updatedAt, options = {}) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const returning = options.returnSnapshot === false
            ? "id, project_id, owner_user_id, name, created_at, updated_at"
            : "id, project_id, owner_user_id, name, snapshot, created_at, updated_at";
          const result = await client.query(
            `update canvases set snapshot = $1::jsonb, updated_at = $2 where id = $3 returning ${returning}`,
            [JSON.stringify(snapshot || {}), updatedAt, canvasId],
          );
          if (result.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          await client.query("commit");
          const row = result.rows[0];
          return rowToCanvas(row);
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接更新单个 model，避免全表重写。
    async updateModel(modelId, patch) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const selectResult = await client.query("select body from models where id = $1 for update", [modelId]);
          if (selectResult.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          const model = asObject(selectResult.rows[0].body);
          for (const key of ["providerId", "name", "displayName", "type", "capabilities", "defaultParams", "defaultPublicParams", "paramSchema", "publicParamSchema", "adapter", "enabled", "sortOrder", "allowMockFallback"]) {
            if (key in patch) model[key] = patch[key];
          }
          model.updatedAt = new Date().toISOString();
          const providerId = model.providerId || null;
          await client.query(
            "update models set provider_id = $1, body = $2::jsonb, updated_at = $3 where id = $4",
            [providerId, JSON.stringify(model), model.updatedAt, modelId],
          );
          await client.query("commit");
          return model;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接更新单个 provider，避免全表重写。
    async updateProvider(providerId, patch) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const selectResult = await client.query("select body from providers where id = $1 for update", [providerId]);
          if (selectResult.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          const provider = asObject(selectResult.rows[0].body);
          for (const key of ["name", "type", "baseUrl", "authType", "timeoutSeconds", "enabled"]) {
            if (key in patch) provider[key] = patch[key];
          }
          if ("secret" in patch || "secretValue" in patch) {
            provider.secretValue = patch.secret || patch.secretValue || undefined;
            provider.secretStorage = provider.secretValue ? "plain-local-json" : undefined;
          }
          provider.updatedAt = new Date().toISOString();
          await client.query(
            "update providers set body = $1::jsonb, updated_at = $2 where id = $3",
            [JSON.stringify(provider), provider.updatedAt, providerId],
          );
          await client.query("commit");
          return provider;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接插入 user，避免全表重写。
    async createUser(user) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const row = userToRow(user, user.createdAt);
          await client.query(
            "insert into users (id, display_name, email, password_hash, fingerprint_hash, fingerprint_version, created_at, updated_at, last_seen_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [row.id, row.displayName, row.email, user.passwordHash || user.password_hash || null, row.fingerprintHash, row.fingerprintVersion, row.createdAt, row.updatedAt, row.lastSeenAt],
          );
          await client.query("commit");
          return user;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接插入 project，避免全表重写。
    async createProject(project) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const row = projectToRow(project, project.createdAt);
          await client.query(
            "insert into projects (id, owner_user_id, name, created_at, updated_at) values ($1, $2, $3, $4, $5)",
            [row.id, row.ownerUserId, row.name, row.createdAt, row.updatedAt],
          );
          await client.query("commit");
          return project;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    async createProjectWithCanvas(project, canvas) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const projectRow = projectToRow(project, project.createdAt);
          const canvasRow = canvasToRow({ ...canvas, projectId: project.id, ownerId: project.ownerId }, new Map(), canvas.createdAt);
          await client.query(
            "insert into projects (id, owner_user_id, name, created_at, updated_at) values ($1, $2, $3, $4, $5)",
            [projectRow.id, projectRow.ownerUserId, projectRow.name, projectRow.createdAt, projectRow.updatedAt],
          );
          await client.query(
            "insert into canvases (id, project_id, owner_user_id, name, snapshot, created_at, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7)",
            [canvasRow.id, canvasRow.projectId, canvasRow.ownerUserId, canvasRow.name, JSON.stringify(canvasRow.snapshot), canvasRow.createdAt, canvasRow.updatedAt],
          );
          await client.query("commit");
          return { project, canvas: { ...canvas, projectId: project.id, ownerId: project.ownerId } };
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接插入 canvas，避免全表重写。
    async createCanvas(canvas) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const row = canvasToRow(canvas, new Map(), canvas.createdAt);
          await client.query(
            "insert into canvases (id, project_id, owner_user_id, name, snapshot, created_at, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7)",
            [row.id, row.projectId, row.ownerUserId, row.name, JSON.stringify(row.snapshot), row.createdAt, row.updatedAt],
          );
          await client.query("update projects set updated_at = $1 where id = $2", [row.updatedAt, row.projectId]);
          await client.query("commit");
          return canvas;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接插入 task，避免全表重写。
    async createTask(task) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const row = taskToRow(task, { projectIds: new Set([task.projectId]), canvasIds: new Set([task.canvasId]) }, task.createdAt);
          await client.query(
            "insert into tasks (id, project_id, canvas_id, node_id, user_id, type, model_id, status, progress, input, output, error, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)",
            [row.id, row.projectId, row.canvasId, row.nodeId, row.userId, row.type, row.modelId, row.status, row.progress, JSON.stringify(row.input), row.output ? JSON.stringify(row.output) : null, row.error, row.createdAt, row.updatedAt],
          );
          await client.query("commit");
          return task;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接更新 task，避免全表重写。
    async updateTask(taskId, patch) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const selectResult = await client.query("select status, progress, input, output from tasks where id = $1 for update", [taskId]);
          if (selectResult.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          const existingInput = asObject(selectResult.rows[0].input);
          const existingOutput = selectResult.rows[0].output ? asObject(selectResult.rows[0].output) : null;
          const merged = { ...existingInput };
          if (patch.input) Object.assign(merged, patch.input);
          const output = patch.output || existingOutput;
          const updatedAt = new Date().toISOString();
          const status = patch.status || selectResult.rows[0].status || "pending";
          const progress = patch.progress ?? toNumber(selectResult.rows[0].progress, 0);
          await client.query(
            "update tasks set status = $1, progress = $2, input = $3::jsonb, output = $4::jsonb, error = $5, updated_at = $6 where id = $7",
            [status, progress, JSON.stringify(merged), output ? JSON.stringify(output) : null, patch.error || null, updatedAt, taskId],
          );
          await client.query("commit");
          return { id: taskId, ...patch, status, progress, input: merged, output, updatedAt };
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接插入 asset，避免全表重写。
    async createAsset(asset) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const row = assetToRow(asset, new Map(), asset.createdAt);
          await client.query(
            "insert into assets (id, project_id, owner_user_id, type, title, url, metadata, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)",
            [row.id, row.projectId, row.ownerUserId, row.type, row.title, row.url, JSON.stringify(row.metadata), row.createdAt, row.updatedAt],
          );
          await client.query("commit");
          return asset;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接插入 system_event，避免全表重写。
    async appendSystemEvent(event) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const row = systemEventToRow(event, event.createdAt);
          await client.query(
            "insert into system_events (id, user_id, level, category, source, message, metadata, created_at) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
            [row.id, row.userId, row.level, row.category, row.source, row.message, JSON.stringify(row.metadata), row.createdAt],
          );
          await client.query("commit");
          return event;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接更新单个 project，避免 updateJson 的全表重写。
    async updateProject(projectId, patch) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const sets = [];
          const values = [];
          const set = (column, value) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
          };
          if ("name" in patch) set("name", String(patch.name || ""));
          set("updated_at", new Date().toISOString());
          if (!sets.length) {
            await client.query("rollback");
            return null;
          }
          values.push(projectId);
          const result = await client.query(
            `update projects set ${sets.join(", ")} where id = $${values.length} returning id, owner_user_id, name, created_at, updated_at`,
            values,
          );
          if (result.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          await client.query("commit");
          return rowToProject(result.rows[0]);
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接更新 canvas 元数据（名称等），避免全表重写。
    async updateCanvasMeta(canvasId, patch) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const sets = [];
          const values = [];
          const set = (column, value) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
          };
          if ("name" in patch) set("name", String(patch.name || ""));
          set("updated_at", new Date().toISOString());
          if (!sets.length) {
            await client.query("rollback");
            return null;
          }
          values.push(canvasId);
          const result = await client.query(
            `update canvases set ${sets.join(", ")} where id = $${values.length} returning id, project_id, owner_user_id, name, snapshot, created_at, updated_at`,
            values,
          );
          if (result.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          await client.query("commit");
          return rowToCanvas(result.rows[0]);
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接 upsert canvas 成员，避免全表重写。
    async upsertCanvasMember(canvasId, userId, role, addedAt) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const result = await client.query(
            `insert into canvas_members (canvas_id, user_id, role, added_at)
             values ($1, $2, $3, $4)
             on conflict (canvas_id, user_id) do update set role = excluded.role, added_at = excluded.added_at
             returning canvas_id, user_id, role, added_at`,
            [canvasId, userId, role, addedAt],
          );
          await client.query("commit");
          return { canvasId, userId, role, addedAt: result.rows[0].added_at };
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接删除 canvas 成员，避免全表重写。
    async removeCanvasMember(canvasId, userId) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const result = await client.query(
            "delete from canvas_members where canvas_id = $1 and user_id = $2 returning user_id",
            [canvasId, userId],
          );
          if (result.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          await client.query("commit");
          return { canvasId, userId };
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接更新 asset，避免全表重写。
    async updateAsset(assetId, patch) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const sets = [];
          const values = [];
          const set = (column, value) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
          };
          if ("name" in patch) set("title", String(patch.name || ""));
          if ("metadata" in patch) set("metadata", JSON.stringify(patch.metadata));
          if (!sets.length) {
            await client.query("rollback");
            return null;
          }
          values.push(assetId);
          const result = await client.query(
            `update assets set ${sets.join(", ")} where id = $${values.length} returning id, project_id, owner_user_id, type, title, url, metadata, created_at, updated_at`,
            values,
          );
          if (result.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          await client.query("commit");
          return rowToAsset(result.rows[0]);
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接删除 asset，避免全表重写。
    async deleteAsset(assetId) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const result = await client.query(
            "delete from assets where id = $1 returning id, project_id, owner_user_id, type, title, url, metadata, created_at, updated_at",
            [assetId],
          );
          if (result.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          await client.query("commit");
          return rowToAsset(result.rows[0]);
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接创建 provider，避免全表重写。
    async createProvider(provider) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          await client.query(
            "insert into providers (id, owner_user_id, type, name, base_url, auth_type, api_key, default_headers, metadata, secret_storage, timeout_seconds, enabled, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)",
            [
              provider.id,
              provider.ownerUserId,
              provider.type,
              provider.name,
              provider.baseUrl,
              provider.authType,
              provider.apiKey,
              JSON.stringify(provider.defaultHeaders || {}),
              JSON.stringify(provider.metadata || {}),
              provider.secretStorage || null,
              provider.timeoutSeconds || 30,
              provider.enabled !== false,
              provider.createdAt,
              provider.updatedAt,
            ],
          );
          await client.query("commit");
          return provider;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接创建 model，避免全表重写。
    async createModel(model) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          await client.query(
            "insert into models (id, provider_id, owner_user_id, name, display_name, type, capabilities, default_params, default_public_params, param_schema, public_param_schema, adapter, enabled, sort_order, allow_mock_fallback, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17)",
            [
              model.id,
              model.providerId,
              model.ownerUserId,
              model.name,
              model.displayName,
              model.type,
              JSON.stringify(model.capabilities || []),
              JSON.stringify(model.defaultParams || {}),
              JSON.stringify(model.defaultPublicParams || {}),
              JSON.stringify(model.paramSchema || {}),
              JSON.stringify(model.publicParamSchema || {}),
              model.adapter || null,
              model.enabled !== false,
              model.sortOrder || 0,
              model.allowMockFallback !== false,
              model.createdAt,
              model.updatedAt,
            ],
          );
          await client.query("commit");
          return model;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接删除 canvas，避免全表重写。
    async persistYjsUpdate(canvasId, encodedUpdate, options = {}) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          await client.query("select pg_advisory_xact_lock(hashtext('anime_canvas_yjs'), hashtext($1))", [canvasId]);
          const timestamp = options.timestamp || new Date().toISOString();
          const persistence = await getCanvasYjsPersistenceRows(client, canvasId);
          const latestClock = Math.max(
            toNumber(persistence.snapshot?.clock, 0),
            ...persistence.updates.map((record) => toNumber(record.clock, 0)),
          );
          const record = {
            id: options.id || `yupdate:${Date.now()}`,
            canvasId,
            clock: latestClock + 1,
            update: encodedUpdate,
            createdAt: timestamp,
          };
          const row = workflowUpdateToRow(record, new Set([canvasId]), timestamp);
          await client.query(
            "insert into yjs_updates (id, canvas_id, user_id, update_data, created_at) values ($1, $2, $3, $4, $5)",
            [row.id, row.canvasId, row.userId, row.updateData, row.createdAt],
          );
          await client.query("commit");
          return {
            update: record,
            snapshot: null,
            pendingUpdateCount: persistence.updates.length + 1,
            snapshotCreatedAt: persistence.snapshot?.createdAt || null,
          };
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    async saveYjsSnapshot(canvasId, encodedSnapshotUpdate, options = {}) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          await client.query("select pg_advisory_xact_lock(hashtext('anime_canvas_yjs'), hashtext($1))", [canvasId]);
          const timestamp = options.timestamp || new Date().toISOString();
          const persistence = await getCanvasYjsPersistenceRows(client, canvasId);
          const latestClock = Math.max(
            toNumber(persistence.snapshot?.clock, 0),
            ...persistence.updates.map((record) => toNumber(record.clock, 0)),
          );
          const record = {
            id: options.id || `ysnapshot:${Date.now()}`,
            canvasId,
            clock: latestClock,
            update: encodedSnapshotUpdate,
            updateCount: toNumber(persistence.snapshot?.updateCount, 0) + persistence.updates.length,
            createdAt: timestamp,
          };
          const row = workflowSnapshotToRow(record, new Set([canvasId]), timestamp);
          await client.query(
            "insert into yjs_snapshots (id, canvas_id, snapshot, update_data, created_at) values ($1, $2, $3::jsonb, $4, $5)",
            [row.id, row.canvasId, JSON.stringify(row.snapshot), row.updateData, row.createdAt],
          );
          await client.query("delete from yjs_updates where canvas_id = $1", [canvasId]);
          await client.query("commit");
          return record;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    // 直接查询单个 canvas 的 Yjs 持久化数据（快照 + 增量更新），
    // 避免 getRoomYDoc 触发 readJson() 加载整个数据库快照。
    async getCanvasYjsPersistence(canvasId) {
      return withClient(async (client) => {
        return getCanvasYjsPersistenceRows(client, canvasId);
      });
    },
    async deleteCanvas(canvasId) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const existing = await client.query("select project_id from canvases where id = $1", [canvasId]);
          const result = await client.query("delete from canvases where id = $1 returning id, project_id, owner_user_id, name, snapshot, created_at, updated_at", [canvasId]);
          if (result.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          if (existing.rowCount > 0) {
            await client.query("update projects set updated_at = now() where id = $1", [existing.rows[0].project_id]);
          }
          await client.query("commit");
          return rowToCanvas(result.rows[0]);
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    async deleteProjectGraph(projectId, userId) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const projectResult = await client.query(
            "select id, name, owner_user_id, created_at, updated_at from projects where id = $1 for update",
            [projectId],
          );
          if (projectResult.rowCount === 0) {
            await client.query("rollback");
            return null;
          }
          const canvasResult = await client.query(
            "select id, project_id, owner_user_id, name, snapshot, created_at, updated_at from canvases where project_id = $1 order by created_at asc",
            [projectId],
          );
          const assetResult = await client.query(
            "select id, project_id, owner_user_id, type, title, url, metadata, created_at, updated_at from assets where project_id = $1 order by created_at asc",
            [projectId],
          );
          const canvasIds = canvasResult.rows.map((row) => row.id);
          if (canvasIds.length > 0) {
            await client.query("delete from yjs_updates where canvas_id = any($1::text[])", [canvasIds]);
            await client.query("delete from yjs_snapshots where canvas_id = any($1::text[])", [canvasIds]);
            await client.query("delete from canvas_invites where canvas_id = any($1::text[])", [canvasIds]);
            await client.query("delete from canvas_members where canvas_id = any($1::text[])", [canvasIds]);
            await client.query("delete from tasks where canvas_id = any($1::text[])", [canvasIds]);
          }
          await client.query("delete from assets where project_id = $1", [projectId]);
          await client.query("delete from canvases where project_id = $1", [projectId]);
          await client.query("delete from project_members where project_id = $1", [projectId]);
          await client.query("delete from projects where id = $1", [projectId]);

          const nextProjectResult = await client.query(
            `select id, name, owner_user_id, created_at, updated_at from projects
             where owner_user_id = $1
             order by updated_at desc, created_at desc, id asc
             limit 1`,
            [userId || ""],
          );
          let nextProject = null;
          let nextCanvases = [];
          if (nextProjectResult.rowCount > 0) {
            nextProject = rowToProject(nextProjectResult.rows[0]);
            const nextCanvasResult = await client.query(
              "select id, project_id, owner_user_id, name, snapshot, created_at, updated_at from canvases where project_id = $1 order by created_at asc",
              [nextProject.id],
            );
            nextCanvases = nextCanvasResult.rows.map(rowToCanvas);
          }
          await client.query("commit");
          return {
            deletedProject: rowToProject(projectResult.rows[0]),
            deletedCanvases: canvasResult.rows.map(rowToCanvas),
            deletedAssets: assetResult.rows.map(rowToAsset),
            nextProject,
            nextCanvases,
          };
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
  };
}
