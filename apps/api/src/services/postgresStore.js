export const REQUIRED_TABLES = [
  "users",
  "user_devices",
  "projects",
  "project_members",
  "canvases",
  "assets",
  "tasks",
  "providers",
  "models",
  "system_events",
  "yjs_updates",
  "yjs_snapshots",
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

export function rowToCanvas(row = {}) {
  return compactObject({
    id: String(row.id),
    projectId: row.project_id,
    name: row.name || "Canvas",
    snapshot: row.snapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
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
  return compactObject({
    ...metadata,
    id: String(row.id),
    projectId: row.project_id,
    type: row.type,
    url: row.url,
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
    output: row.output || undefined,
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

export function preparePostgresSnapshot(db = {}, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const next = {
    users: cloneJson(asArray(db.users)),
    userDevices: cloneJson(asArray(db.userDevices)),
    projectMembers: cloneJson(asArray(db.projectMembers)),
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
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.POSTGRES_POOL_MAX || 10),
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 5000),
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 30000),
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
  const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
  if (missing.length) {
    throw new Error(`PostgreSQL schema is missing required tables: ${missing.join(", ")}`);
  }
}

export async function lockSnapshotWrite(client) {
  await client.query("select pg_advisory_xact_lock(hashtext('anime_canvas_snapshot_store'))");
}

export async function loadPostgresSnapshot(client) {
  const users = await client.query("select * from users order by created_at asc, id asc");
  const userDevices = await client.query("select * from user_devices order by created_at asc, id asc");
  const projects = await client.query("select * from projects order by created_at asc, id asc");
  const projectMembers = await client.query("select * from project_members order by created_at asc, project_id asc, user_id asc");
  const canvases = await client.query("select * from canvases order by created_at asc, id asc");
  const assets = await client.query("select * from assets order by created_at desc, id asc");
  const tasks = await client.query("select * from tasks order by created_at desc, id asc");
  const providers = await client.query("select * from providers order by created_at asc, id asc");
  const models = await client.query("select * from models order by created_at asc, id asc");
  const systemEvents = await client.query("select * from system_events order by created_at desc, id asc");
  const yjsSnapshots = await client.query("select * from yjs_snapshots order by canvas_id asc, created_at asc, id asc");
  const yjsUpdates = await client.query("select * from yjs_updates order by canvas_id asc, created_at asc, id asc");

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

async function clearTables(client) {
  await client.query("delete from yjs_updates");
  await client.query("delete from yjs_snapshots");
  await client.query("delete from system_events");
  await client.query("delete from tasks");
  await client.query("delete from assets");
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
      "insert into users (id, display_name, fingerprint_hash, fingerprint_version, created_at, updated_at, last_seen_at) values ($1, $2, $3, $4, $5, $6, $7)",
      [row.id, row.displayName, row.fingerprintHash, row.fingerprintVersion, row.createdAt, row.updatedAt, row.lastSeenAt],
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

  async function writeSnapshot(db) {
    return withClient(async (client) => {
      await client.query("begin");
      try {
        await lockSnapshotWrite(client);
        await replacePostgresSnapshot(client, db);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    });
  }

  return {
    async ensureDb() {
      await withClient(async (client) => {
        await client.query("begin");
        try {
          await lockSnapshotWrite(client);
          await assertRequiredTables(client);
          const loaded = await loadPostgresSnapshot(client);
          const hasData = [
            loaded.users,
            loaded.userDevices,
            loaded.projectMembers,
            loaded.projects,
            loaded.canvases,
            loaded.assets,
            loaded.tasks,
            loaded.providers,
            loaded.models,
            loaded.systemEvents,
            loaded.workflowUpdates,
            loaded.workflowSnapshots,
          ].some((items) => asArray(items).length > 0);
          const base = hasData ? loaded : createDefaultDb();
          const { db, changed } = normalizeDb(base);
          if (!hasData || changed) {
            await replacePostgresSnapshot(client, db);
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => {});
          throw error;
        }
      });
    },
    async readJson() {
      return withClient(async (client) => loadPostgresSnapshot(client));
    },
    async writeJson(db) {
      const normalized = normalizeDb(db).db;
      await writeSnapshot(normalized);
    },
    async updateJson(mutator) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          await lockSnapshotWrite(client);
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
  };
}
