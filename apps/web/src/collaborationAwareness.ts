import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { CollaborationUser } from "./collaboration";

export interface CollaborationAwarenessState {
  user: Pick<CollaborationUser, "id" | "name" | "color">;
  cursor?: CollaborationUser["cursor"];
  selectedNodeIds?: string[];
  editingNodeId?: string | null;
  lastActiveAt?: string;
}

export interface CollaborationAwarenessWireState {
  clientId: number;
  state: CollaborationAwarenessState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeCursor(value: unknown): CollaborationUser["cursor"] {
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function sanitizeStringList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export function awarenessStateToUser(state: CollaborationAwarenessState | null | undefined): CollaborationUser | null {
  if (!state?.user?.id) return null;
  return {
    id: String(state.user.id),
    name: String(state.user.name || "Collaborator"),
    color: String(state.user.color || "#8b6cff"),
    cursor: sanitizeCursor(state.cursor),
    selectedNodeIds: sanitizeStringList(state.selectedNodeIds),
    editingNodeId: state.editingNodeId ? String(state.editingNodeId) : null,
    lastActiveAt: String(state.lastActiveAt || new Date().toISOString()),
  };
}

export function createCollaborationAwarenessBridge(user: CollaborationUser) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const remoteClientUsers = new Map<number, string>();

  const makeState = (presence: Partial<CollaborationUser> = {}): CollaborationAwarenessState => ({
    user: {
      id: user.id,
      name: presence.name || user.name,
      color: presence.color || user.color,
    },
    cursor: presence.cursor === undefined ? null : presence.cursor,
    selectedNodeIds: presence.selectedNodeIds || [],
    editingNodeId: presence.editingNodeId ?? null,
    lastActiveAt: new Date().toISOString(),
  });

  awareness.setLocalState(makeState(user));

  return {
    awareness,
    clientId: awareness.clientID,
    getLocalWireState(): CollaborationAwarenessWireState {
      return {
        clientId: awareness.clientID,
        state: awareness.getLocalState() as CollaborationAwarenessState | null,
      };
    },
    patchLocalState(presence: Partial<CollaborationUser>) {
      const current = awareness.getLocalState() as CollaborationAwarenessState | null;
      awareness.setLocalState({
        ...(current || makeState()),
        ...presence,
        user: {
          id: user.id,
          name: presence.name || current?.user?.name || user.name,
          color: presence.color || current?.user?.color || user.color,
        },
        lastActiveAt: new Date().toISOString(),
      });
    },
    applyRemoteWireState(wireState: CollaborationAwarenessWireState) {
      const userFromState = awarenessStateToUser(wireState.state);
      if (!userFromState) {
        remoteClientUsers.delete(wireState.clientId);
        return null;
      }
      remoteClientUsers.set(wireState.clientId, userFromState.id);
      return userFromState;
    },
    removeRemoteClient(clientId: number) {
      const userId = remoteClientUsers.get(clientId);
      remoteClientUsers.delete(clientId);
      return userId || null;
    },
    destroy() {
      awareness.destroy();
      doc.destroy();
    },
  };
}
