import { useEffect, useState } from "react";
import { cancelTask, createModel, createProvider, listModels, listProviders, listTasks, retryTask, testProvider, updateModel, updateProvider } from "../api";

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
  const [activeTab, setActiveTab] = useState<"models" | "providers" | "tasks">("models");
  const [activeModelType, setActiveModelType] = useState("image");
  const [editingModel, setEditingModel] = useState<Record<string, unknown> | null>(null);
  const [editingProvider, setEditingProvider] = useState<Record<string, unknown> | null>(null);
  const [adminNotice, setAdminNotice] = useState("");

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

  const reloadAdmin = () =>
    Promise.all([listProviders(), listModels(), listTasks()]).then(([providerResult, modelResult, taskResult]) => {
      setProviders(providerResult.providers);
      setModels(modelResult.models);
      setTasks(taskResult.tasks as unknown as Record<string, unknown>[]);
    });

  useEffect(() => {
    reloadAdmin();
  }, []);

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

  // 参数编辑辅助
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
        <button className={activeTab === "models" ? "active" : ""} onClick={() => setActiveTab("models")}>模型管理</button>
        <button className={activeTab === "providers" ? "active" : ""} onClick={() => setActiveTab("providers")}>供应商</button>
        <button className={activeTab === "tasks" ? "active" : ""} onClick={() => setActiveTab("tasks")}>任务记录</button>
      </nav>

      {/* 模型管理 */}
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
          <div className="task-list">
            <div className="task-header">
              <span>类型</span>
              <span>状态</span>
              <span>进度</span>
              <span>模型</span>
              <span>操作</span>
            </div>
            {tasks.slice(0, 50).map((task) => {
              const status = String(task.status);
              const canCancel = status === "pending" || status === "running";
              const canRetry = status === "failed" || status === "cancelled";
              return (
                <div key={String(task.id)} className="task-row">
                  <span>{String(task.type)}</span>
                  <span className={`status-${task.status}`}>{status}</span>
                  <span>{String(task.progress || 0)}%</span>
                  <span>{String(task.modelId || "-")}</span>
                  <span className="task-actions">
                    <button className="weui-btn weui-btn_mini weui-btn_default" disabled={!canCancel} onClick={() => handleCancelTask(task)}>取消</button>
                    <button className="weui-btn weui-btn_mini weui-btn_primary" disabled={!canRetry} onClick={() => handleRetryTask(task)}>重试</button>
                  </span>
                </div>
              );
            })}
            {!tasks.length && <div className="empty-state">暂无任务记录</div>}
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
