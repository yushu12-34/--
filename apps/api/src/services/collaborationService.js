import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { getCanvasAccess, getCanvasYjsPersistenceDirect, getUserByAuthTokenHash, readJson } from "../db.js";
import { hashToken } from "./authService.js";
import {
  buildYDocFromPersistence,
  decodeYUpdate,
  encodeYUpdate,
  getCanvasYjsSnapshotDetail,
  listCanvasYjsSnapshots,
  persistYjsUpdate,
  saveYjsSnapshot,
} from "./yjsPersistenceService.js";
import { getBroadcastAdapter, setLocalBroadcast } from "./broadcastAdapter.js";

export { decodeYUpdate, encodeYUpdate } from "./yjsPersistenceService.js";

const rooms = new Map();
const roomSnapshots = new Map();
const roomYDocs = new Map();

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getRoom(canvasId) {
  if (!rooms.has(canvasId)) rooms.set(canvasId, new Map());
  return rooms.get(canvasId);
}

function serializePeers(room) {
  return [...room.values()].map((client) => client.presence).filter(Boolean);
}

function serializeAwarenessStates(room) {
  return [...room.values()].map((client) => client.awareness).filter(Boolean);
}

export function sanitizeAwarenessWireState(value, fallbackPresence) {
  if (!value || typeof value !== "object") return null;
  const clientId = Number(value.clientId);
  if (!Number.isFinite(clientId)) return null;
  if (value.state === null) return { clientId, state: null };
  if (!value.state || typeof value.state !== "object") return null;
  const state = value.state;
  const user = state.user && typeof state.user === "object" ? state.user : {};
  const cursor = state.cursor && typeof state.cursor === "object"
    ? {
        x: Number(state.cursor.x),
        y: Number(state.cursor.y),
      }
    : null;
  return {
    clientId,
    state: {
      user: {
        id: String(user.id || fallbackPresence?.id || clientId),
        name: String(user.name || fallbackPresence?.name || "Collaborator"),
        color: String(user.color || fallbackPresence?.color || "#8b6cff"),
      },
      cursor: cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) ? cursor : null,
      selectedNodeIds: Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds.map((item) => String(item)) : [],
      editingNodeId: state.editingNodeId ? String(state.editingNodeId) : null,
      lastActiveAt: new Date().toISOString(),
    },
  };
}

function hasSnapshotContent(snapshot) {
  return Boolean(
    snapshot
      && typeof snapshot === "object"
      && (
        (Array.isArray(snapshot.nodes) && snapshot.nodes.length > 0)
        || (Array.isArray(snapshot.edges) && snapshot.edges.length > 0)
        || (Array.isArray(snapshot.groups) && snapshot.groups.length > 0)
      ),
  );
}

function broadcast(room, payload, exceptSocket, canvasId) {
  const message = JSON.stringify(payload);
  for (const client of room.values()) {
    if (client.socket === exceptSocket || client.socket.readyState !== WebSocket.OPEN) continue;
    client.socket.send(message);
  }
  // 跨实例广播：publish 到 Redis（若配置），让其他 API 实例的客户端也能收到
  if (canvasId) {
    getBroadcastAdapter().publish(canvasId, payload).catch(() => {});
  }
}

// Yjs 更新批量广播：将 16ms 内的多次更新合并为每客户端一次发送，
// 将 N 用户 × N-1 发送降低为 N 次发送。
const YJS_BATCH_INTERVAL_MS = 16;
const pendingYjsBatches = new Map(); // canvasId -> { items: [{update, exceptSocket}], timer }

function scheduleYjsBatch(canvasId) {
  const pending = pendingYjsBatches.get(canvasId);
  if (!pending || pending.timer) return;
  pending.timer = setTimeout(flushYjsBatch, YJS_BATCH_INTERVAL_MS, canvasId);
}

function flushYjsBatch(canvasId) {
  const pending = pendingYjsBatches.get(canvasId);
  if (!pending) return;
  pendingYjsBatches.delete(canvasId);
  const room = getRoom(canvasId);
  if (!room || !pending.items.length) return;
  const items = pending.items;
  // 预解码所有更新，避免在每个客户端上重复解码
  const decodedItems = items
    .map((item) => ({ update: decodeYUpdate(item.update), exceptSocket: item.exceptSocket }))
    .filter((item) => item.update);
  if (!decodedItems.length) return;
  for (const client of room.values()) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    const others = decodedItems.filter((item) => item.exceptSocket !== client.socket);
    if (!others.length) continue;
    const merged = others.length === 1
      ? others[0].update
      : Y.mergeUpdates(others.map((item) => item.update));
    client.socket.send(JSON.stringify({
      type: "yjs:update",
      update: encodeYUpdate(merged),
      sourceUserId: "server",
    }));
  }
  // 跨实例广播：合并所有更新后 publish 到 Redis（远端客户端无需排除任何本地 socket）
  const allUpdates = decodedItems.map((item) => item.update);
  if (allUpdates.length) {
    const mergedForRemote = allUpdates.length === 1
      ? allUpdates[0]
      : Y.mergeUpdates(allUpdates);
    getBroadcastAdapter().publish(canvasId, {
      type: "yjs:update",
      update: encodeYUpdate(mergedForRemote),
      sourceUserId: "server",
    }).catch(() => {});
  }
}

function broadcastPresence(canvasId) {
  const room = getRoom(canvasId);
  broadcast(room, { type: "presence:list", users: serializePeers(room) }, null, canvasId);
}

function broadcastAwarenessRemove(room, client, canvasId) {
  if (!client?.awareness) return;
  broadcast(room, {
    type: "awareness:remove",
    clientId: client.awareness.clientId,
    userId: client.awareness.state?.user?.id,
  }, client.socket, canvasId);
}

export function notifyCanvasAccessRevoked(canvasId, userId) {
  const revokedUserId = String(userId || "");
  getBroadcastAdapter().publish(canvasId, { type: "access:revoked", userId: revokedUserId }).catch(() => {});
  const room = rooms.get(canvasId);
  if (!room) return;
  const message = JSON.stringify({ type: "access:revoked", userId: revokedUserId });
  for (const [clientId, client] of room.entries()) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    client.socket.send(message);
    const clientUserId = String(client.presence?.id || clientId).split(":")[0];
    if (clientUserId === revokedUserId) {
      setTimeout(() => client.socket.close(1008, "canvas access revoked"), 25);
    }
  }
}

function getRoomSnapshot(canvasId) {
  return roomSnapshots.get(canvasId);
}

async function getRoomYDoc(canvasId) {
  if (!roomYDocs.has(canvasId)) {
    const persistence = await getCanvasYjsPersistenceDirect(canvasId);
    roomYDocs.set(canvasId, buildYDocFromPersistence(persistence));
  }
  return roomYDocs.get(canvasId);
}

function setRoomSnapshot(canvasId, snapshot, version, sourceUserId) {
  if (!snapshot || typeof snapshot !== "object") return;
  const current = getRoomSnapshot(canvasId);
  const nextVersion = Number(version || Date.now());
  if (current && current.version > nextVersion) return;
  roomSnapshots.set(canvasId, {
    snapshot,
    version: nextVersion,
    sourceUserId,
  });
}

export function createYjsSyncPayload(doc, encodedStateVector) {
  const stateVector = decodeYUpdate(encodedStateVector);
  const update = stateVector ? Y.encodeStateAsUpdate(doc, stateVector) : Y.encodeStateAsUpdate(doc);
  return {
    type: "yjs:sync",
    update: encodeYUpdate(update),
    stateVector: encodeYUpdate(Y.encodeStateVector(doc)),
    sourceUserId: "server",
  };
}

export function applyEncodedYUpdate(doc, encodedUpdate, origin = "test") {
  const update = decodeYUpdate(encodedUpdate);
  if (!update) return false;
  Y.applyUpdate(doc, update, origin);
  return true;
}

export function attachCollaborationServer(server) {
  const wss = new WebSocketServer({ server, path: "/api/collaboration" });

  // 注册本地广播函数：Redis 适配器收到远端消息时调用此函数广播给本实例的客户端
  setLocalBroadcast((canvasId, payload, exceptSocketId) => {
    const room = getRoom(canvasId);
    if (!room) return;
    const message = JSON.stringify(payload);
    for (const client of room.values()) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (exceptSocketId && client.socket === exceptSocketId) continue;
      client.socket.send(message);
    }
  });

  wss.on("connection", async (socket, request) => {
    const url = new URL(request.url || "/", "http://localhost");
    const canvasId = url.searchParams.get("canvasId") || "local";
    const token = String(url.searchParams.get("token") || "");
    const tokenUser = token ? await getUserByAuthTokenHash(hashToken(token)).catch(() => null) : null;
    const requestUserId = tokenUser?.id || String(url.searchParams.get("userId") || "");
    const access = await getCanvasAccess(canvasId, requestUserId).catch(() => null);
    if (!requestUserId || !access?.allowed) {
      socket.close(1008, "canvas access denied");
      return;
    }
    const room = getRoom(canvasId);
    let clientId = "";

    const handleMessage = async (raw) => {
      const payload = safeJsonParse(raw.toString());
      if (!payload || typeof payload !== "object") return;

      if (payload.type === "presence:join") {
        clientId = String(payload.user?.id || requestUserId || crypto.randomUUID());
        room.set(clientId, {
          socket,
          joinedAt: Date.now(),
          presence: {
            id: clientId,
            name: String(payload.user?.name || "协作者"),
            color: String(payload.user?.color || "#8b6cff"),
            cursor: null,
            selectedNodeIds: [],
            editingNodeId: null,
            lastActiveAt: new Date().toISOString(),
          },
          awareness: null,
        });
        socket.send(JSON.stringify({ type: "presence:list", users: serializePeers(room) }));
        socket.send(JSON.stringify({ type: "awareness:list", states: serializeAwarenessStates(room) }));
        const latestSnapshot = getRoomSnapshot(canvasId);
        if (latestSnapshot) {
          socket.send(JSON.stringify({
            type: "snapshot:update",
            snapshot: latestSnapshot.snapshot,
            version: latestSnapshot.version,
            sourceUserId: latestSnapshot.sourceUserId,
          }));
        }
        broadcast(room, { type: "snapshot:request", requesterId: clientId }, socket, canvasId);
        broadcastPresence(canvasId);
        return;
      }

      if (!clientId || !room.has(clientId)) return;
      if (payload.type === "awareness:update") {
        const client = room.get(clientId);
        const awareness = sanitizeAwarenessWireState(payload.state, client.presence);
        if (!awareness) return;
        client.awareness = awareness;
        if (awareness.state) {
          client.presence = {
            ...client.presence,
            ...awareness.state.user,
            cursor: awareness.state.cursor,
            selectedNodeIds: awareness.state.selectedNodeIds,
            editingNodeId: awareness.state.editingNodeId,
            lastActiveAt: awareness.state.lastActiveAt,
          };
        }
        broadcast(room, {
          type: "awareness:update",
          state: awareness,
          sourceUserId: clientId,
        }, socket, canvasId);
        broadcast(room, { type: "presence:update", user: client.presence }, socket, canvasId);
        return;
      }

      if (payload.type === "snapshot:update") {
        if (!["owner", "editor"].includes(access.role)) return;
        const version = Number(payload.version || Date.now());
        const currentSnapshot = getRoomSnapshot(canvasId);
        const client = room.get(clientId);
        const isRecentlyJoined = client?.joinedAt && Date.now() - client.joinedAt < 2000;
        if (
          !hasSnapshotContent(payload.snapshot)
          && currentSnapshot
          && hasSnapshotContent(currentSnapshot.snapshot)
          && isRecentlyJoined
        ) {
          return;
        }
        setRoomSnapshot(canvasId, payload.snapshot, version, clientId);
        broadcast(room, {
          type: "snapshot:update",
          snapshot: payload.snapshot,
          version,
          sourceUserId: clientId,
        }, socket, canvasId);
        return;
      }

      if (payload.type === "yjs:update") {
        if (!["owner", "editor"].includes(access.role)) return;
        const ydoc = await getRoomYDoc(canvasId);
        if (!applyEncodedYUpdate(ydoc, payload.update, clientId)) return;
        persistYjsUpdate(canvasId, payload.update, { doc: ydoc }).catch((error) => {
          console.error("failed to persist yjs update", error);
        });
        // 批量广播：合并 16ms 内的多次更新，降低 WebSocket 发送次数
        if (!pendingYjsBatches.has(canvasId)) {
          pendingYjsBatches.set(canvasId, { items: [], timer: null });
        }
        pendingYjsBatches.get(canvasId).items.push({
          update: payload.update,
          exceptSocket: socket,
        });
        scheduleYjsBatch(canvasId);
        return;
      }

      if (payload.type === "yjs:state-vector") {
        const ydoc = await getRoomYDoc(canvasId);
        const syncPayload = createYjsSyncPayload(ydoc, payload.stateVector);
        socket.send(JSON.stringify(syncPayload));
        return;
      }

      const client = room.get(clientId);
      client.presence = {
        ...client.presence,
        ...(payload.presence || {}),
        id: clientId,
        lastActiveAt: new Date().toISOString(),
      };
      broadcast(room, { type: "presence:update", user: client.presence }, socket, canvasId);
    };

    socket.on("message", (raw) => {
      handleMessage(raw).catch((error) => {
        console.error("collaboration message handling failed", error);
      });
    });

    socket.on("close", () => {
      if (!clientId) return;
      const client = room.get(clientId);
      broadcastAwarenessRemove(room, client, canvasId);
      room.delete(clientId);
      broadcastPresence(canvasId);
      if (room.size === 0) {
        rooms.delete(canvasId);
        // 清理该房间的待发送批量更新，避免定时器泄漏
        const pending = pendingYjsBatches.get(canvasId);
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          pendingYjsBatches.delete(canvasId);
        }
      }
    });
  });

  return wss;
}

export async function listCanvasYjsHistory(canvasId) {
  const db = await readJson();
  return listCanvasYjsSnapshots(db, canvasId);
}

export async function getCanvasYjsHistorySnapshot(canvasId, snapshotId) {
  const db = await readJson();
  return getCanvasYjsSnapshotDetail(db, canvasId, snapshotId);
}

export async function compactCanvasYDoc(canvasId) {
  const doc = await getRoomYDoc(canvasId);
  return saveYjsSnapshot(canvasId, doc);
}
