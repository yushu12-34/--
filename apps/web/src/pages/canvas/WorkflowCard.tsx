import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getNodeDefinition } from "../../nodeDefinitions";
import type { AssetRecord } from "../../types";
import { getNodeAssetType, getNodeIcon, getNodePreviewText } from "./canvasUtils";
import { getCheckedParamValue, getModelParamConfigs, getParamValue, coerceNodeParamValue, pickPublicParams } from "./modelParams";
import type { WorkflowReactNode } from "./workflowTypes";

function AssetAddRow({
  thumbnails,
  assets,
  assetLabel,
  onSelect,
  onRemove,
  stacked = false,
}: {
  thumbnails: Array<{ url: string; name: string }>;
  assets: AssetRecord[];
  assetLabel: string;
  onSelect: (url: string) => void;
  onRemove?: (index: number) => void;
  stacked?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleClickOutside = (event: globalThis.MouseEvent) => {
      if (pickerRef.current && event.target instanceof globalThis.Node && !pickerRef.current.contains(event.target)) {
        setPickerOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [pickerOpen]);

  return (
    <div className={`node-add-row ${stacked ? "node-add-row-stacked" : ""}`}>
      {thumbnails.map((item, index) => (
        <div className={`node-add-thumb ${stacked ? "node-add-thumb-stacked" : ""}`} key={index} style={stacked ? { left: index * -12, zIndex: thumbnails.length - index } : undefined}>
          {assetLabel === "image" ? (
            <>
              <img src={item.url} alt={item.name || `已选 ${index + 1}`} />
              {onRemove && (
                <button
                  className="node-ref-remove-btn"
                  title="移除此参考图"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(index);
                  }}
                >
                  ✕
                </button>
              )}
            </>
          ) : (
            <span className="node-add-thumb-icon">{assetLabel === "audio" ? "♪" : assetLabel === "video" ? "▶" : "▣"}</span>
          )}
        </div>
      ))}
      <div className="node-add-wrapper" ref={pickerRef}>
        <div
          className="node-expanded-add"
          title={`从素材库选择${assetLabel === "image" ? "图片" : assetLabel === "audio" ? "音频" : "视频"}`}
          onClick={() => setPickerOpen((prev) => !prev)}
        >
          ＋
        </div>
        {pickerOpen && assets.length > 0 && (
          <div className="node-asset-picker">
            {assets.map((asset) => (
              <button
                key={asset.id}
                onClick={() => {
                  onSelect(asset.url);
                  setPickerOpen(false);
                }}
              >
                {asset.type === "image" ? (
                  <img src={asset.thumbnailUrl || asset.url} alt={asset.mimeType} />
                ) : (
                  <span className="node-asset-icon">{asset.type === "audio" ? "♪" : "▶"}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ModelParamControls({
  model,
  params,
  onChange,
}: {
  model?: Record<string, unknown>;
  params: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const configs = getModelParamConfigs(model);
  if (configs.length === 0) return null;

  const defaults = (model?.defaultParams || {}) as Record<string, unknown>;

  return (
    <div className="node-param-row">
      {configs.map((config) => {
        const value = getParamValue(config, params, defaults);
        const updateParam = (nextValue: string | boolean) => {
          const publicParams = pickPublicParams(model, params);
          onChange({
            ...publicParams,
            [config.key]: coerceNodeParamValue(nextValue, config.type),
          });
        };

        if (config.control === "checkbox") {
          return (
            <label key={config.key} className="node-param-control checkbox-control">
              <span>{config.label}</span>
              <input
                type="checkbox"
                checked={getCheckedParamValue(value)}
                onChange={(event) => updateParam(event.target.checked)}
              />
            </label>
          );
        }

        if (config.control === "input" || config.options.length === 0) {
          return (
            <label key={config.key} className="node-param-control">
              <span>{config.label}</span>
              <input
                type={config.type === "number" ? "number" : "text"}
                value={String(value ?? "")}
                required={config.required}
                onChange={(event) => updateParam(event.target.value)}
              />
            </label>
          );
        }

        return (
          <label key={config.key} className="node-param-control">
            <span>{config.label}</span>
            <select
              value={String(value ?? "")}
              required={config.required}
              onChange={(event) => updateParam(event.target.value)}
            >
              {config.options.map((option) => (
                <option key={String(option)} value={String(option)}>{String(option)}</option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}

function WorkflowCard({ data, selected }: NodeProps<WorkflowReactNode>) {
  const {
    workflow,
    onPatch,
    onRun,
    onDelete,
    onDuplicate,
    onCollapse,
    onInspectInputs,
    onInspectOutputs,
    canRun,
    readyMessage,
    resultStale,
    connectedInputs,
    upstreamNodes,
    downstreamNodes,
    highlightRole,
    assets,
    models,
    onSaveResultAsset,
    onCopyResultUrl,
    onPreviewResult,
    expanded,
  } = data;
  const definition = getNodeDefinition(workflow.type);
  const runtime = workflow.runtime;
  const isGenerate = definition?.category === "generate";
  const updateData = (patch: Record<string, unknown>, options?: { markLocalEdit?: boolean }) => onPatch(workflow.id, { data: { ...workflow.data, ...patch } }, options);
  const assetType = getNodeAssetType(workflow.type);
  const visibleAssets = useMemo(
    () => expanded && assetType ? assets.filter((asset) => asset.type === assetType) : [],
    [assetType, assets, expanded],
  );
  const previewText = getNodePreviewText(workflow);
  const resultUrl = String(workflow.data.resultUrl || workflow.data.url || "");
  const hasResult = Boolean(resultUrl);
  const height = expanded
    ? Math.max(340, 244 + 34)
    : Math.max(248, 150 + 34);
  const hasInput = (definition?.inputs.length || 0) > 0;
  const hasOutput = (definition?.outputs.length || 0) > 0;
  const inputText = connectedInputs.texts.join("\n\n");
  const inputImages = connectedInputs.images;
  const imageAssets = useMemo(
    () => expanded && workflow.type === "image.generate" ? assets.filter((asset) => asset.type === "image") : [],
    [assets, expanded, workflow.type],
  );
  const [expandedText, setExpandedText] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const canEditPrompt = workflow.type === "text.input" || Boolean(isGenerate);
  const selectedModel = models.find((m) => m.id === (workflow.data.modelId || "z-image-turbo"));
  const requiredParamIssues = isGenerate
    ? getModelParamConfigs(selectedModel)
      .filter((config) => config.required)
      .filter((config) => {
        const value = getParamValue(config, (workflow.data.params || {}) as Record<string, unknown>, (selectedModel?.defaultParams || {}) as Record<string, unknown>);
        return value === undefined || value === null || value === "";
      })
    : [];
  const inputCount = connectedInputs.texts.length + connectedInputs.images.length + connectedInputs.audios.length + connectedInputs.videos.length;
  const diagnosticIssues = [
    ...(readyMessage ? [readyMessage] : []),
    ...(upstreamNodes.length > 0 && inputCount === 0 ? ["上游节点已连接，但还没有可用输出"] : []),
    ...(isGenerate && models.length > 0 && !selectedModel ? ["模型未配置或已停用"] : []),
    ...requiredParamIssues.map((config) => `参数「${config.label}」未填写`),
    ...(resultStale ? ["当前结果可能已过期，建议重新运行"] : []),
    ...(runtime.error ? [runtime.error] : []),
  ];
  const statusLabel = runtime.cacheHit ? "缓存命中" : runtime.status === "pending" ? "排队中" : runtime.status === "running" ? "运行中" : runtime.status === "succeeded" ? "成功" : runtime.status === "failed" ? "失败" : runtime.status === "cancelled" ? "已取消" : "待运行";

  useEffect(() => {
    if (expandedText) setTextDraft(String(workflow.data.prompt || ""));
  }, [expandedText, workflow.data.prompt]);

  const stopToolbarEvent = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const saveTextDraft = () => {
    if (!canEditPrompt) return;
    updateData({
      prompt: textDraft,
      ...(isGenerate ? { promptTouched: true } : {}),
    });
  };

  const openPromptEditor = () => {
    if (!canEditPrompt) return;
    setTextDraft(String(workflow.data.prompt || ""));
    setExpandedText(true);
  };

  const handlePreviewOrCollapse = () => {
    if (hasResult) {
      onPreviewResult(workflow.id);
      return;
    }
    if (workflow.type === "text.input") {
      openPromptEditor();
      return;
    }
    onCollapse(workflow.id);
  };

  const handleInspectInputs = () => {
    setDiagnosticsOpen((open) => !open);
    onInspectInputs(workflow.id);
  };

  const handlePrimaryAction = () => {
    if (runtime.status === "running" || runtime.status === "pending") return;
    if (runtime.status !== "failed" && hasResult && !resultStale) {
      onPreviewResult(workflow.id);
      return;
    }
    if (isGenerate) {
      if (!canRun) {
        setDiagnosticsOpen(true);
        onInspectInputs(workflow.id);
        return;
      }
      onRun(workflow.id, { force: runtime.status === "failed" });
      return;
    }
    if (hasResult) {
      onPreviewResult(workflow.id);
      return;
    }
    if (downstreamNodes.length > 0) {
      onInspectOutputs(workflow.id);
      return;
    }
    if (canEditPrompt) openPromptEditor();
  };

  const primaryActionTitle = runtime.status === "failed"
    ? "重试当前节点"
    : hasResult && !resultStale
      ? "打开结果预览"
      : isGenerate
        ? "运行当前节点"
        : downstreamNodes.length > 0
          ? "高亮下游节点"
          : "打开节点内容";
  const primaryActionIcon = runtime.status === "failed" ? "↻" : hasResult && !resultStale ? "↗" : isGenerate ? "▶" : "↗";

  return (
    <div className={`node-card ${selected ? "selected" : ""} ${expanded ? "expanded" : ""} ${runtime.status} ${highlightRole || ""}`} style={{ minHeight: height }}>
      <button
        className="node-delete-btn"
        title="删除节点"
        onClick={(event) => {
          event.stopPropagation();
          onDelete(workflow.id);
        }}
      >
        ✕
      </button>
      {expanded && (
        <div className="node-floating-toolbar nodrag" onMouseDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            title={hasResult ? "预览结果" : workflow.type === "text.input" ? "打开文本预览" : "收起节点详情"}
            onClick={(event) => {
              stopToolbarEvent(event);
              handlePreviewOrCollapse();
            }}
          >
            ▣
          </button>
          <button
            type="button"
            className={diagnosticsOpen || highlightRole ? "active" : ""}
            title="输入诊断与连接检查"
            onClick={(event) => {
              stopToolbarEvent(event);
              handleInspectInputs();
            }}
          >
            ◎
          </button>
          <button
            type="button"
            disabled={!canEditPrompt}
            title={canEditPrompt ? "打开 Prompt 大编辑器" : "当前节点没有文本内容"}
            onClick={(event) => {
              stopToolbarEvent(event);
              openPromptEditor();
            }}
          >
            T
          </button>
          <button
            type="button"
            title="复制节点并派生变体"
            onClick={(event) => {
              stopToolbarEvent(event);
              onDuplicate(workflow.id);
            }}
          >
            ⧉
          </button>
          <button
            type="button"
            disabled={runtime.status === "running" || runtime.status === "pending"}
            title={primaryActionTitle}
            onClick={(event) => {
              stopToolbarEvent(event);
              handlePrimaryAction();
            }}
          >
            {primaryActionIcon}
          </button>
        </div>
      )}
      <div className="node-header">
        <span className="node-kind-icon">{getNodeIcon(workflow.type)}</span>
        {expanded ? (
          <input
            className="node-title-input"
            value={workflow.title}
            onChange={(event) => onPatch(workflow.id, { title: event.target.value })}
          />
        ) : (
          <strong>{workflow.title}</strong>
        )}
        <small>{definition?.category === "input" ? "输入" : "生成"}</small>
      </div>
      {isGenerate && (
        <div className={`node-runtime-bar ${runtime.status}`}>
          <span>{statusLabel}</span>
          <div><i style={{ width: `${runtime.status === "succeeded" ? 100 : runtime.progress || 0}%` }} /></div>
          <em>{runtime.status === "running" || runtime.status === "pending" ? `${runtime.progress || 0}%` : ""}</em>
        </div>
      )}
      {resultStale && <div className="node-stale-badge">结果可能已过期</div>}

      {hasInput && (
        <div className="port port-input" style={{ top: "50%" }}>
          <HandleShim id="in" type="target" />
        </div>
      )}

      <div className="node-preview">
        {hasResult && workflow.type.includes("image") ? (
          <div className="node-preview-img-wrap" style={{ backgroundImage: `url(${workflow.data.resultUrl || workflow.data.url})` }}>
            <img src={String(workflow.data.resultUrl || workflow.data.url)} alt="节点预览" />
          </div>
        ) : hasResult && workflow.type.includes("audio") ? (
          <div className="node-empty-preview">
            <span>♫</span>
            <p>音频已生成</p>
          </div>
        ) : hasResult && workflow.type.includes("video") ? (
          <div className="node-empty-preview">
            <span>▶</span>
            <p>视频已生成</p>
          </div>
        ) : (
          <div className="node-empty-preview">
            <span>{workflow.type.includes("image") ? "▣" : workflow.type.includes("audio") ? "♪" : workflow.type.includes("video") ? "▶" : "Aa"}</span>
            <p>{previewText}</p>
          </div>
        )}
        <i className="node-resize-mark">⌟</i>
      </div>
      {hasResult && (
        <div className="node-result-actions nodrag">
          {isGenerate && <button type="button" onClick={() => onRun(workflow.id)}>使用缓存运行</button>}
          {isGenerate && <button type="button" onClick={() => onRun(workflow.id, { force: true })}>强制重新生成</button>}
          <button type="button" onClick={() => onSaveResultAsset(workflow.id)}>存素材</button>
          <button type="button" onClick={() => onCopyResultUrl(workflow.id)}>复制 URL</button>
          <button type="button" onClick={() => onPreviewResult(workflow.id)}>预览</button>
        </div>
      )}

      {expanded && diagnosticsOpen && (
        <div className={`node-diagnostics nodrag ${diagnosticIssues.length > 0 ? "has-issues" : "ready"}`} onClick={(event) => event.stopPropagation()}>
          <div className="node-diagnostics-head">
            <strong>输入诊断</strong>
            <span>{diagnosticIssues.length > 0 ? `${diagnosticIssues.length} 个待处理项` : "可以运行"}</span>
          </div>
          <div className="node-diagnostics-grid">
            <div>
              <span>上游</span>
              <strong>{upstreamNodes.length}</strong>
            </div>
            <div>
              <span>文本</span>
              <strong>{connectedInputs.texts.length}</strong>
            </div>
            <div>
              <span>图片</span>
              <strong>{connectedInputs.images.length}</strong>
            </div>
            <div>
              <span>媒体</span>
              <strong>{connectedInputs.audios.length + connectedInputs.videos.length}</strong>
            </div>
          </div>
          <div className="node-diagnostics-section">
            <span>上游来源</span>
            {upstreamNodes.length > 0 ? (
              <div className="node-diagnostics-list">
                {upstreamNodes.map((node) => (
                  <em key={node.id} className={node.hasValue ? "ready" : "empty"}>
                    {node.title}
                  </em>
                ))}
              </div>
            ) : (
              <p>暂无上游连接。</p>
            )}
          </div>
          {diagnosticIssues.length > 0 ? (
            <div className="node-diagnostics-section">
              <span>需要处理</span>
              <ul>
                {diagnosticIssues.map((issue, index) => (
                  <li key={`${issue}-${index}`}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="node-diagnostics-ok">输入、模型和参数检查通过。</p>
          )}
        </div>
      )}

      {expanded && (
        <div className="node-expanded-panel nodrag">
          {workflow.type === "image.input" && (
            <AssetAddRow
              thumbnails={Boolean(workflow.data.url) ? [{ url: String(workflow.data.url), name: String(workflow.data.name || "") }] : []}
              assets={visibleAssets}
              assetLabel="image"
              onSelect={(url) => updateData({ url })}
            />
          )}
          {workflow.type === "audio.input" && (
            <AssetAddRow
              thumbnails={Boolean(workflow.data.url) ? [{ url: String(workflow.data.url), name: String(workflow.data.name || "") }] : []}
              assets={visibleAssets}
              assetLabel="audio"
              onSelect={(url) => updateData({ url })}
            />
          )}
          {workflow.type === "video.input" && (
            <AssetAddRow
              thumbnails={Boolean(workflow.data.url) ? [{ url: String(workflow.data.url), name: String(workflow.data.name || "") }] : []}
              assets={visibleAssets}
              assetLabel="video"
              onSelect={(url) => updateData({ url })}
            />
          )}
          {workflow.type === "image.generate" && (() => {
            const refImages = (workflow.data.refImages || []) as Array<{ url: string; name: string }>;
            return (
              <AssetAddRow
                thumbnails={refImages}
                assets={imageAssets}
                assetLabel="image"
                stacked
                onSelect={(url) => {
                  const asset = imageAssets.find((a) => a.url === url);
                  updateData({
                    refImages: [...refImages, { url, name: asset?.name || `参考图${refImages.length + 1}` }],
                  });
                }}
                onRemove={(index) => {
                  const next = [...refImages];
                  next.splice(index, 1);
                  updateData({ refImages: next });
                }}
              />
            );
          })()}
          <div className="node-body node-editor-body">
        {workflow.type === "text.input" && (() => {
          const initialText = String(workflow.data.prompt || "");
          const templates = ["角色设定：", "场景描述：", "镜头语言：", "情绪氛围："];
          return (
            <div className="node-textarea-wrap">
              <div className="node-prompt-tools">
                {templates.map((template) => (
                  <button
                    key={template}
                    type="button"
                    onClick={(event) => {
                      const textarea = event.currentTarget.closest(".node-textarea-wrap")?.querySelector("textarea");
                      if (!textarea) return;
                      textarea.value = `${textarea.value}${textarea.value ? "\n" : ""}${template}`;
                      updateData({ prompt: textarea.value });
                    }}
                  >
                    {template.replace("：", "")}
                  </button>
                ))}
              </div>
              <textarea
                className="node-inline-textarea nodrag"
                value={initialText}
                placeholder="请输入提示词，可分行描述角色、场景、镜头、风格"
                onChange={(event) => updateData({ prompt: event.currentTarget.value }, { markLocalEdit: true })}
                onBlur={(event) => updateData({ prompt: event.target.value })}
              />
              <button
                className="node-textarea-expand"
                title="放大编辑"
                onClick={() => setExpandedText(true)}
              >
                ⤢
              </button>
            </div>
          );
        })()}
        {workflow.type === "audio.input" && Boolean(workflow.data.url) && (
          <div className="node-media-preview">
            <audio controls src={String(workflow.data.url)} style={{ width: "100%" }} />
          </div>
        )}
        {workflow.type === "video.input" && Boolean(workflow.data.url) && (
          <div className="node-media-preview">
            <video controls src={String(workflow.data.url)} style={{ width: "100%", borderRadius: 12 }} />
          </div>
        )}
        {workflow.type === "image.generate" && (() => {
          const refImages = (workflow.data.refImages || []) as Array<{ url: string; name: string }>;

          const insertMention = (ref: { url: string; name: string }) => {
            const textarea = promptTextareaRef.current;
            if (!textarea) return;
            const cursorPos = textarea.selectionStart;
            const textBeforeCursor = textarea.value.slice(0, cursorPos);
            const atIndex = textBeforeCursor.lastIndexOf("@");
            const before = textarea.value.slice(0, atIndex);
            const after = textarea.value.slice(cursorPos);
            const newValue = `${before}@${ref.name}${after}`;
            textarea.value = newValue;
            setMentionOpen(false);
            requestAnimationFrame(() => {
              const newPos = before.length + ref.name.length + 1;
              textarea.setSelectionRange(newPos, newPos);
              textarea.focus();
            });
          };

          const handleBlur = () => {
            const textarea = promptTextareaRef.current;
            if (!textarea) return;
            updateData({ prompt: textarea.value, promptTouched: true });
          };

          const handleInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
            const value = (event.target as HTMLTextAreaElement).value;
            updateData({ prompt: value, promptTouched: true }, { markLocalEdit: true });
            const cursorPos = (event.target as HTMLTextAreaElement).selectionStart;
            const textBeforeCursor = value.slice(0, cursorPos);
            const atMatch = textBeforeCursor.match(/@(\w*)$/);
            if (atMatch) {
              setMentionOpen(true);
              setMentionFilter(atMatch[1].toLowerCase());
            } else {
              setMentionOpen(false);
            }
          };

          const fullText = String(workflow.data.prompt || "");

          const filteredRefs = refImages.filter((ref) =>
            ref.name.toLowerCase().includes(mentionFilter),
          );

          return (
            <div className="node-generate-editor">
              <div className="node-prompt-wrapper">
                <div className="node-prompt-tools">
                  {[
                    "anime cinematic lighting",
                    "high detail character design",
                    "dynamic composition",
                    "soft color grading",
                  ].map((template) => (
                    <button
                      key={template}
                      type="button"
                      onClick={() => {
                        const textarea = promptTextareaRef.current;
                        if (!textarea) return;
                        textarea.value = `${textarea.value}${textarea.value ? ", " : ""}${template}`;
                        updateData({ prompt: textarea.value, promptTouched: true });
                      }}
                    >
                      {template.split(" ").slice(0, 2).join(" ")}
                    </button>
                  ))}
                  {inputText && (
                    <button
                      type="button"
                      onClick={() => {
                        const textarea = promptTextareaRef.current;
                        if (!textarea) return;
                        textarea.value = `${textarea.value}${textarea.value ? "\n" : ""}${inputText}`;
                        updateData({ prompt: textarea.value, promptTouched: true });
                      }}
                    >
                      插入上游文本
                    </button>
                  )}
                </div>
                <textarea
                  ref={promptTextareaRef}
                  className="node-inline-textarea node-prompt-textarea"
                  defaultValue={fullText}
                  placeholder={refImages.length > 0 ? "输入提示词，使用 @ 引用参考图..." : "请先在上方添加参考图，然后输入提示词"}
                  onInput={handleInput}
                  onBlur={handleBlur}
                />
                {mentionOpen && filteredRefs.length > 0 && (
                  <div className="node-mention-dropdown node-mention-stacked">
                    {filteredRefs.map((ref, index) => (
                      <button
                        key={index}
                        className="node-mention-item"
                        style={{ "--idx": index } as React.CSSProperties}
                        onClick={() => insertMention(ref)}
                      >
                        <img src={ref.url} alt={ref.name} title={`@${ref.name}`} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <select value={String(workflow.data.modelId || "")} onChange={(event) => {
                const newModelId = event.target.value;
                const newModel = models.find((m) => m.id === newModelId);
                const newDefaultParams = (newModel?.defaultParams || {}) as Record<string, unknown>;
                updateData({ modelId: newModelId, params: newDefaultParams });
              }}>
                {models
                  .filter((model) => model.type === "image" && model.enabled !== false)
                  .map((model) => (
                    <option key={String(model.id)} value={String(model.id)}>
                      {String(model.displayName || model.name || model.id)}
                    </option>
                  ))}
              </select>
              <ModelParamControls
                model={models.find((m) => m.id === (workflow.data.modelId || "z-image-turbo"))}
                params={(workflow.data.params || {}) as Record<string, unknown>}
                onChange={(params) => updateData({ params })}
              />
            </div>
          );
        })()}
        {workflow.type === "audio.generate" && (
          <div className="node-generate-editor">
            {inputText && (
              <div className="node-connected-text">
                <span>输入文本</span>
                <p>{inputText}</p>
              </div>
            )}
            <select value={String(workflow.data.modelId || "")} onChange={(event) => {
              const newModelId = event.target.value;
              const newModel = models.find((m) => m.id === newModelId);
              const newDefaultParams = (newModel?.defaultParams || {}) as Record<string, unknown>;
              updateData({ modelId: newModelId, params: newDefaultParams });
            }}>
              {models
                .filter((model) => model.type === "audio" && model.enabled !== false)
                .map((model) => (
                  <option key={String(model.id)} value={String(model.id)}>
                    {String(model.displayName || model.name || model.id)}
                  </option>
                ))}
            </select>
            <ModelParamControls
              model={models.find((m) => m.id === workflow.data.modelId)}
              params={(workflow.data.params || {}) as Record<string, unknown>}
              onChange={(params) => updateData({ params })}
            />
            {Boolean(workflow.data.resultUrl) && <audio controls src={String(workflow.data.resultUrl)} style={{ width: "100%" }} />}
          </div>
        )}
        {workflow.type === "video.generate" && (
          <div className="node-generate-editor">
            {inputText && (
              <div className="node-connected-text">
                <span>输入文本</span>
                <p>{inputText}</p>
              </div>
            )}
            <select value={String(workflow.data.modelId || "")} onChange={(event) => {
              const newModelId = event.target.value;
              const newModel = models.find((m) => m.id === newModelId);
              const newDefaultParams = (newModel?.defaultParams || {}) as Record<string, unknown>;
              updateData({ modelId: newModelId, params: newDefaultParams });
            }}>
              {models
                .filter((model) => model.type === "video" && model.enabled !== false)
                .map((model) => (
                  <option key={String(model.id)} value={String(model.id)}>
                    {String(model.displayName || model.name || model.id)}
                  </option>
                ))}
            </select>
            <ModelParamControls
              model={models.find((m) => m.id === workflow.data.modelId)}
              params={(workflow.data.params || {}) as Record<string, unknown>}
              onChange={(params) => updateData({ params })}
            />
            {inputImages.length > 0 && (
              <div className="node-input-images">
                {inputImages.map((url, index) => (
                  <img key={index} src={url} alt={`输入图 ${index + 1}`} />
                ))}
              </div>
            )}
            {Boolean(workflow.data.resultUrl) && <video controls src={String(workflow.data.resultUrl)} style={{ width: "100%", borderRadius: 12 }} />}
          </div>
        )}
          </div>
        </div>
      )}

      {expanded && isGenerate && (
        <button className="node-run" disabled={!canRun || runtime.status === "running"} onClick={() => onRun(workflow.id)}>
          {runtime.status === "running" ? `生成中 ${runtime.progress || 0}%` : "生成"}
        </button>
      )}
      {isGenerate && !canRun && <div className="node-warning">{readyMessage}</div>}
      {runtime.error && <div className="node-error">{runtime.error}</div>}

      {hasOutput && (
        <div className="port port-output" style={{ top: "50%" }}>
          <HandleShim id="out" type="source" />
        </div>
      )}

      {expandedText && canEditPrompt && (
        <div className="node-text-overlay nodrag" onClick={(e) => e.stopPropagation()}>
          <div className="node-text-overlay-header">
            <span>{isGenerate ? "Prompt 大编辑器" : "编辑文本"}</span>
            <div>
              {isGenerate && inputText && (
                <button
                  type="button"
                  onClick={() => setTextDraft((current) => `${current}${current ? "\n" : ""}${inputText}`)}
                >
                  插入上游
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  saveTextDraft();
                  setExpandedText(false);
                }}
              >
                保存
              </button>
              <button type="button" onClick={() => setExpandedText(false)}>✕</button>
            </div>
          </div>
          <textarea
            className="node-text-overlay-textarea"
            value={textDraft}
            placeholder={isGenerate ? "请输入生成 Prompt" : "请输入提示词"}
            onChange={(event) => setTextDraft(event.target.value)}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}

function HandleShim({ id, type }: { id: string; type: "source" | "target" }) {
  return <Handle id={id} type={type} position={type === "source" ? Position.Right : Position.Left} className="handle" />;
}

const MemoizedWorkflowCard = memo(WorkflowCard, (previous, next) => {
  const previousData = previous.data;
  const nextData = next.data;
  const previousExpanded = Boolean(previousData.expanded);
  const nextExpanded = Boolean(nextData.expanded);
  if (previous.selected !== next.selected) return false;
  if (previousExpanded !== nextExpanded) return false;
  if (previousData.workflow !== nextData.workflow) return false;
  if (previousData.canRun !== nextData.canRun) return false;
  if (previousData.readyMessage !== nextData.readyMessage) return false;
  if (previousData.resultStale !== nextData.resultStale) return false;
  if (previousData.connectedInputs !== nextData.connectedInputs) return false;
  if (previousData.highlightRole !== nextData.highlightRole) return false;
  if (previousExpanded || nextExpanded) {
    if (previousData.assets !== nextData.assets) return false;
    if (previousData.models !== nextData.models) return false;
  }
  return true;
});

export const nodeTypes = { workflow: MemoizedWorkflowCard };
