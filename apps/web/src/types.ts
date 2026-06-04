export type MediaType = "text" | "image" | "video" | "audio";

export type NodeRuntimeStatus =
  | "idle"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkflowNode {
  id: string;
  type: string;
  title: string;
  position: {
    x: number;
    y: number;
  };
  data: Record<string, unknown>;
  runtime: {
    status: NodeRuntimeStatus;
    taskId?: string;
    progress?: number;
    error?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PortDefinition {
  id: string;
  name: string;
  direction: "input" | "output";
  mediaType: MediaType;
  accepts?: MediaType[];
  required?: boolean;
  multiple?: boolean;
  maxConnections?: number;
}

export interface NodeDefinition {
  type: string;
  name: string;
  category: "input" | "generate" | "utility" | "output";
  description?: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  defaultData: Record<string, unknown>;
  configurable?: boolean;
}

export interface WorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
}

export interface CanvasSnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups?: WorkflowGroup[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
}

export interface WorkflowGroup {
  id: string;
  title: string;
  nodeIds: string[];
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  dragging?: boolean;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasRecord {
  id: string;
  projectId: string;
  name: string;
  snapshot: CanvasSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface AssetRecord {
  id: string;
  projectId: string;
  type: "image" | "audio" | "video";
  url: string;
  thumbnailUrl?: string;
  mimeType: string;
  size: number;
  source: "upload" | "ai-generated";
  name?: string;
  createdBy: string;
  createdAt: string;
}

export interface AITask {
  id: string;
  projectId: string;
  canvasId: string;
  nodeId: string;
  modelId: string;
  type: "image.generate" | "audio.generate" | "video.generate";
  status: NodeRuntimeStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  progress?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
