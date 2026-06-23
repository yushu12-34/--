import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { readJson } from "../db.js";
import {
  decodeYUpdate,
  encodeYUpdate,
  getCanvasYjsSnapshotDetail,
  listCanvasYjsSnapshots,
  persistYjsUpdate,
  restoreYDocFromDb,
  saveYjsSnapshot,
} from "./yjsPersistenceService.js";

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

function broadcast(room, payload, exceptSocket) {
  const message = JSON.stringify(payload);
  for (const client of room.values()) {
    if (client.socket === exceptSocket || client.socket.readyState !== client.socket.OPEN) continue;
    client.socket.send(message);
  }
}

function broadcastPresence(canvasId) {
  const room = getRoom(canvasId);
  broadcast(room, { type: "presence:list", users: serializePeers(room) });
}

function broadcastAwarenessRemove(room, client) {
  if (!client?.awareness) return;
  broadcast(room, {
    type: "awareness:remove",
    clientId: client.awareness.clientId,
    userId: client.awareness.state?.user?.id,
  }, client.socket);
}

function getRoomSnapshot(canvasId) {
  return roomSnapshots.get(canvasId);
}

async function getRoomYDoc(canvasId) {
  if (!roomYDocs.has(canvasId)) {
    const db = await readJson();
    roomYDocs.set(canvasId, restoreYDocFromDb(db, canvasId));
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

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url || "/", "http://localhost");
    const canvasId = url.searchParams.get("canvasId") || "local";
    const room = getRoom(canvasId);
    let clientId = "";

    const handleMessage = async (raw) => {
      const payload = safeJsonParse(raw.toString());
      if (!payload || typeof payload !== "object") return;

      if (payload.type === "presence:join") {
        clientId = String(payload.user?.id || crypto.randomUUID());
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
        broadcast(room, { type: "snapshot:request", requesterId: clientId }, socket);
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
        }, socket);
        broadcast(room, { type: "presence:update", user: client.presence }, socket);
        return;
      }

      if (payload.type === "snapshot:update") {
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
        }, socket);
        return;
      }

      if (payload.type === "yjs:update") {
        const ydoc = await getRoomYDoc(canvasId);
        if (!applyEncodedYUpdate(ydoc, payload.update, clientId)) return;
        persistYjsUpdate(canvasId, payload.update, { doc: ydoc }).catch((error) => {
          console.error("failed to persist yjs update", error);
        });
        broadcast(room, {
          type: "yjs:update",
          update: payload.update,
          sourceUserId: clientId,
        }, socket);
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
      broadcast(room, { type: "presence:update", user: client.presence }, socket);
    };

    socket.on("message", (raw) => {
      handleMessage(raw).catch((error) => {
        console.error("collaboration message handling failed", error);
      });
    });

    socket.on("close", () => {
      if (!clientId) return;
      const client = room.get(clientId);
      broadcastAwarenessRemove(room, client);
      room.delete(clientId);
      broadcastPresence(canvasId);
      if (room.size === 0) rooms.delete(canvasId);
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
