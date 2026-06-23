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

export function rowToCanvas(row = {}) {
  return compactObject({
    id: String(row.id),
    projectId: row.project_id,
    ownerId: row.owner_user_id || undefined,
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
  // 自动创建 canvas_members 表（向后兼容旧 schema）
  if (!found.has("canvas_members")) {
    await client.query(
      "create table if not exists canvas_members (canvas_id text not null, user_id text not null, role text not null check (role in ('owner', 'editor', 'viewer')), added_at timestamptz not null default now(), primary key (canvas_id, user_id))",
    );
    await client.query("create index if not exists canvas_members_user_id_idx on canvas_members(user_id)");
    found.add("canvas_members");
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
      "select canvas_id, user_id, role, added_at from canvas_members where canvas_id = $1",
      [canvasId],
    );
    const members = membersResult.rows.map(rowToCanvasMember);
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
    async updateCanvasSnapshot(canvasId, snapshot, updatedAt) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const result = await client.query(
            "update canvases set snapshot = $1::jsonb, updated_at = $2 where id = $3 returning id, project_id, owner_user_id, name, snapshot, created_at, updated_at",
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
            "insert into users (id, display_name, fingerprint_hash, fingerprint_version, created_at, updated_at, last_seen_at) values ($1, $2, $3, $4, $5, $6, $7)",
            [row.id, row.displayName, row.fingerprintHash, row.fingerprintVersion, row.createdAt, row.updatedAt, row.lastSeenAt],
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
          const selectResult = await client.query("select input, output from tasks where id = $1 for update", [taskId]);
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
          await client.query(
            "update tasks set status = $1, progress = $2, input = $3::jsonb, output = $4::jsonb, error = $5, updated_at = $6 where id = $7",
            [patch.status || "pending", patch.progress || 0, JSON.stringify(merged), output ? JSON.stringify(output) : null, patch.error || null, updatedAt, taskId],
          );
          await client.query("commit");
          return { id: taskId, ...patch, input: merged, output, updatedAt };
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
    async deleteCanvas(canvasId) {
      return withClient(async (client) => {
        await client.query("begin");
        try {
          const result = await client.query("delete from canvases where id = $1 returning id, project_id, owner_user_id, name, snapshot, created_at, updated_at", [canvasId]);
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
  };
}
