import type { CollaborationUser } from "../../collaboration";
import type { WorkflowGroup, WorkflowNode } from "../../types";
import { getGroupBounds } from "./canvasUtils";

export function CollaborationOverlay({ users, nodes }: { users: CollaborationUser[]; nodes: WorkflowNode[] }) {
  return (
    <div className="collaboration-layer">
      {users.map((user) => (
        <div key={user.id}>
          {user.cursor && (
            <div className="collaboration-cursor" style={{ left: user.cursor.x, top: user.cursor.y, color: user.color }}>
              <span />
              <em>{user.name}</em>
            </div>
          )}
          {user.editingNodeId && nodes.some((node) => node.id === user.editingNodeId) && (() => {
            const node = nodes.find((item) => item.id === user.editingNodeId)!;
            return (
              <div className="collaboration-node-badge" style={{ left: node.position.x + 12, top: node.position.y - 26, background: user.color }}>
                {user.name} 正在编辑
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}

export function GroupOverlay({
  groups,
  nodes,
  zoom,
  onUngroup,
  onRename,
  onRun,
  onMove,
}: {
  groups: WorkflowGroup[];
  nodes: WorkflowNode[];
  zoom: number;
  onUngroup: (groupId: string) => void;
  onRename: (groupId: string) => void;
  onRun: (group: WorkflowGroup) => void;
  onMove: (groupId: string, delta: { x: number; y: number }, phase: "start" | "move" | "end") => void;
}) {
  return (
    <div className="group-layer">
      {groups.map((group) => {
        const bounds = group.bounds || getGroupBounds(nodes.filter((node) => group.nodeIds.includes(node.id)));
        return (
        <div
          key={group.id}
          className={`workflow-group ${group.dragging ? "dragging" : ""} ${group.runtime?.status || "idle"}`}
          style={{
            left: bounds.x,
            top: bounds.y,
            width: bounds.width,
            height: bounds.height,
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            event.preventDefault();
            event.stopPropagation();
            const start = { x: event.clientX, y: event.clientY };
            let latestDelta = { x: 0, y: 0 };
            onMove(group.id, latestDelta, "start");
            const onPointerMove = (moveEvent: PointerEvent) => {
              latestDelta = { x: (moveEvent.clientX - start.x) / zoom, y: (moveEvent.clientY - start.y) / zoom };
              onMove(group.id, latestDelta, "move");
            };
            const onPointerUp = () => {
              window.removeEventListener("pointermove", onPointerMove);
              onMove(group.id, latestDelta, "end");
            };
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp, { once: true });
          }}
        >
          <div className="group-toolbar">
            <span>{group.title}</span>
            {group.runtime?.status === "running" && <em>{group.runtime.completed || 0} / {group.runtime.total || 0}</em>}
            {group.runtime?.status === "failed" && <em>失败 {group.runtime.failed || 0} · 跳过 {group.runtime.skipped || 0}</em>}
            {group.runtime?.status === "succeeded" && <em>已完成</em>}
            <button title="运行组合工作流" onClick={() => onRun(group)}>▶</button>
            <button title="重命名组合" onClick={() => onRename(group.id)}>T</button>
            <button title="解除组合节点" onClick={() => onUngroup(group.id)}>✕</button>
          </div>
        </div>
      );
      })}
    </div>
  );
}

