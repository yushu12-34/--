export type NodeRuntimeStatus =
  | "idle"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

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
