import { useEffect, useState } from "react";
import { createModel, createProvider, listModels, listProviders, listTasks, updateModel, updateProvider } from "../api";

interface ParamSchemaEntry {
  key: string;
  values: string;
}

const MODEL_TYPES = [
  { value: "text", label: "文本模型", icon: "Aa" },
  { value: "image", label: "图片模型", icon: "▣" },
  { value: "audio", label: "音频模型", icon: "♪" },
  { value: "video", label: "视频模型", icon: "▶" },
];

function parseParamSchema(schema: Record<string, unknown> | undefined): ParamSchemaEntry[] {
  if (!schema || typeof schema !== "object") return [];
  return Object.entries(schema).map(([key, values]) => ({
    key,
    values: Array.isArray(values) ? values.join(", ") : String(values),
  }));
}

function serializeParamSchema(entries: ParamSchemaEntry[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    result[key] = entry.values.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return result;
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
  const [paramSchema, setParamSchema] = useState<ParamSchemaEntry[]>([]);
  const [adapterConfig, setAdapterConfig] = useState({
    kind: "z-image-turbo",
    submitPath: "/v1/images/generations",
    taskPathTemplate: "/v1/tasks/{task_id}",
    resultPath: "data.0.url",
    pollIntervalMs: 2000,
    timeoutMs: 120000,
  });

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
      defaultParams: Object.fromEntries(defaultParams.map((e) => [e.key.trim(), isNaN(Number(e.values)) ? e.values : Number(e.values)])),
      paramSchema: serializeParamSchema(paramSchema),
      adapter: adapterConfig,
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
    setDefaultParams(parseParamSchema(model.defaultParams as Record<string, unknown>));
    setParamSchema(parseParamSchema(model.paramSchema as Record<string, unknown>));
    const adapter = (model.adapter || {}) as Record<string, unknown>;
    setAdapterConfig({
      kind: String(adapter.kind || "z-image-turbo"),
      submitPath: String(adapter.submitPath || ""),
      taskPathTemplate: String(adapter.taskPathTemplate || ""),
      resultPath: String(adapter.resultPath || ""),
      pollIntervalMs: Number(adapter.pollIntervalMs || 2000),
      timeoutMs: Number(adapter.timeoutMs || 120000),
    });
  };

  const resetModelForm = () => {
    setEditingModel(null);
    setModelForm({ id: "", providerId: "", displayName: "", type: "image", capabilities: "text-to-image", enabled: true, sortOrder: 1 });
    setDefaultParams([]);
    setParamSchema([]);
    setAdapterConfig({ kind: "z-image-turbo", submitPath: "/v1/images/generations", taskPathTemplate: "/v1/tasks/{task_id}", resultPath: "data.0.url", pollIntervalMs: 2000, timeoutMs: 120000 });
  };

  const toggleModelEnabled = async (model: Record<string, unknown>) => {
    await updateModel(String(model.id), { enabled: !model.enabled });
    await reloadAdmin();
    setAdminNotice(`模型已${model.enabled ? "禁用" : "启用"}`);
  };

  // 参数编辑辅助
  const addParamEntry = (setter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>) => {
    setter((prev) => [...prev, { key: "", values: "" }]);
  };

  const updateParamEntry = (setter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>, index: number, field: "key" | "values", value: string) => {
    setter((prev) => prev.map((entry, i) => i === index ? { ...entry, [field]: value } : entry));
  };

  const removeParamEntry = (setter: React.Dispatch<React.SetStateAction<ParamSchemaEntry[]>>, index: number) => {
    setter((prev) => prev.filter((_, i) => i !== index));
  };

  // 按类型分组的模型
  const modelsByType = MODEL_TYPES.map((type) => ({
    ...type,
    models: models.filter((m) => m.type === type.value),
  }));

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
            <div className="model-card add-card" onClick={() => { resetModelForm(); setModelForm((f) => ({ ...f, type: activeModelType })); }}>
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

              <h4>默认参数</h4>
              {defaultParams.map((entry, index) => (
                <div key={index} className="param-row">
                  <input value={entry.key} onChange={(event) => updateParamEntry(setDefaultParams, index, "key", event.target.value)} placeholder="参数名" />
                  <input value={entry.values} onChange={(event) => updateParamEntry(setDefaultParams, index, "values", event.target.value)} placeholder="默认值" />
                  <button className="remove-btn" onClick={() => removeParamEntry(setDefaultParams, index)}>×</button>
                </div>
              ))}
              <button className="add-param-btn" onClick={() => addParamEntry(setDefaultParams)}>+ 添加默认参数</button>

              <h4>参数可选值（前端显示）</h4>
              {paramSchema.map((entry, index) => (
                <div key={index} className="param-row">
                  <input value={entry.key} onChange={(event) => updateParamEntry(setParamSchema, index, "key", event.target.value)} placeholder="参数名（如 size）" />
                  <input value={entry.values} onChange={(event) => updateParamEntry(setParamSchema, index, "values", event.target.value)} placeholder="可选值（逗号分隔）" />
                  <button className="remove-btn" onClick={() => removeParamEntry(setParamSchema, index)}>×</button>
                </div>
              ))}
              <button className="add-param-btn" onClick={() => addParamEntry(setParamSchema)}>+ 添加参数Schema</button>

              <h4>适配器配置</h4>
              <div className="form-grid">
                <div className="form-group">
                  <label>适配器类型</label>
                  <input value={adapterConfig.kind} onChange={(event) => setAdapterConfig({ ...adapterConfig, kind: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>提交任务路径</label>
                  <input value={adapterConfig.submitPath} onChange={(event) => setAdapterConfig({ ...adapterConfig, submitPath: event.target.value })} />
                </div>
                <div className="form-group">
                  <label>查询任务路径模板</label>
                  <input value={adapterConfig.taskPathTemplate} onChange={(event) => setAdapterConfig({ ...adapterConfig, taskPathTemplate: event.target.value })} placeholder="/v1/tasks/{task_id}" />
                </div>
                <div className="form-group">
                  <label>结果路径</label>
                  <input value={adapterConfig.resultPath} onChange={(event) => setAdapterConfig({ ...adapterConfig, resultPath: event.target.value })} />
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
                  <span>{String(provider.authType)}</span>
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
            </div>
            {tasks.slice(0, 50).map((task) => (
              <div key={String(task.id)} className="task-row">
                <span>{String(task.type)}</span>
                <span className={`status-${task.status}`}>{String(task.status)}</span>
                <span>{String(task.progress || 0)}%</span>
                <span>{String(task.modelId || "-")}</span>
              </div>
            ))}
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
