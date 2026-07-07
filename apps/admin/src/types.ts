export type NodeRuntimeStatus =
  | "idle"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ErrorCategory = "connection" | "auth" | "timeout" | "non_json" | "field_mapping" | "model_error" | "other";

export type SystemEventLevel = "info" | "warning" | "error";
export type SystemEventCategory = "system" | "api" | "security" | "task" | "model" | "backup";

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
  timeoutMs?: number;
  pollIntervalMs?: number;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  // 后端富化字段
  modelDisplayName?: string;
  providerName?: string;
  durationMs?: number;
  inputSummary?: string;
}

export interface SystemEventRecord {
  id: string;
  level: SystemEventLevel;
  category: SystemEventCategory;
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface SystemEventSummary {
  total: number;
  byLevel: Record<SystemEventLevel, number>;
  byCategory: Record<SystemEventCategory, number>;
  latestErrorAt: string | null;
  latestWarningAt: string | null;
}

export interface AdminUser {
  id: string;
  name: string;
  email?: string;
  hasPassword?: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  projectCount?: number;
  ownedCanvasCount?: number;
  sharedCanvasCount?: number;
}

export interface AdminOverview {
  generatedAt: string;
  tasks: {
    total: number;
    byStatus: Record<NodeRuntimeStatus, number>;
    successRate: number;
    failureRate: number;
    active: number;
    completed: number;
    averageDurationMs: number | null;
    byErrorCategory: Record<ErrorCategory, number>;
  };
  modelRuntime: {
    providers: {
      total: number;
      enabled: number;
      disabled: number;
    };
    models: {
      total: number;
      enabled: number;
      disabled: number;
      byType: Record<string, number>;
    };
  };
  events: {
    summary: SystemEventSummary;
    recentSignals: SystemEventRecord[];
  };
  backup: {
    latest: SystemEventRecord | null;
    latestError: SystemEventRecord | null;
    total: number;
    errors: number;
    warnings: number;
  };
  recentFailedTasks: AITask[];
}
