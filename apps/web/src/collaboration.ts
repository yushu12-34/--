import type { CanvasSnapshot } from "./types";
import { createCollaborationAwarenessBridge, type CollaborationAwarenessWireState } from "./collaborationAwareness";
import { getApiBaseUrl, getAuthToken } from "./api";

export interface CollaborationUser {
  id: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number } | null;
  selectedNodeIds?: string[];
  editingNodeId?: string | null;
  lastActiveAt?: string;
}

export type CollaborationStatus = "connecting" | "connected" | "reconnecting" | "offline";

type CollaborationMessage =
  | { type: "awareness:list"; states: CollaborationAwarenessWireState[] }
  | { type: "awareness:update"; state: CollaborationAwarenessWireState; sourceUserId?: string }
  | { type: "awareness:remove"; clientId: number; userId?: string }
  | { type: "presence:list"; users: CollaborationUser[] }
  | { type: "presence:update"; user: CollaborationUser }
  | { type: "snapshot:update"; snapshot: CanvasSnapshot; version: number; sourceUserId?: string }
  | { type: "snapshot:request"; requesterId?: string }
  | { type: "yjs:state-vector"; stateVector: string }
  | { type: "yjs:sync"; update: string; stateVector?: string; sourceUserId?: string }
  | { type: "yjs:update"; update: string; sourceUserId?: string }
  | { type: "access:revoked"; userId?: string };

interface CollaborationClientOptions {
  canvasId: string;
  user: CollaborationUser;
  onUsers: (users: CollaborationUser[]) => void;
  getSnapshot?: () => CanvasSnapshot | null;
  onSnapshot?: (snapshot: CanvasSnapshot, version: number, sourceUserId?: string) => void;
  onYjsUpdate?: (update: Uint8Array, sourceUserId?: string) => void;
  getYjsStateVector?: () => Uint8Array | null;
  getYjsDiffUpdate?: (stateVector: Uint8Array) => Uint8Array | null;
  onStatus?: (status: CollaborationStatus) => void;
  onAccessRevoked?: () => void;
}

function getWsBaseUrl() {
  const configured = import.meta.env.VITE_COLLAB_WS_URL;
  if (configured) return String(configured).replace(/\/+$/, "");
  const apiBase = getApiBaseUrl();
  if (/^https?:\/\//i.test(apiBase)) {
    return apiBase.replace(/^http/i, "ws").replace(/\/api\/?$/, "/api/collaboration");
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:8787/api/collaboration`;
}

function hasSnapshotContent(snapshot: CanvasSnapshot | null | undefined) {
  return Boolean(snapshot && ((snapshot.nodes?.length || 0) > 0 || (snapshot.edges?.length || 0) > 0 || (snapshot.groups?.length || 0) > 0));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function createSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createCollaborationClient({ canvasId, user, onUsers, getSnapshot, onSnapshot, onYjsUpdate, getYjsStateVector, getYjsDiffUpdate, onStatus, onAccessRevoked }: CollaborationClientOptions) {
  const sessionUser = { ...user, id: `${user.id}:${createSessionId()}` };
  const awarenessBridge = createCollaborationAwarenessBridge(sessionUser);
  let users = new Map<string, CollaborationUser>();
  let socket: WebSocket | null = null;
  let closedByClient = false;
  let reconnectTimer = 0;
  let joinTimer = 0;
  let reconnectAttempt = 0;
  let lastPresence: Partial<CollaborationUser> = {};
  let joined = false;

  const emitUsers = () => onUsers([...users.values()].filter((item) => item.id !== sessionUser.id));
  const send = (payload: unknown) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };
  const sendCurrentSnapshot = () => {
    const snapshot = getSnapshot?.();
    if (hasSnapshotContent(snapshot)) {
      send({ type: "snapshot:update", snapshot, version: Date.now() });
    }
  };
  const sendJoinHandshake = () => {
    send({ type: "presence:join", user: sessionUser });
    send({ type: "awareness:update", state: awarenessBridge.getLocalWireState() });
    if (Object.keys(lastPresence).length) send({ type: "presence:update", presence: lastPresence });
    const stateVector = getYjsStateVector?.();
    if (stateVector) send({ type: "yjs:state-vector", stateVector: bytesToBase64(stateVector) });
  };

  const connect = () => {
    onStatus?.(reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const token = getAuthToken();
    const params = new URLSearchParams({ canvasId });
    if (token) params.set("token", token);
    else params.set("userId", user.id.split(":")[0] || user.id);
    socket = new WebSocket(`${getWsBaseUrl()}?${params.toString()}`);

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      joined = false;
      onStatus?.("connected");
      sendJoinHandshake();
      window.clearInterval(joinTimer);
      joinTimer = window.setInterval(() => {
        if (joined) {
          window.clearInterval(joinTimer);
          return;
        }
        sendJoinHandshake();
      }, 500);
    });

    socket.addEventListener("message", (event) => {
      let payload: CollaborationMessage;
      try {
        payload = JSON.parse(String(event.data)) as CollaborationMessage;
      } catch {
        return;
      }
      if (payload.type === "presence:list") {
        if (!joined) {
          joined = true;
          window.clearInterval(joinTimer);
          window.setTimeout(sendCurrentSnapshot, 80);
        }
        users = new Map(payload.users.map((item) => [item.id, item]));
        emitUsers();
      }
      if (payload.type === "presence:update") {
        users.set(payload.user.id, payload.user);
        emitUsers();
      }
      if (payload.type === "awareness:list") {
        for (const state of payload.states) {
          const user = awarenessBridge.applyRemoteWireState(state);
          if (user) users.set(user.id, user);
        }
        emitUsers();
      }
      if (payload.type === "awareness:update") {
        const user = awarenessBridge.applyRemoteWireState(payload.state);
        if (user) {
          users.set(user.id, user);
          emitUsers();
        }
      }
      if (payload.type === "awareness:remove") {
        const userId = payload.userId || awarenessBridge.removeRemoteClient(payload.clientId);
        if (userId) {
          users.delete(userId);
          emitUsers();
        }
      }
      if (payload.type === "snapshot:update") {
        onSnapshot?.(payload.snapshot, payload.version, payload.sourceUserId);
      }
      if (payload.type === "snapshot:request") {
        window.setTimeout(sendCurrentSnapshot, 80);
      }
      if (payload.type === "yjs:sync" || payload.type === "yjs:update") {
        if (payload.sourceUserId !== sessionUser.id) onYjsUpdate?.(base64ToBytes(payload.update), payload.sourceUserId);
        if (payload.type === "yjs:sync" && payload.stateVector) {
          const diffUpdate = getYjsDiffUpdate?.(base64ToBytes(payload.stateVector));
          if (diffUpdate) send({ type: "yjs:update", update: bytesToBase64(diffUpdate) });
        }
      }
      if (payload.type === "access:revoked") {
        const revokedUserId = String(payload.userId || "").split(":")[0];
        const currentUserId = String(user.id || "").split(":")[0];
        if (!revokedUserId || revokedUserId === currentUserId) {
          closedByClient = true;
          onStatus?.("offline");
          onAccessRevoked?.();
          socket?.close();
        }
      }
    });

    socket.addEventListener("close", () => {
      window.clearInterval(joinTimer);
      joined = false;
      users.clear();
      emitUsers();
      if (closedByClient) {
        onStatus?.("offline");
        return;
      }
      reconnectAttempt += 1;
      onStatus?.("reconnecting");
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, Math.min(1000 * reconnectAttempt, 5000));
    });

    socket.addEventListener("error", () => {
      onStatus?.("offline");
      socket?.close();
    });
  };

  connect();

  return {
    update(presence: Partial<CollaborationUser>) {
      lastPresence = { ...lastPresence, ...presence };
      awarenessBridge.patchLocalState(lastPresence);
      send({ type: "awareness:update", state: awarenessBridge.getLocalWireState() });
      send({ type: "presence:update", presence });
    },
    sendSnapshot(snapshot: CanvasSnapshot, version: number) {
      send({ type: "snapshot:update", snapshot, version });
    },
    sendYjsUpdate(update: Uint8Array) {
      send({ type: "yjs:update", update: bytesToBase64(update) });
    },
    requestYjsSync(stateVector: Uint8Array) {
      send({ type: "yjs:state-vector", stateVector: bytesToBase64(stateVector) });
    },
    close() {
      closedByClient = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(joinTimer);
      awarenessBridge.destroy();
      socket?.close();
      socket = null;
    },
  };
}
