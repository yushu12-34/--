export type NodeRuntimeStatus =
  | "idle"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ErrorCategory = "connection" | "auth" | "timeout" | "non_json" | "field_mapping" | "model_error" | "other";

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
  errorCategory?: ErrorCategory;
  progress?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // 后端富化字段
  modelDisplayName?: string;
  providerName?: string;
  durationMs?: number;
  inputSummary?: string;
}
