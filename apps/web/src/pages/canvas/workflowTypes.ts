import type { Node, Edge } from "@xyflow/react";
import type { AssetRecord, MediaType, WorkflowNode } from "../../types";

export interface ConnectedInputs {
  texts: string[];
  images: string[];
  audios: string[];
  videos: string[];
}

export interface RelatedNodeSummary {
  id: string;
  title: string;
  type: string;
  mediaType?: MediaType;
  hasValue?: boolean;
}

export type PublicParamType = "string" | "number" | "boolean";
export type PublicParamControl = "select" | "input" | "checkbox";

export interface PublicParamConfig {
  key: string;
  label: string;
  type: PublicParamType;
  control: PublicParamControl;
  options: unknown[];
  defaultValue?: unknown;
  required: boolean;
}

export interface WorkflowNodeData extends Record<string, unknown> {
  workflow: WorkflowNode;
  onPatch: (nodeId: string, patch: Partial<WorkflowNode>, options?: { markLocalEdit?: boolean }) => void;
  onRun: (nodeId: string, options?: { force?: boolean }) => Promise<boolean>;
  onDelete: (nodeId: string) => void;
  onDuplicate: (nodeId: string) => void;
  onCollapse: (nodeId: string) => void;
  onInspectInputs: (nodeId: string) => void;
  onInspectOutputs: (nodeId: string) => void;
  canRun: boolean;
  readyMessage?: string;
  inputSignature?: string;
  resultStale?: boolean;
  connectedInputs: ConnectedInputs;
  upstreamNodes: RelatedNodeSummary[];
  downstreamNodes: RelatedNodeSummary[];
  highlightRole?: "trace-target" | "trace-upstream" | "trace-downstream";
  assets: AssetRecord[];
  models: Array<Record<string, unknown>>;
  onUploadAsset: (nodeId: string, file: File, type: "image" | "audio" | "video") => Promise<void>;
  onAddAssetAsNode: (nodeId: string, assetUrl: string) => void;
  onSaveResultAsset: (nodeId: string) => Promise<void>;
  onCopyResultUrl: (nodeId: string) => Promise<void>;
  onPreviewResult: (nodeId: string) => void;
  expanded: boolean;
}

export type WorkflowReactNode = Node<WorkflowNodeData, "workflow">;
export type WorkflowEdgeData = {
  onSelect: (edgeId: string) => void;
  selected: boolean;
  highlighted?: boolean;
  highlightMode?: "inputs" | "outputs";
};
export type WorkflowReactEdge = Edge<WorkflowEdgeData, "workflow">;

