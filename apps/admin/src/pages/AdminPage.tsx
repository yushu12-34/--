import { useEffect, useState } from "react";
import { cancelTask, createModel, createProvider, getOverview, getTask, listModels, listProviders, listSystemEvents, listTasks, retryTask, retryTasksBatch, testProvider, updateModel, updateProvider } from "../api";
import type { AdminOverview, AITask, ErrorCategory, NodeRuntimeStatus, SystemEventCategory, SystemEventLevel, SystemEventRecord, SystemEventSummary } from "../types";

interface ParamSchemaEntry {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  control: "select" | "input" | "checkbox";
  values: string;
  defaultValue: string;
  required: boolean;
  publicVisible: boolean;
}

interface AdapterConfig {
  kind: string;
  submitMethod: string;
  submitPath: string;
  requestTemplate: string;
  taskIdPath: string;
  pollMethod: string;
  taskPathTemplate: string;
  pollingTemplate: string;
  statusPath: string;
  successStatusValues: string;
  failureStatusValues: string;
  resultPath: string;
  b64Path: string;
  errorPath: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

const MODEL_TYPES = [
  { value: "text", label: "文本模型", icon: "Aa" },
  { value: "image", label: "图片模型", icon: "▣" },
  { value: "audio", label: "音频模型", icon: "♪" },
  { value: "video", label: "视频模型", icon: "▶" },
];

const DEFAULT_ADAPTER_CONFIG: AdapterConfig = {
  kind: "custom-http",
  submitMethod: "POST",
  submitPath: "/v1/images/generations",
  requestTemplate: JSON.stringify({
    prompt: "{prompt}",
    size: "{params.size}",
    aspect_ratio: "{params.aspect_ratio}",
    n: "{params.n}",
    response_format: "{params.response_format}",
    num_inference_steps: "{params.num_inference_steps}",
  }, null, 2),
  taskIdPath: "task_id",
  pollMethod: "GET",
  taskPathTemplate: "/v1/tasks/{task_id}",
  pollingTemplate: "",
  statusPath: "status",
  successStatusValues: "finished, succeeded, success, completed, done",
  failureStatusValues: "failed, failure, error, cancelled",
  resultPath: "data.0.url",
  b64Path: "data.0.b64_json",
  errorPath: "error",
  pollIntervalMs: 2000,
  timeoutMs: 120000,
};

const EMPTY_SYSTEM_EVENT_SUMMARY: SystemEventSummary = {
  total: 0,
  byLevel: { info: 0, warning: 0, error: 0 },
  byCategory: { system: 0, api: 0, security: 0, task: 0, model: 0, backup: 0 },
  latestErrorAt: null,
  latestWarningAt: null,
};

const EMPTY_ADMIN_OVERVIEW: AdminOverview = {
  generatedAt: "",
  tasks: {
    total: 0,
    byStatus: { idle: 0, pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
    successRate: 0,
    failureRate: 0,
    active: 0,
    completed: 0,
    averageDurationMs: null,
    byErrorCategory: { connection: 0, auth: 0, timeout: 0, non_json: 0, field_mapping: 0, model_error: 0, other: 0 },
  },
  modelRuntime: {
    providers: { total: 0, enabled: 0, disabled: 0 },
    models: { total: 0, enabled: 0, disabled: 0, byType: {} },
  },
  events: {
    summary: EMPTY_SYSTEM_EVENT_SUMMARY,
    recentSignals: [],
  },
  backup: {
    latest: null,
    latestError: null,
    total: 0,
    errors: 0,
    warnings: 0,
  },
  recentFailedTasks: [],
};

function parseParamSchema(schema: Record<string, unknown> | undefined): ParamSchemaEntry[] {
  if (!schema || typeof schema !== "object") return [];
  return Object.entries(schema).map(([key, config]) => {
    if (Array.isArray(config)) {
      return createParamEntry({
        key,
        values: config.join(", "),
        control: "select",
      });
    }
    if (config && typeof config === "object") {
      const record = config as Record<string, unknown>;
      const options = Array.isArray(record.options) ? record.options : Array.isArray(record.values) ? record.values : [];
      return createParamEntry({
        key,
        label: String(record.label || ""),
        type: isParamType(record.type) ? record.type : "string",
        control: isParamControl(record.control) ? record.control : options.length > 0 ? "select" : "input",
        values: options.join(", "),
        defaultValue: record.defaultValue === undefined ? "" : String(record.defaultValue),
        required: record.required === true,
        publicVisible: record.publicVisible !== false,
      });
    }
    return createParamEntry({ key, values: String(config) });
  });
}

function serializeParamSchema(entries: ParamSchemaEntry[]): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    const options = splitParamValues(entry.values);
    result[key] = {
      label: entry.label.trim() || key,
      type: entry.type,
      control: entry.control,
      required: entry.required,
      publicVisible: entry.publicVisible,
    };
    if (options.length > 0) result[key].options = options.map((value) => coerceParamValue(value, entry.type));
    if (entry.defaultValue.trim()) result[key].defaultValue = coerceParamValue(entry.defaultValue, entry.type);
  }
  return result;
}

function parseParamValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return value;
}

function serializeDefaultParams(entries: ParamSchemaEntry[], schemaEntries?: ParamSchemaEntry[]): Record<string, unknown> {
  const schemaByKey = new Map((schemaEntries || []).map((entry) => [entry.key.trim(), entry]));
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    const schema = schemaByKey.get(key);
    result[key] = schema ? coerceParamValue(entry.values, schema.type) : parseParamValue(entry.values);
  }
  return result;
}

function filterDefaultsBySchema(params: Record<string, unknown> | undefined, schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const keys = Object.keys(schema || {});
  if (!keys.length) return params || {};
  return Object.fromEntries(
    keys
      .filter((key) => Object.prototype.hasOwnProperty.call(params || {}, key))
      .map((key) => [key, params?.[key]]),
  );
}

function createParamEntry(partial: Partial<ParamSchemaEntry> = {}): ParamSchemaEntry {
  return {
    key: partial.key || "",
    label: partial.label || "",
    type: partial.type || "string",
    control: partial.control || "select",
    values: partial.values || "",
    defaultValue: partial.defaultValue || "",
    required: partial.required || false,
    publicVisible: partial.publicVisible !== false,
  };
}

function isParamType(value: unknown): value is ParamSchemaEntry["type"] {
  return value === "string" || value === "number" || value === "boolean";
}

function isParamControl(value: unknown): value is ParamSchemaEntry["control"] {
  return value === "select" || value === "input" || value === "checkbox";
}

function splitParamValues(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function coerceParamValue(value: string, type: ParamSchemaEntry["type"]): unknown {
  const trimmed = value.trim();
  if (type === "boolean") return trimmed === "true" || trimmed === "1" || trimmed === "是";
  if (type === "number") return trimmed === "" ? 0 : Number(trimmed);
  return value;
}

function parseJsonTemplate(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function templateToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function defaultRequestTemplateForAdapter(kind: string, defaultParams?: Record<string, unknown>): string {
  if (kind === "z-image" || kind === "z-image-turbo" || kind === "custom-http") {
    const params = Object.keys(defaultParams || {});
    return JSON.stringify({
      prompt: "{prompt}",
      ...Object.fromEntries(params.map((key) => [key, `{params.${key}}`])),
    }, null, 2);
  }
  return "";
}

function adapterListToString(value: unknown, fallback: string): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "string") return value;
  return fallback;
}

function splitAdapterList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function serializeAdapterConfig(config: AdapterConfig): Record<string, unknown> {
  const adapter: Record<string, unknown> = {
    kind: config.kind,
    submitMethod: config.submitMethod,
    submitPath: config.submitPath,
    requestTemplate: parseJsonTemplate(config.requestTemplate),
    taskIdPath: config.taskIdPath,
    pollMethod: config.pollMethod,
    taskPathTemplate: config.taskPathTemplate,
    pollingTemplate: parseJsonTemplate(config.pollingTemplate),
    statusPath: config.statusPath,
    successStatusValues: splitAdapterList(config.successStatusValues),
    failureStatusValues: splitAdapterList(config.failureStatusValues),
    resultPath: config.resultPath,
    b64Path: config.b64Path,
    errorPath: config.errorPath,
    pollIntervalMs: Number(config.pollIntervalMs || 2000),
    timeoutMs: Number(config.timeoutMs || 120000),
  };
  return Object.fromEntries(Object.entries(adapter).filter(([, value]) => value !== undefined && value !== ""));
}

function ParamSchemaRow({
  entry,
  index,
  publicRow = false,
  onUpdate,
  updateParamEntry,
  removeParamEntry,
}: {
  entry: ParamSchemaEntry;
  index: number;
  publicRow?: boolean;
  onUpdate: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>;
  updateParamEntry: (
    setter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>,
    index: number,
    field: keyof ParamSchemaEntry,
    value: string | boolean,
  ) => void;
  removeParamEntry: (setter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>, index: number) => void;
}) {
  return (
    <div className={`param-schema-row ${publicRow ? "public-param-schema-row" : ""}`}>
      <input
        value={entry.key}
        onChange={(event) => updateParamEntry(onUpdate, index, "key", event.target.value)}
        placeholder="参数名"
        aria-label="参数名"
      />
      <input
        value={entry.label}
        onChange={(event) => updateParamEntry(onUpdate, index, "label", event.target.value)}
        placeholder="显示名"
        aria-label="显示名"
      />
      <select
        value={entry.type}
        onChange={(event) => updateParamEntry(onUpdate, index, "type", event.target.value)}
        aria-label="参数类型"
      >
        <option value="string">文本</option>
        <option value="number">数字</option>
        <option value="boolean">布尔</option>
      </select>
      <select
        value={entry.control}
        onChange={(event) => updateParamEntry(onUpdate, index, "control", event.target.value)}
        aria-label="控件类型"
      >
        <option value="select">下拉</option>
        <option value="input">输入框</option>
        <option value="checkbox">开关</option>
      </select>
      <input
        value={entry.defaultValue}
        onChange={(event) => updateParamEntry(onUpdate, index, "defaultValue", event.target.value)}
        placeholder="默认值"
        aria-label="默认值"
      />
      <input
        value={entry.values}
        onChange={(event) => updateParamEntry(onUpdate, index, "values", event.target.value)}
        placeholder="可选值，逗号分隔"
        aria-label="可选值"
      />
      <label className="param-check">
        <input
          type="checkbox"
          checked={entry.required}
          onChange={(event) => updateParamEntry(onUpdate, index, "required", event.target.checked)}
        />
        必填
      </label>
      <label className="param-check">
        <input
          type="checkbox"
          checked={entry.publicVisible}
          onChange={(event) => updateParamEntry(onUpdate, index, "publicVisible", event.target.checked)}
        />
        公开
      </label>
      <button className="remove-btn" type="button" onClick={() => removeParamEntry(onUpdate, index)}>×</button>
    </div>
  );
}

export function AdminPage() {
  const [providers, setProviders] = useState<Array<Record<string, unknown>>>([]);
  const [models, setModels] = useState<Array<Record<string, unknown>>>([]);
  const [tasks, setTasks] = useState<Record<string, unknown>[]>([]);
  const [overview, setOverview] = useState<AdminOverview>(EMPTY_ADMIN_OVERVIEW);
  const [systemEvents, setSystemEvents] = useState<SystemEventRecord[]>([]);
  const [systemEventSummary, setSystemEventSummary] = useState<SystemEventSummary>(EMPTY_SYSTEM_EVENT_SUMMARY);
  const [activeTab, setActiveTab] = useState<"overview" | "models" | "providers" | "tasks" | "logs">("overview");
  const [activeModelType, setActiveModelType] = useState("image");
  const [editingModel, setEditingModel] = useState<Record<string, unknown> | null>(null);
  const [editingProvider, setEditingProvider] = useState<Record<string, unknown> | null>(null);
  const [adminNotice, setAdminNotice] = useState("");
  const [selectedTask, setSelectedTask] = useState<AITask | null>(null);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [taskStatusFilter, setTaskStatusFilter] = useState<NodeRuntimeStatus | "">("");
  const [taskErrorFilter, setTaskErrorFilter] = useState<ErrorCategory | "">("");
  const [batchRetryLoading, setBatchRetryLoading] = useState(false);
  const [eventLevelFilter, setEventLevelFilter] = useState<SystemEventLevel | "">("");
  const [eventCategoryFilter, setEventCategoryFilter] = useState<SystemEventCategory | "">("");

  // 供应商表单
  const [providerForm, setProviderForm] = useState({
    id: "",
    name: "",
    baseUrl: "",
    authType: "none",
    secretValue: "",
    timeoutSeconds: 30,
    enabled: true,
  });

  // 模型表单
  const [modelForm, setModelForm] = useState({
    id: "",
    providerId: "",
    displayName: "",
    type: "image",
    capabilities: "text-to-image",
    enabled: true,
    sortOrder: 1,
  });
  const [defaultParams, setDefaultParams] = useState<ParamSchemaEntry[]>([]);
  const [defaultPublicParams, setDefaultPublicParams] = useState<ParamSchemaEntry[]>([]);
  const [paramSchema, setParamSchema] = useState<ParamSchemaEntry[]>([]);
  const [publicParamSchema, setPublicParamSchema] = useState<ParamSchemaEntry[]>([]);
  const [adapterConfig, setAdapterConfig] = useState<AdapterConfig>(DEFAULT_ADAPTER_CONFIG);

  const reloadSystemEvents = () =>
    listSystemEvents({ level: eventLevelFilter, category: eventCategoryFilter, limit: 100 }).then((eventResult) => {
      setSystemEvents(eventResult.events);
      setSystemEventSummary(eventResult.summary);
    });

  const reloadAdmin = () =>
    Promise.all([getOverview(), listProviders(), listModels(), listTasks(), reloadSystemEvents()]).then(([overviewResult, providerResult, modelResult, taskResult]) => {
      setOverview(overviewResult.overview);
      setProviders(providerResult.providers);
      setModels(modelResult.models);
      setTasks(taskResult.tasks as unknown as Record<string, unknown>[]);
    });

  useEffect(() => {
    reloadAdmin();
  }, []);

  useEffect(() => {
    reloadSystemEvents().catch((error) => setAdminNotice(error instanceof Error ? error.message : "获取运行日志失败"));
  }, [eventLevelFilter, eventCategoryFilter]);

  // 供应商操作
  const saveProvider = async () => {
    const payload: Record<string, unknown> = {
      ...providerForm,
      type: "custom-http",
      timeoutSeconds: Number(providerForm.timeoutSeconds),
    };
    if (providerForm.secretValue) {
      payload.secretValue = providerForm.secretValue;
    }
    if (!payload.id) {
      payload.id = `provider-${Date.now()}`;
    }
    if (providers.some((p) => p.id === providerForm.id)) {
      await updateProvider(providerForm.id, payload);
    } else {
      await createProvider(payload);
    }
    await reloadAdmin();
    setAdminNotice("供应商配置已保存");
    resetProviderForm();
  };

  const editProvider = (provider: Record<string, unknown>) => {
    setEditingProvider(provider);
    setProviderForm({
      id: String(provider.id || ""),
      name: String(provider.name || ""),
      baseUrl: String(provider.baseUrl || ""),
      authType: String(provider.authType || "none"),
      secretValue: "",
      timeoutSeconds: Number(provider.timeoutSeconds || 30),
      enabled: provider.enabled !== false,
    });
  };

  const resetProviderForm = () => {
    setEditingProvider(null);
    setProviderForm({ id: "", name: "", baseUrl: "", authType: "none", secretValue: "", timeoutSeconds: 30, enabled: true });
  };

  // 模型操作
  const saveModel = async () => {
    const payload: Record<string, unknown> = {
      id: modelForm.id || `model-${Date.now()}`,
      providerId: modelForm.providerId,
      name: modelForm.id || modelForm.displayName,
      displayName: modelForm.displayName,
      type: modelForm.type,
      capabilities: modelForm.capabilities.split(",").map((c) => c.trim()).filter(Boolean),
      defaultParams: serializeDefaultParams(defaultParams, paramSchema),
      defaultPublicParams: serializeDefaultParams(defaultPublicParams, publicParamSchema),
      paramSchema: serializeParamSchema(paramSchema),
      publicParamSchema: serializeParamSchema(publicParamSchema),
      adapter: serializeAdapterConfig(adapterConfig),
      enabled: modelForm.enabled,
      sortOrder: modelForm.sortOrder,
      allowMockFallback: false,
    };
    if (models.some((m) => m.id === modelForm.id)) {
      await updateModel(modelForm.id, payload);
    } else {
      await createModel(payload);
    }
    await reloadAdmin();
    setAdminNotice("模型配置已保存");
    resetModelForm();
  };

  const editModel = (model: Record<string, unknown>) => {
    setEditingModel(model);
    setModelForm({
      id: String(model.id || ""),
      providerId: String(model.providerId || ""),
      displayName: String(model.displayName || ""),
      type: String(model.type || "image"),
      capabilities: Array.isArray(model.capabilities) ? model.capabilities.join(", ") : "",
      enabled: model.enabled !== false,
      sortOrder: Number(model.sortOrder || 1),
    });
    const internalSchema = model.paramSchema as Record<string, unknown>;
    const resolvedPublicSchema = (model.publicParamSchema || model.paramSchema) as Record<string, unknown>;
    const resolvedPublicDefaults = filterDefaultsBySchema(
      (model.defaultPublicParams || model.defaultParams) as Record<string, unknown>,
      resolvedPublicSchema,
    );
    setDefaultParams(parseParamSchema(model.defaultParams as Record<string, unknown>));
    setDefaultPublicParams(parseParamSchema(resolvedPublicDefaults));
    setParamSchema(parseParamSchema(internalSchema));
    setPublicParamSchema(parseParamSchema(resolvedPublicSchema));
    const adapter = (model.adapter || {}) as Record<string, unknown>;
    const adapterKind = String(adapter.kind || DEFAULT_ADAPTER_CONFIG.kind);
    setAdapterConfig({
      kind: adapterKind,
      submitMethod: String(adapter.submitMethod || adapter.method || DEFAULT_ADAPTER_CONFIG.submitMethod),
      submitPath: String(adapter.submitPath || ""),
      requestTemplate: templateToString(adapter.requestTemplate || adapter.bodyTemplate || adapter.submitTemplate)
        || defaultRequestTemplateForAdapter(adapterKind, model.defaultParams as Record<string, unknown>),
      taskIdPath: String(adapter.taskIdPath || DEFAULT_ADAPTER_CONFIG.taskIdPath),
      pollMethod: String(adapter.pollMethod || DEFAULT_ADAPTER_CONFIG.pollMethod),
      taskPathTemplate: String(adapter.taskPathTemplate || ""),
      pollingTemplate: templateToString(adapter.pollingTemplate || adapter.pollBodyTemplate || adapter.pollTemplate),
      statusPath: String(adapter.statusPath || DEFAULT_ADAPTER_CONFIG.statusPath),
      successStatusValues: adapterListToString(adapter.successStatusValues || adapter.successStatus || adapter.successStatusValue, DEFAULT_ADAPTER_CONFIG.successStatusValues),
      failureStatusValues: adapterListToString(adapter.failureStatusValues || adapter.failureStatus || adapter.failureStatusValue, DEFAULT_ADAPTER_CONFIG.failureStatusValues),
      resultPath: String(adapter.resultPath || ""),
      b64Path: String(adapter.b64Path || adapter.base64Path || DEFAULT_ADAPTER_CONFIG.b64Path),
      errorPath: String(adapter.errorPath || DEFAULT_ADAPTER_CONFIG.errorPath),
      pollIntervalMs: Number(adapter.pollIntervalMs || 2000),
      timeoutMs: Number(adapter.timeoutMs || 120000),
    });
  };

  const resetModelForm = () => {
    setEditingModel(null);
    setModelForm({ id: "", providerId: "", displayName: "", type: "image", capabilities: "text-to-image", enabled: true, sortOrder: 1 });
    setDefaultParams([]);
    setDefaultPublicParams([]);
    setParamSchema([]);
    setPublicParamSchema([]);
    setAdapterConfig(DEFAULT_ADAPTER_CONFIG);
  };

  const startCreateModel = () => {
    resetModelForm();
    setEditingModel({ displayName: "新模型" });
    setModelForm((form) => ({ ...form, type: activeModelType }));
  };

  const toggleModelEnabled = async (model: Record<string, unknown>) => {
    await updateModel(String(model.id), { enabled: !model.enabled });
    await reloadAdmin();
    setAdminNotice(`模型已${model.enabled ? "禁用" : "启用"}`);
  };

  const handleTestProvider = async (provider: Record<string, unknown>) => {
    const result = await testProvider(String(provider.id));
    setAdminNotice(`${String(provider.name)}：${result.message}${result.latencyMs ? `（${result.latencyMs}ms）` : ""}`);
  };

  const handleCancelTask = async (task: Record<string, unknown>) => {
    await cancelTask(String(task.id));
    await reloadAdmin();
    setAdminNotice("任务已取消");
  };

  const handleRetryTask = async (task: Record<string, unknown>) => {
    await retryTask(String(task.id));
    await reloadAdmin();
    setAdminNotice("任务已重新入队");
  };

  // 任务详情
  const handleBatchRetryTasks = async () => {
    const taskIds = filteredTasks
      .filter((task) => task.status === "failed" || task.status === "cancelled")
      .map((task) => String(task.id));
    if (!taskIds.length) {
      setAdminNotice("当前筛选下没有可重试任务");
      return;
    }
    setBatchRetryLoading(true);
    try {
      const result = await retryTasksBatch({ taskIds, limit: 50 });
      await reloadAdmin();
      setAdminNotice(`已重新入队 ${result.retriedCount} 个任务${result.skipped.length ? `，跳过 ${result.skipped.length} 个` : ""}`);
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "批量重试失败");
    } finally {
      setBatchRetryLoading(false);
    }
  };

  const openTaskDetail = async (task: Record<string, unknown>) => {
    setTaskDetailLoading(true);
    setSelectedTask(null);
    try {
      const result = await getTask(String(task.id));
      setSelectedTask(result.task);
    } catch (error) {
      setAdminNotice(error instanceof Error ? error.message : "获取任务详情失败");
    } finally {
      setTaskDetailLoading(false);
    }
  };

  const closeTaskDetail = () => {
    setSelectedTask(null);
  };

  const errorCategoryLabels: Record<ErrorCategory, string> = {
    connection: "连接失败",
    auth: "鉴权失败",
    timeout: "超时",
    non_json: "非 JSON 响应",
    field_mapping: "字段映射错误",
    model_error: "模型错误",
    other: "其他错误",
  };

  const formatDuration = (ms?: number): string => {
    if (ms === undefined || ms === null) return "-";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}秒`;
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}分${seconds}秒`;
  };

  const formatDateTime = (value?: string | null): string => {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  };

  const eventLevelLabels: Record<SystemEventLevel, string> = {
    info: "信息",
    warning: "警告",
    error: "错误",
  };

  const eventCategoryLabels: Record<SystemEventCategory, string> = {
    system: "系统",
    api: "API",
    security: "安全",
    task: "任务",
    model: "模型",
    backup: "备份",
  };

  const formatOverviewDuration = (ms?: number | null): string => {
    if (ms === undefined || ms === null) return "-";
    return formatDuration(ms);
  };

  const formatRate = (value: number): string => `${value.toFixed(1)}%`;

  const statusLabels: Record<NodeRuntimeStatus, string> = {
    idle: "空闲",
    pending: "等待中",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
  };

  const modelTypeLabels: Record<string, string> = {
    text: "文本",
    image: "图片",
    audio: "音频",
    video: "视频",
  };

  const backupState = overview.backup.latestError
    ? { label: "有错误", tone: "danger" }
    : overview.backup.latest
      ? { label: "已有记录", tone: "ok" }
      : { label: "暂无记录", tone: "muted" };

  const formatEventMetadata = (metadata?: Record<string, unknown>) => {
    if (!metadata || Object.keys(metadata).length === 0) return "-";
    return JSON.stringify(metadata, null, 2);
  };

  // 参数编辑辅助
  const filteredTasks = tasks.filter((task) => {
    const status = String(task.status) as NodeRuntimeStatus;
    const errorCategory = task.errorCategory as ErrorCategory | undefined;
    if (taskStatusFilter && status !== taskStatusFilter) return false;
    if (taskErrorFilter && errorCategory !== taskErrorFilter) return false;
    return true;
  });

  const retryableFilteredTaskCount = filteredTasks.filter((task) => task.status === "failed" || task.status === "cancelled").length;

  const addParamEntry = (setter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>) => {
    setter((prev) => [...prev, createParamEntry()]);
  };

  const updateParamEntry = (
    setter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>,
    index: number,
    field: keyof ParamSchemaEntry,
    value: string | boolean,
  ) => {
    setter((prev) => prev.map((entry, i) => i === index ? { ...entry, [field]: value } : entry));
  };

  const removeParamEntry = (setter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>, index: number) => {
    setter((prev) => prev.filter((_, i) => i !== index));
  };

  const syncDefaultsFromSchema = (
    defaultsSetter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>,
    schemaEntries: ParamSchemaEntry[],
  ) => {
    defaultsSetter(schemaEntries.map((entry) => createParamEntry({
      key: entry.key,
      label: entry.label,
      type: entry.type,
      control: entry.control,
      values: entry.defaultValue || splitParamValues(entry.values)[0] || "",
      required: entry.required,
      publicVisible: entry.publicVisible,
    })));
  };

  return (
    <div className="admin-page">
      <header className="topbar">
        <div>
          <strong>模型管理后台</strong>
          <span>管理 AI 模型和供应商</span>
        </div>
        <button className="weui-btn weui-btn_mini weui-btn_default" onClick={() => (window.location.href = "/")}>返回画布</button>
      </header>

      {/* 标签页导航 */}
      <nav className="admin-tabs">
        <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>运维概览</button>
        <button className={activeTab === "models" ? "active" : ""} onClick={() => setActiveTab("models")}>模型管理</button>
        <button className={activeTab === "providers" ? "active" : ""} onClick={() => setActiveTab("providers")}>供应商</button>
        <button className={activeTab === "tasks" ? "active" : ""} onClick={() => setActiveTab("tasks")}>任务记录</button>
        <button className={activeTab === "logs" ? "active" : ""} onClick={() => setActiveTab("logs")}>运行日志</button>
      </nav>

      {/* 模型管理 */}
      {activeTab === "overview" && (
        <section className="admin-section admin-overview">
          <div className="overview-toolbar">
            <div>
              <h2>运维概览</h2>
              <span>最后刷新：{formatDateTime(overview.generatedAt)}</span>
            </div>
            <button className="weui-btn weui-btn_mini weui-btn_default" onClick={() => reloadAdmin()}>刷新</button>
          </div>

          <div className="overview-card-grid">
            <div className="overview-card overview-card-primary">
              <span>任务总数</span>
              <strong>{overview.tasks.total}</strong>
              <small>{overview.tasks.active} 个等待/运行中</small>
            </div>
            <div className="overview-card overview-card-ok">
              <span>成功率</span>
              <strong>{formatRate(overview.tasks.successRate)}</strong>
              <small>{overview.tasks.byStatus.succeeded} 个成功</small>
            </div>
            <div className="overview-card overview-card-danger">
              <span>失败任务</span>
              <strong>{overview.tasks.byStatus.failed}</strong>
              <small>{formatRate(overview.tasks.failureRate)} 失败率</small>
            </div>
            <div className="overview-card">
              <span>平均耗时</span>
              <strong>{formatOverviewDuration(overview.tasks.averageDurationMs)}</strong>
              <small>{overview.tasks.completed} 个已结束任务</small>
            </div>
            <div className="overview-card">
              <span>启用模型</span>
              <strong>{overview.modelRuntime.models.enabled}</strong>
              <small>共 {overview.modelRuntime.models.total} 个模型</small>
            </div>
            <div className="overview-card">
              <span>启用供应商</span>
              <strong>{overview.modelRuntime.providers.enabled}</strong>
              <small>共 {overview.modelRuntime.providers.total} 个供应商</small>
            </div>
            <div className="overview-card overview-card-warning">
              <span>日志告警</span>
              <strong>{overview.events.summary.byLevel.warning}</strong>
              <small>{overview.events.summary.byLevel.error} 个错误</small>
            </div>
            <div className={`overview-card overview-card-${backupState.tone}`}>
              <span>备份状态</span>
              <strong>{backupState.label}</strong>
              <small>{overview.backup.latest ? formatDateTime(overview.backup.latest.createdAt) : "暂无备份事件"}</small>
            </div>
          </div>

          <div className="overview-main-grid">
            <div className="overview-panel">
              <div className="overview-panel-header">
                <h3>任务状态</h3>
                <button className="plain-link" onClick={() => setActiveTab("tasks")}>查看任务</button>
              </div>
              <div className="overview-status-list">
                {(["pending", "running", "succeeded", "failed", "cancelled"] as NodeRuntimeStatus[]).map((status) => (
                  <div key={status} className="overview-status-row">
                    <span>{statusLabels[status]}</span>
                    <strong>{overview.tasks.byStatus[status] || 0}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div className="overview-panel">
              <div className="overview-panel-header">
                <h3>错误分类</h3>
                <button className="plain-link" onClick={() => setActiveTab("tasks")}>处理失败</button>
              </div>
              <div className="overview-error-grid">
                {(Object.entries(overview.tasks.byErrorCategory) as Array<[ErrorCategory, number]>)
                  .filter(([, count]) => count > 0)
                  .map(([category, count]) => (
                    <button
                      key={category}
                      className={`error-tag error-tag-${category} error-filter-button`}
                      onClick={() => {
                        setTaskErrorFilter(category);
                        setTaskStatusFilter("failed");
                        setActiveTab("tasks");
                      }}
                    >
                      {errorCategoryLabels[category]} · {count}
                    </button>
                  ))}
                {!Object.values(overview.tasks.byErrorCategory).some((count) => count > 0) && (
                  <div className="overview-empty">暂无失败分类</div>
                )}
              </div>
            </div>

            <div className="overview-panel">
              <div className="overview-panel-header">
                <h3>模型分布</h3>
                <button className="plain-link" onClick={() => setActiveTab("models")}>管理模型</button>
              </div>
              <div className="overview-status-list">
                {Object.entries(overview.modelRuntime.models.byType).map(([type, count]) => (
                  <div key={type} className="overview-status-row">
                    <span>{modelTypeLabels[type] || type}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
                {!Object.keys(overview.modelRuntime.models.byType).length && <div className="overview-empty">暂无模型</div>}
              </div>
            </div>

            <div className="overview-panel">
              <div className="overview-panel-header">
                <h3>备份信号</h3>
                <button className="plain-link" onClick={() => setActiveTab("logs")}>查看日志</button>
              </div>
              <div className="overview-status-list">
                <div className="overview-status-row">
                  <span>备份事件</span>
                  <strong>{overview.backup.total}</strong>
                </div>
                <div className="overview-status-row">
                  <span>备份错误</span>
                  <strong>{overview.backup.errors}</strong>
                </div>
                <div className="overview-status-row">
                  <span>最近错误</span>
                  <strong>{overview.backup.latestError ? formatDateTime(overview.backup.latestError.createdAt) : "-"}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="overview-main-grid overview-main-grid-wide">
            <div className="overview-panel">
              <div className="overview-panel-header">
                <h3>最近失败任务</h3>
                <button className="plain-link" onClick={() => setActiveTab("tasks")}>打开任务列表</button>
              </div>
              <div className="overview-task-list">
                {overview.recentFailedTasks.map((task) => (
                  <button
                    key={task.id}
                    className="overview-task-row"
                    onClick={() => {
                      setActiveTab("tasks");
                      openTaskDetail(task as unknown as Record<string, unknown>);
                    }}
                  >
                    <span>
                      <strong>{task.modelDisplayName || task.modelId || "-"}</strong>
                      <small>{task.inputSummary || task.id}</small>
                    </span>
                    <i className={`error-tag error-tag-${task.errorCategory || "other"}`}>
                      {errorCategoryLabels[task.errorCategory || "other"]}
                    </i>
                  </button>
                ))}
                {!overview.recentFailedTasks.length && <div className="overview-empty">暂无失败任务</div>}
              </div>
            </div>

            <div className="overview-panel">
              <div className="overview-panel-header">
                <h3>最近告警/错误</h3>
                <button className="plain-link" onClick={() => setActiveTab("logs")}>打开运行日志</button>
              </div>
              <div className="overview-signal-list">
                {overview.events.recentSignals.map((event) => (
                  <div key={event.id} className={`overview-signal-row overview-signal-${event.level}`}>
                    <span>{formatDateTime(event.createdAt)}</span>
                    <strong>{event.message}</strong>
                    <small>{eventCategoryLabels[event.category]} · {event.source}</small>
                  </div>
                ))}
                {!overview.events.recentSignals.length && <div className="overview-empty">暂无告警或错误</div>}
              </div>
            </div>
          </div>
        </section>
      )}

      {activeTab === "models" && (
        <section className="admin-section">
          {/* 模型类型切换 */}
          <div className="model-type-tabs">
            {MODEL_TYPES.map((type) => (
              <button
                key={type.value}
                className={activeModelType === type.value ? "active" : ""}
                onClick={() => setActiveModelType(type.value)}
              >
                <span className="type-icon">{type.icon}</span>
                <span>{type.label}</span>
                <span className="type-count">{models.filter((m) => m.type === type.value).length}</span>
              </button>
            ))}
          </div>

          {/* 模型列表 */}
          <div className="model-grid">
            {models
              .filter((m) => m.type === activeModelType)
              .sort((a, b) => Number(a.sortOrder || 100) - Number(b.sortOrder || 100))
              .map((model) => (
                <div
                  key={String(model.id)}
                  className={`model-card ${model.enabled ? "enabled" : "disabled"} ${editingModel?.id === model.id ? "editing" : ""}`}
                >
                  <div className="model-card-header">
                    <strong>{String(model.displayName)}</strong>
                    <button
                      className={`toggle-btn ${model.enabled ? "on" : "off"}`}
                      onClick={() => toggleModelEnabled(model)}
                      title={model.enabled ? "点击禁用" : "点击启用"}
                    >
                      {model.enabled ? "启用" : "禁用"}
                    </button>
                  </div>
                  <div className="model-card-body">
                    <span className="model-id">{String(model.id)}</span>
                    <span className="model-provider">{String(model.providerId)}</span>
                    <div className="model-capabilities">
                      {Array.isArray(model.capabilities) && model.capabilities.map((cap: string) => (
                        <span key={cap} className="capability-tag">{cap}</span>
                      ))}
                    </div>
                  </div>
                  <div className="model-card-footer">
                    <button className="weui-btn weui-btn_mini weui-btn_default" onClick={() => editModel(model)}>
                      编辑配置
                    </button>
                  </div>
                </div>
              ))}
            <div className="model-card add-card" onClick={startCreateModel}>
              <span className="add-icon">+</span>
              <span>添加{MODEL_TYPES.find((t) => t.value === activeModelType)?.label}</span>
            </div>
          </div>

          {/* 模型编辑表单 */}
          {editingModel !== null && (
            <div className="edit-panel">
              <h3>编辑模型: {String(editingModel.displayName)}</h3>
              <div className="form-grid">
                <div className="form-group">
                  <label>模型 ID</label>
                  <input value={modelForm.id} disabled />
                </div>
                <div className="form-group">
                  <label>显示名称</label>
                  <input value={modelForm.displayName} onChange={(event) => setModelForm({ ...modelForm, displayName: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>供应商</label>
                  <select value={modelForm.providerId} onChange={(event) => setModelForm({ ...modelForm, providerId: event.target.value })}>
                    <option value="">选择供应商</option>
                    {providers.filter((p) => p.enabled !== false).map((p) => (
                      <option key={String(p.id)} value={String(p.id)}>{String(p.name)}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>能力（逗号分隔）</label>
                  <input value={modelForm.capabilities} onChange={(event) => setModelForm({ ...modelForm, capabilities: event.target.value })} placeholder="text-to-image, image-to-image" />
                </div>
                <div className="form-group">
                  <label>排序权重</label>
                  <input type="number" value={modelForm.sortOrder} onChange={(event) => setModelForm({ ...modelForm, sortOrder: Number(event.target.value) })} />
                </div>
              </div>

              <h4>内部默认参数</h4>
              {defaultParams.map((entry, index) => (
                <div key={index} className="param-row">
                  <input value={entry.key} onChange={(event) => updateParamEntry(setDefaultParams, index, "key", event.target.value)} placeholder="参数名" />
                  <input value={entry.values} onChange={(event) => updateParamEntry(setDefaultParams, index, "values", event.target.value)} placeholder="默认值" />
                  <button className="remove-btn" onClick={() => removeParamEntry(setDefaultParams, index)}>×</button>
                </div>
              ))}
              <button className="add-param-btn" onClick={() => addParamEntry(setDefaultParams)}>+ 添加内部默认参数</button>

              <div className="param-heading-row">
                <h4>客户公开默认参数</h4>
                <button type="button" onClick={() => syncDefaultsFromSchema(setDefaultPublicParams, publicParamSchema)}>
                  从公开 Schema 生成默认值
                </button>
              </div>
              {defaultPublicParams.map((entry, index) => (
                <div key={index} className="param-row public-param-row">
                  <input value={entry.key} onChange={(event) => updateParamEntry(setDefaultPublicParams, index, "key", event.target.value)} placeholder="客户可见参数名" />
                  <input value={entry.values} onChange={(event) => updateParamEntry(setDefaultPublicParams, index, "values", event.target.value)} placeholder="客户侧默认值" />
                  <button className="remove-btn" onClick={() => removeParamEntry(setDefaultPublicParams, index)}>×</button>
                </div>
              ))}
              <button className="add-param-btn public-add-param-btn" onClick={() => addParamEntry(setDefaultPublicParams)}>+ 添加公开默认参数</button>

              <h4>内部参数 Schema</h4>
              {paramSchema.map((entry, index) => (
                <ParamSchemaRow
                  key={index}
                  entry={entry}
                  index={index}
                  onUpdate={setParamSchema}
                  updateParamEntry={updateParamEntry}
                  removeParamEntry={removeParamEntry}
                />
              ))}
              <button className="add-param-btn" onClick={() => addParamEntry(setParamSchema)}>+ 添加内部参数 Schema</button>

              <div className="param-heading-row">
                <h4>客户公开参数 Schema</h4>
                <button type="button" onClick={() => setPublicParamSchema(paramSchema.map((entry) => createParamEntry({ ...entry, publicVisible: true })))}>
                  从内部 Schema 同步
                </button>
              </div>
              {publicParamSchema.map((entry, index) => (
                <ParamSchemaRow
                  key={index}
                  entry={entry}
                  index={index}
                  publicRow
                  onUpdate={setPublicParamSchema}
                  updateParamEntry={updateParamEntry}
                  removeParamEntry={removeParamEntry}
                />
              ))}
              <button className="add-param-btn public-add-param-btn" onClick={() => addParamEntry(setPublicParamSchema)}>+ 添加公开参数 Schema</button>

              <h4>适配器配置</h4>
              <div className="form-grid">
                <div className="form-group">
                  <label>适配器类型</label>
                  <select value={adapterConfig.kind} onChange={(event) => setAdapterConfig({ ...adapterConfig, kind: event.target.value })}>
                    <option value="custom-http">自定义 HTTP</option>
                    <option value="z-image-turbo">Z-Image Turbo</option>
                    <option value="z-image">Z-Image</option>
                    <option value="sd-webui">SD WebUI</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>提交方法</label>
                  <select value={adapterConfig.submitMethod} onChange={(event) => setAdapterConfig({ ...adapterConfig, submitMethod: event.target.value })}>
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>提交任务路径</label>
                  <input value={adapterConfig.submitPath} onChange={(event) => setAdapterConfig({ ...adapterConfig, submitPath: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>任务 ID 路径</label>
                  <input value={adapterConfig.taskIdPath} onChange={(event) => setAdapterConfig({ ...adapterConfig, taskIdPath: event.target.value })} placeholder="task_id" />
                </div>
                <div className="form-group full-span">
                  <label>请求体模板</label>
                  <textarea
                    className="adapter-template-input"
                    value={adapterConfig.requestTemplate}
                    onChange={(event) => setAdapterConfig({ ...adapterConfig, requestTemplate: event.target.value })}
                    placeholder='{"prompt":"{prompt}","size":"{params.size}"}'
                  />
                </div>
                <div className="form-group">
                  <label>轮询方法</label>
                  <select value={adapterConfig.pollMethod} onChange={(event) => setAdapterConfig({ ...adapterConfig, pollMethod: event.target.value })}>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>查询任务路径模板</label>
                  <input value={adapterConfig.taskPathTemplate} onChange={(event) => setAdapterConfig({ ...adapterConfig, taskPathTemplate: event.target.value })} placeholder="/v1/tasks/{task_id}" />
                </div>
                <div className="form-group full-span">
                  <label>轮询请求体模板</label>
                  <textarea
                    className="adapter-template-input compact"
                    value={adapterConfig.pollingTemplate}
                    onChange={(event) => setAdapterConfig({ ...adapterConfig, pollingTemplate: event.target.value })}
                    placeholder='可选，例如 {"task_id":"{task_id}"}'
                  />
                </div>
                <div className="form-group">
                  <label>状态路径</label>
                  <input value={adapterConfig.statusPath} onChange={(event) => setAdapterConfig({ ...adapterConfig, statusPath: event.target.value })} placeholder="status" />
                </div>
                <div className="form-group">
                  <label>成功状态值</label>
                  <input value={adapterConfig.successStatusValues} onChange={(event) => setAdapterConfig({ ...adapterConfig, successStatusValues: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>失败状态值</label>
                  <input value={adapterConfig.failureStatusValues} onChange={(event) => setAdapterConfig({ ...adapterConfig, failureStatusValues: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>结果路径</label>
                  <input value={adapterConfig.resultPath} onChange={(event) => setAdapterConfig({ ...adapterConfig, resultPath: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>Base64 结果路径</label>
                  <input value={adapterConfig.b64Path} onChange={(event) => setAdapterConfig({ ...adapterConfig, b64Path: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>错误路径</label>
                  <input value={adapterConfig.errorPath} onChange={(event) => setAdapterConfig({ ...adapterConfig, errorPath: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>轮询间隔（毫秒）</label>
                  <input type="number" value={adapterConfig.pollIntervalMs} onChange={(event) => setAdapterConfig({ ...adapterConfig, pollIntervalMs: Number(event.target.value) })} />
                </div>
                <div className="form-group">
                  <label>超时时间（毫秒）</label>
                  <input type="number" value={adapterConfig.timeoutMs} onChange={(event) => setAdapterConfig({ ...adapterConfig, timeoutMs: Number(event.target.value) })} />
                </div>
              </div>

              <div className="button-row">
                <button className="weui-btn weui-btn_primary" onClick={saveModel}>保存配置</button>
                <button className="weui-btn weui-btn_default" onClick={resetModelForm}>取消</button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 供应商管理 */}
      {activeTab === "providers" && (
        <section className="admin-section">
          <div className="provider-list">
            {providers.map((provider) => (
              <div
                key={String(provider.id)}
                className={`provider-card ${provider.enabled ? "enabled" : "disabled"} ${editingProvider?.id === provider.id ? "editing" : ""}`}
                onClick={() => editProvider(provider)}
              >
                <div className="provider-card-header">
                  <strong>{String(provider.name)}</strong>
                  <span className={`status-badge ${provider.enabled ? "active" : "inactive"}`}>
                    {provider.enabled ? "启用" : "禁用"}
                  </span>
                </div>
                <div className="provider-card-body">
                  <span>{String(provider.baseUrl)}</span>
                  <span>{String(provider.authType)}{provider.hasSecret ? " / 已配置密钥" : ""}</span>
                </div>
                <div className="provider-card-actions">
                  <button
                    className="weui-btn weui-btn_mini weui-btn_default"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleTestProvider(provider);
                    }}
                  >
                    测试连接
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* 供应商编辑表单 */}
          <div className="edit-panel">
            <h3>{editingProvider ? "编辑供应商" : "添加供应商"}</h3>
            <div className="form-grid">
              <div className="form-group">
                <label>供应商 ID</label>
                <input value={providerForm.id} onChange={(event) => setProviderForm({ ...providerForm, id: event.target.value })} placeholder="留空自动生成" disabled={!!editingProvider} />
              </div>
              <div className="form-group">
                <label>名称</label>
                <input value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} />
              </div>
              <div className="form-group">
                <label>API 基础地址</label>
                <input value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="http://localhost:8192" />
              </div>
              <div className="form-group">
                <label>鉴权方式</label>
                <select value={providerForm.authType} onChange={(event) => setProviderForm({ ...providerForm, authType: event.target.value })}>
                  <option value="none">无鉴权</option>
                  <option value="api-key">API Key</option>
                  <option value="bearer">Bearer Token</option>
                </select>
              </div>
              {providerForm.authType !== "none" && (
                <div className="form-group">
                  <label>密钥</label>
                  <input type="password" value={providerForm.secretValue} onChange={(event) => setProviderForm({ ...providerForm, secretValue: event.target.value })} />
                </div>
              )}
              <div className="form-group">
                <label>超时（秒）</label>
                <input type="number" value={providerForm.timeoutSeconds} onChange={(event) => setProviderForm({ ...providerForm, timeoutSeconds: Number(event.target.value) })} />
              </div>
              <div className="form-group checkbox-group">
                <label>
                  <input type="checkbox" checked={providerForm.enabled} onChange={(event) => setProviderForm({ ...providerForm, enabled: event.target.checked })} />
                  启用
                </label>
              </div>
            </div>
            <div className="button-row">
              <button className="weui-btn weui-btn_primary" onClick={saveProvider}>{editingProvider ? "更新供应商" : "添加供应商"}</button>
              {editingProvider && <button className="weui-btn weui-btn_default" onClick={resetProviderForm}>取消</button>}
            </div>
          </div>
        </section>
      )}

      {/* 任务记录 */}
      {activeTab === "tasks" && (
        <section className="admin-section">
          <div className="task-toolbar">
            <div className="task-filter-group">
              <select value={taskStatusFilter} onChange={(event) => setTaskStatusFilter(event.target.value as NodeRuntimeStatus | "")}>
                <option value="">全部状态</option>
                <option value="pending">等待中</option>
                <option value="running">运行中</option>
                <option value="succeeded">成功</option>
                <option value="failed">失败</option>
                <option value="cancelled">已取消</option>
              </select>
              <select value={taskErrorFilter} onChange={(event) => setTaskErrorFilter(event.target.value as ErrorCategory | "")}>
                <option value="">全部错误分类</option>
                {Object.entries(errorCategoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              {(taskStatusFilter || taskErrorFilter) && (
                <button className="weui-btn weui-btn_mini weui-btn_default" onClick={() => { setTaskStatusFilter(""); setTaskErrorFilter(""); }}>清除筛选</button>
              )}
            </div>
            <div className="task-bulk-actions">
              <span>当前 {filteredTasks.length} 个，{retryableFilteredTaskCount} 个可重试</span>
              <button className="weui-btn weui-btn_mini weui-btn_primary" disabled={!retryableFilteredTaskCount || batchRetryLoading} onClick={handleBatchRetryTasks}>
                {batchRetryLoading ? "重试中..." : "批量重试"}
              </button>
            </div>
          </div>
          <div className="task-list">
            <div className="task-header">
              <span>类型</span>
              <span>状态</span>
              <span>模型</span>
              <span>供应商</span>
              <span>耗时</span>
              <span>操作</span>
            </div>
            {filteredTasks.slice(0, 50).map((task) => {
              const status = String(task.status);
              const canCancel = status === "pending" || status === "running";
              const canRetry = status === "failed" || status === "cancelled";
              const errorCategory = task.errorCategory as ErrorCategory | undefined;
              return (
                <div
                  key={String(task.id)}
                  className={`task-row ${selectedTask?.id === task.id ? "task-row-selected" : ""}`}
                  onClick={() => openTaskDetail(task)}
                  title="点击查看任务详情"
                >
                  <span>{String(task.type)}</span>
                  <span className="task-status-cell">
                    <span className={`status-${task.status}`}>{status}</span>
                    {errorCategory && (
                      <span className={`error-tag error-tag-${errorCategory}`}>{errorCategoryLabels[errorCategory]}</span>
                    )}
                  </span>
                  <span>{String(task.modelDisplayName || task.modelId || "-")}</span>
                  <span>{String(task.providerName || "-")}</span>
                  <span>{formatDuration(task.durationMs as number | undefined)}</span>
                  <span className="task-actions" onClick={(event) => event.stopPropagation()}>
                    <button className="weui-btn weui-btn_mini weui-btn_default" disabled={!canCancel} onClick={() => handleCancelTask(task)}>取消</button>
                    <button className="weui-btn weui-btn_mini weui-btn_primary" disabled={!canRetry} onClick={() => handleRetryTask(task)}>重试</button>
                  </span>
                </div>
              );
            })}
            {!filteredTasks.length && tasks.length > 0 && <div className="empty-state">暂无匹配任务</div>}
            {!tasks.length && <div className="empty-state">暂无任务记录</div>}
          </div>

          {/* 任务详情面板 */}
          {taskDetailLoading && <div className="task-detail-loading">加载中…</div>}
          {selectedTask && !taskDetailLoading && (
            <div className="task-detail-panel">
              <div className="task-detail-header">
                <h3>任务详情</h3>
                <button className="weui-btn weui-btn_mini weui-btn_default" onClick={closeTaskDetail}>关闭</button>
              </div>
              <div className="task-detail-body">
                <div className="detail-row">
                  <span className="detail-label">任务 ID</span>
                  <span className="detail-value">{selectedTask.id}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">类型</span>
                  <span className="detail-value">{selectedTask.type}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">状态</span>
                  <span className="detail-value">
                    <span className={`status-${selectedTask.status}`}>{selectedTask.status}</span>
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">模型</span>
                  <span className="detail-value">{selectedTask.modelDisplayName || selectedTask.modelId || "-"}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">供应商</span>
                  <span className="detail-value">{selectedTask.providerName || "-"}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">创建时间</span>
                  <span className="detail-value">{selectedTask.createdAt || "-"}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">开始时间</span>
                  <span className="detail-value">{selectedTask.startedAt || "-"}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">耗时</span>
                  <span className="detail-value">{formatDuration(selectedTask.durationMs)}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">模型等待上限</span>
                  <span className="detail-value">{formatDuration(selectedTask.timeoutMs)}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">轮询间隔</span>
                  <span className="detail-value">{formatDuration(selectedTask.pollIntervalMs)}</span>
                </div>
                {selectedTask.inputSummary && (
                  <div className="detail-row detail-row-block">
                    <span className="detail-label">输入摘要</span>
                    <span className="detail-value detail-prompt">{selectedTask.inputSummary}</span>
                  </div>
                )}
                {!!(selectedTask.input?.params) && typeof selectedTask.input.params === "object" && Object.keys(selectedTask.input.params as Record<string, unknown>).length > 0 && (
                  <div className="detail-row detail-row-block">
                    <span className="detail-label">输入参数</span>
                    <span className="detail-value detail-params">
                      {String(JSON.stringify(selectedTask.input.params, null, 2))}
                    </span>
                  </div>
                )}
                {selectedTask.status === "failed" && (
                  <>
                    <div className="detail-row">
                      <span className="detail-label">错误分类</span>
                      <span className="detail-value">
                        {selectedTask.errorCategory ? (
                          <span className={`error-tag error-tag-${selectedTask.errorCategory}`}>
                            {errorCategoryLabels[selectedTask.errorCategory]}
                          </span>
                        ) : "-"}
                      </span>
                    </div>
                    <div className="detail-row detail-row-block">
                      <span className="detail-label">错误信息</span>
                      <span className="detail-value detail-error">{selectedTask.error || "-"}</span>
                    </div>
                  </>
                )}
                {selectedTask.output && (
                  <div className="detail-row detail-row-block">
                    <span className="detail-label">输出</span>
                    <span className="detail-value detail-output">
                      {selectedTask.output.url ? (
                        <a href={String(selectedTask.output.url)} target="_blank" rel="noopener noreferrer">查看结果图片</a>
                      ) : (
                        JSON.stringify(selectedTask.output, null, 2)
                      )}
                    </span>
                  </div>
                )}
              </div>
              {(selectedTask.status === "failed" || selectedTask.status === "cancelled") && (
                <div className="task-detail-footer">
                  <button className="weui-btn weui-btn_primary" onClick={() => { handleRetryTask(selectedTask as unknown as Record<string, unknown>); closeTaskDetail(); }}>重试任务</button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* 运行日志 */}
      {activeTab === "logs" && (
        <section className="admin-section">
          <div className="event-summary-grid">
            <div className="event-summary-card">
              <span>事件总数</span>
              <strong>{systemEventSummary.total}</strong>
            </div>
            <div className="event-summary-card event-summary-error">
              <span>错误</span>
              <strong>{systemEventSummary.byLevel.error}</strong>
            </div>
            <div className="event-summary-card event-summary-warning">
              <span>警告</span>
              <strong>{systemEventSummary.byLevel.warning}</strong>
            </div>
            <div className="event-summary-card">
              <span>最近错误</span>
              <strong>{formatDateTime(systemEventSummary.latestErrorAt)}</strong>
            </div>
          </div>

          <div className="event-toolbar">
            <select value={eventLevelFilter} onChange={(event) => setEventLevelFilter(event.target.value as SystemEventLevel | "")}>
              <option value="">全部等级</option>
              <option value="info">信息</option>
              <option value="warning">警告</option>
              <option value="error">错误</option>
            </select>
            <select value={eventCategoryFilter} onChange={(event) => setEventCategoryFilter(event.target.value as SystemEventCategory | "")}>
              <option value="">全部分类</option>
              <option value="system">系统</option>
              <option value="api">API</option>
              <option value="security">安全</option>
              <option value="task">任务</option>
              <option value="model">模型</option>
              <option value="backup">备份</option>
            </select>
            <button className="weui-btn weui-btn_mini weui-btn_default" onClick={() => reloadSystemEvents()}>刷新</button>
          </div>

          <div className="event-list">
            <div className="event-header">
              <span>时间</span>
              <span>等级</span>
              <span>分类</span>
              <span>来源</span>
              <span>消息</span>
              <span>元数据</span>
            </div>
            {systemEvents.map((event) => (
              <div key={event.id} className={`event-row event-row-${event.level}`}>
                <span>{formatDateTime(event.createdAt)}</span>
                <span><i className={`event-level event-level-${event.level}`}>{eventLevelLabels[event.level]}</i></span>
                <span>{eventCategoryLabels[event.category]}</span>
                <span>{event.source}</span>
                <strong>{event.message}</strong>
                <code>{formatEventMetadata(event.metadata)}</code>
              </div>
            ))}
            {!systemEvents.length && <div className="empty-state">暂无运行日志</div>}
          </div>
        </section>
      )}

      {/* 提示信息 */}
      {adminNotice && (
        <div className="admin-toast" onClick={() => setAdminNotice("")}>
          {adminNotice}
        </div>
      )}
    </div>
  );
}
