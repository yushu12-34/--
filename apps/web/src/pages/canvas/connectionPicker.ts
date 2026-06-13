import { nodeDefinitions } from "../../nodeDefinitions.ts";
import type { MediaType, NodeDefinition, WorkflowEdge, WorkflowNode } from "../../types";
import { findPort, normalizePortId, validateConnection } from "../../workflowValidation.ts";

export type ConnectionDragHandleType = "source" | "target";
export const CONNECTION_PICKER_TEMP_NODE_ID = "__connection_picker_candidate__";

export interface ConnectionDragStart {
  nodeId: string;
  handleId: string;
  handleType: ConnectionDragHandleType;
}

export interface ConnectionPickerCandidate {
  nodeType: string;
  name: string;
  category: NodeDefinition["category"];
  mediaType?: MediaType;
  direction: "downstream" | "upstream";
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
}

export function getConnectionPickerCandidates(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  dragStart: ConnectionDragStart,
): ConnectionPickerCandidate[] {
  const anchorPort = findPort(nodes, dragStart.nodeId, dragStart.handleId);
  if (!anchorPort) return [];

  const handleType = dragStart.handleType;
  if (handleType === "source" && anchorPort.direction !== "output") return [];
  if (handleType === "target" && anchorPort.direction !== "input") return [];

  const results: ConnectionPickerCandidate[] = [];
  for (const definition of nodeDefinitions) {
    const candidate = createCandidateForDefinition(nodes, edges, dragStart, definition);
    if (candidate) results.push(candidate);
  }
  return results;
}

function createCandidateForDefinition(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  dragStart: ConnectionDragStart,
  definition: NodeDefinition,
): ConnectionPickerCandidate | null {
  const tempNode = makeTempNode(definition.type);
  const testNodes = [...nodes, tempNode];

  if (dragStart.handleType === "source") {
    for (const input of definition.inputs) {
      const sourcePortId = normalizePortId(dragStart.handleId);
      const targetPortId = input.id;
      const validation = validateConnection(testNodes, edges, {
        source: dragStart.nodeId,
        sourceHandle: sourcePortId,
        target: tempNode.id,
        targetHandle: targetPortId,
      });
      if (!validation.valid) continue;
      return {
        nodeType: definition.type,
        name: definition.name,
        category: definition.category,
        mediaType: definition.outputs[0]?.mediaType || input.mediaType,
        direction: "downstream",
        sourceNodeId: dragStart.nodeId,
        sourcePortId,
        targetNodeId: tempNode.id,
        targetPortId,
      };
    }
    return null;
  }

  if (definition.inputs.length > 0) return null;

  for (const output of definition.outputs) {
    const sourcePortId = output.id;
    const targetPortId = normalizePortId(dragStart.handleId);
    const validation = validateConnection(testNodes, edges, {
      source: tempNode.id,
      sourceHandle: sourcePortId,
      target: dragStart.nodeId,
      targetHandle: targetPortId,
    });
    if (!validation.valid) continue;
    return {
      nodeType: definition.type,
      name: definition.name,
      category: definition.category,
      mediaType: output.mediaType,
      direction: "upstream",
      sourceNodeId: tempNode.id,
      sourcePortId,
      targetNodeId: dragStart.nodeId,
      targetPortId,
    };
  }
  return null;
}

function makeTempNode(type: string): WorkflowNode {
  const timestamp = "1970-01-01T00:00:00.000Z";
  return {
    id: CONNECTION_PICKER_TEMP_NODE_ID,
    type,
    title: type,
    position: { x: 0, y: 0 },
    data: {},
    runtime: { status: "idle", progress: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
