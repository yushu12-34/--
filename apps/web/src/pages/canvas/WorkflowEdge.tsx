import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { WorkflowReactEdge } from "./workflowTypes";

export function WorkflowEdge(props: EdgeProps<WorkflowReactEdge>) {
  const [edgePath] = getBezierPath(props);
  const highlighted = Boolean(props.data?.highlighted);
  const highlightColor = props.data?.highlightMode === "outputs"
    ? "rgba(248, 91, 189, 0.95)"
    : "rgba(54, 209, 220, 0.95)";
  return (
    <>
      <BaseEdge path={edgePath} markerEnd={props.markerEnd} style={{ ...props.style, opacity: highlighted ? 0.38 : 1 }} />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="workflow-edge-hit-area"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          props.data?.onSelect(props.id);
        }}
      />
      {highlighted && (
        <BaseEdge
          path={edgePath}
          style={{
            stroke: highlightColor,
            strokeWidth: 4,
            filter: `drop-shadow(0 0 8px ${highlightColor})`,
          }}
        />
      )}
      {props.data?.selected && <BaseEdge path={edgePath} style={{ stroke: "rgba(141, 124, 255, 0.95)", strokeWidth: 3 }} />}
    </>
  );
}

export const edgeTypes = { workflow: WorkflowEdge };
