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
    inputSignature?: string;
    cacheHit?: boolean;
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
  runtime?: {
    status: "idle" | "running" | "succeeded" | "failed";
    total?: number;
    completed?: number;
    failed?: number;
    skipped?: number;
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
  canvasCount?: number;
  assetCount?: number;
  historyUpdateCount?: number;
  historySnapshotCount?: number;
  lastCanvasUpdatedAt?: string;
}

export interface UserRecord {
  id: string;
  name: string;
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

export interface YjsSnapshotRecord {
  id: string;
  canvasId: string;
  clock: number;
  updateCount: number;
  updateSize: number;
  createdAt: string;
}

export interface YjsSnapshotDetail {
  record: YjsSnapshotRecord;
  snapshot: CanvasSnapshot;
  summary: {
    nodes: number;
    edges: number;
    groups: number;
  };
}

export interface ProjectBundle {
  version: number;
  exportedAt: string;
  project: ProjectRecord;
  canvases: CanvasRecord[];
  assets: AssetRecord[];
  workflowUpdates?: Array<Record<string, unknown>>;
  workflowSnapshots?: Array<Record<string, unknown>>;
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
  timeoutMs?: number;
  pollIntervalMs?: number;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
}
