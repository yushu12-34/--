import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  useViewport,
  ViewportPortal,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { createAsset, createTask, ensureProject, getCanvas, getTask, listAssets, listModels, saveSnapshot } from "../api";
import { getNodeDefinition, nodeDefinitions } from "../nodeDefinitions";
import type { AssetRecord, CanvasRecord, CanvasSnapshot, ProjectRecord, WorkflowEdge, WorkflowGroup, WorkflowNode } from "../types";
import { collectNodeInputs, normalizePortId, validateConnection, validateNodeReady } from "../workflowValidation";
import { topologicalExecutableOrder } from "../workflowGraph";

const LOCAL_SNAPSHOT_KEY = "anime-canvas-local-snapshot";

interface ConnectedInputs {
  texts: string[];
  images: string[];
  audios: string[];
  videos: string[];
}

interface WorkflowNodeData extends Record<string, unknown> {
  workflow: WorkflowNode;
  onPatch: (nodeId: string, patch: Partial<WorkflowNode>) => void;
  onRun: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  canRun: boolean;
  readyMessage?: string;
  connectedInputs: ConnectedInputs;
  assets: AssetRecord[];
  models: Array<Record<string, unknown>>;
  onUploadAsset: (nodeId: string, file: File, type: "image" | "audio" | "video") => Promise<void>;
  onAddAssetAsNode: (nodeId: string, assetUrl: string) => void;
  expanded: boolean;
}

type WorkflowReactNode = Node<WorkflowNodeData, "workflow">;
type WorkflowReactEdge = Edge;

function createId(prefix: string) {
  const randomId = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${randomId}`;
}

function makeWorkflowNode(type: string, position = { x: 120, y: 120 }): WorkflowNode {
  const definition = getNodeDefinition(type);
  const timestamp = new Date().toISOString();
  return {
    id: createId(type),
    type,
    title: definition?.name || type,
    position,
    data: { ...(definition?.defaultData || {}) },
    runtime: { status: "idle", progress: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function getConnectedInputs(nodes: WorkflowNode[], edges: WorkflowEdge[], nodeId: string): ConnectedInputs {
  const incoming = edges.filter((edge) => edge.targetNodeId === nodeId);
  const texts: string[] = [];
  const images: string[] = [];
  const audios: string[] = [];
  const videos: string[] = [];
  for (const edge of incoming) {
    const sourceNode = nodes.find((node) => node.id === edge.sourceNodeId);
    if (!sourceNode) continue;
    const sourceDef = getNodeDefinition(sourceNode.type);
    const outputType = sourceDef?.outputs[0]?.mediaType;
    if (outputType === "text") {
      const prompt = String(sourceNode.data.prompt || "");
      if (prompt) texts.push(prompt);
    }
    if (outputType === "image") {
      const url = String(sourceNode.data.url || sourceNode.data.resultUrl || "");
      if (url) images.push(url);
    }
    if (outputType === "audio") {
      const url = String(sourceNode.data.url || sourceNode.data.resultUrl || "");
      if (url) audios.push(url);
    }
    if (outputType === "video") {
      const url = String(sourceNode.data.url || sourceNode.data.resultUrl || "");
      if (url) videos.push(url);
    }
  }
  return { texts, images, audios, videos };
}

function toReactFlowNodes(
  workflowNodes: WorkflowNode[],
  workflowEdges: WorkflowEdge[],
  onPatch: WorkflowNodeData["onPatch"],
  onRun: WorkflowNodeData["onRun"],
  onDelete: WorkflowNodeData["onDelete"],
  assets: AssetRecord[],
  models: Array<Record<string, unknown>>,
  onUploadAsset: WorkflowNodeData["onUploadAsset"],
  onAddAssetAsNode: WorkflowNodeData["onAddAssetAsNode"],
  expandedNodeId: string | null,
): WorkflowReactNode[] {
  return workflowNodes.map((workflow) => {
    const ready = validateNodeReady(workflowNodes, workflowEdges, workflow.id);
    return {
      id: workflow.id,
      type: "workflow",
      position: workflow.position,
      data: {
        workflow,
        onPatch,
        onRun,
        onDelete,
        canRun: workflow.type.endsWith(".generate") && ready.ready,
        readyMessage: ready.message,
        connectedInputs: getConnectedInputs(workflowNodes, workflowEdges, workflow.id),
        assets,
        models,
        onUploadAsset,
        onAddAssetAsNode,
        expanded: workflow.id === expandedNodeId,
      },
    };
  });
}

function toReactFlowEdges(workflowEdges: WorkflowEdge[]): Edge[] {
  return workflowEdges.map((edge) => ({
    id: edge.id,
    source: edge.sourceNodeId,
    sourceHandle: edge.sourcePortId,
    target: edge.targetNodeId,
    targetHandle: edge.targetPortId,
    animated: true,
    selectable: false,
  }));
}

function fromReactFlowEdges(edges: Edge[]): WorkflowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    sourceNodeId: edge.source,
    sourcePortId: normalizePortId(String(edge.sourceHandle || "")),
    targetNodeId: edge.target,
    targetPortId: normalizePortId(String(edge.targetHandle || "")),
  }));
}

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
    const handleClickOutside = (event: MouseEvent) => {
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

function WorkflowCard({ data, selected }: NodeProps<WorkflowReactNode>) {
  const { workflow, onPatch, onRun, onDelete, canRun, readyMessage, connectedInputs, assets, models, onUploadAsset, onAddAssetAsNode, expanded } = data;
  const definition = getNodeDefinition(workflow.type);
  const runtime = workflow.runtime;
  const isGenerate = definition?.category === "generate";
  const updateData = (patch: Record<string, unknown>) => onPatch(workflow.id, { data: { ...workflow.data, ...patch } });
  const assetType = getNodeAssetType(workflow.type);
  const visibleAssets = assetType ? assets.filter((asset) => asset.type === assetType) : [];
  const previewText = getNodePreviewText(workflow);
  const hasResult = Boolean(workflow.data.resultUrl || workflow.data.url);
  const height = expanded
    ? Math.max(340, 244 + 34)
    : Math.max(248, 150 + 34);
  const hasInput = (definition?.inputs.length || 0) > 0;
  const hasOutput = (definition?.outputs.length || 0) > 0;
  const inputText = connectedInputs.texts.join("\n\n");
  const inputImages = connectedInputs.images;
  const imageAssets = assets.filter((asset) => asset.type === "image");

  return (
    <div className={`node-card ${selected ? "selected" : ""} ${expanded ? "expanded" : ""} ${runtime.status}`} style={{ minHeight: height }}>
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
        <div className="node-floating-toolbar">
          <span>{getNodeIcon(workflow.type)}</span>
          <span>◎</span>
          <span>T</span>
          <span>⧉</span>
          <span>↗</span>
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
        {workflow.type === "text.input" && (
          <textarea
            className="node-inline-textarea"
            value={String(workflow.data.prompt || "")}
            placeholder="请输入提示词"
            onChange={(event) => updateData({ prompt: event.target.value })}
          />
        )}
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
          const [mentionOpen, setMentionOpen] = useState(false);
          const [mentionFilter, setMentionFilter] = useState("");
          const textareaRef = useRef<HTMLTextAreaElement>(null);

          const handlePromptChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
            const value = event.target.value;
            const cursorPos = event.target.selectionStart;
            const textBeforeCursor = value.slice(0, cursorPos);
            const atMatch = textBeforeCursor.match(/@(\w*)$/);
            if (atMatch) {
              setMentionOpen(true);
              setMentionFilter(atMatch[1].toLowerCase());
            } else {
              setMentionOpen(false);
            }
            updateData({ prompt: value });
          };

          const insertMention = (ref: { url: string; name: string }) => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            const currentValue = String(workflow.data.prompt || "");
            const cursorPos = textarea.selectionStart;
            const textBeforeCursor = currentValue.slice(0, cursorPos);
            const atIndex = textBeforeCursor.lastIndexOf("@");
            const before = currentValue.slice(0, atIndex);
            const after = currentValue.slice(cursorPos);
            const newValue = `${before}@${ref.name}${after}`;
            updateData({ prompt: newValue });
            setMentionOpen(false);
            requestAnimationFrame(() => {
              const newPos = before.length + ref.name.length + 1;
              textarea.setSelectionRange(newPos, newPos);
              textarea.focus();
            });
          };

          /* 将 @引用名 渲染为紫色 span */
          const inputPrefix = inputText ? `${inputText}\n\n` : "";
          const promptText = String(workflow.data.prompt || "");
          const fullText = inputPrefix + promptText;
          const parts = fullText.split(/(@[\u4e00-\u9fa5a-zA-Z0-9_]+)/g);
          const renderedText = parts.map((part, i) =>
            part.startsWith("@") ? (
              <span key={i} className="node-prompt-mention">{part}</span>
            ) : (
              part
            ),
          );

          /* 用户编辑时只更新 prompt 部分，保留输入前缀 */
          const handleFullChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
            const newValue = event.target.value;
            if (!inputText) {
              updateData({ prompt: newValue });
              return;
            }
            if (newValue.startsWith(inputPrefix)) {
              updateData({ prompt: newValue.slice(inputPrefix.length) });
            } else {
              updateData({ prompt: newValue });
            }
          };

          const filteredRefs = refImages.filter((ref) =>
            ref.name.toLowerCase().includes(mentionFilter),
          );

          return (
            <div className="node-generate-editor">
              <div className="node-prompt-wrapper">
                {/* 着色镜像层 */}
                <div className="node-prompt-mirror" aria-hidden="true">
                  {renderedText}
                  {"\n"}
                </div>
                <textarea
                  ref={textareaRef}
                  className="node-inline-textarea node-prompt-textarea"
                  value={fullText}
                  placeholder={refImages.length > 0 ? "输入提示词，使用 @ 引用参考图..." : "请先在上方添加参考图，然后输入提示词"}
                  onChange={(event) => {
                    handleFullChange(event);
                    /* 触发 @ 面板检测 */
                    const value = event.target.value;
                    const cursorPos = event.target.selectionStart;
                    const textBeforeCursor = value.slice(0, cursorPos);
                    const atMatch = textBeforeCursor.match(/@(\w*)$/);
                    if (atMatch) {
                      setMentionOpen(true);
                      setMentionFilter(atMatch[1].toLowerCase());
                    } else {
                      setMentionOpen(false);
                    }
                  }}
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
              <select value={String(workflow.data.modelId || "")} onChange={(event) => updateData({ modelId: event.target.value })}>
                {models
                  .filter((model) => model.type === "image" && model.enabled !== false)
                  .map((model) => (
                    <option key={String(model.id)} value={String(model.id)}>
                      {String(model.displayName || model.name || model.id)}
                    </option>
                  ))}
              </select>
              <div className="node-param-row">
                {(() => {
                  const currentModel = models.find((m) => m.id === workflow.data.modelId);
                  const schema = (currentModel?.paramSchema || {}) as Record<string, unknown>;
                  const entries = Object.entries(schema);
                  if (entries.length === 0) return null;
                  return entries.map(([paramKey, paramValues]) => {
                    const values = Array.isArray(paramValues) ? paramValues : [String(paramValues)];
                    const currentParams = (workflow.data.params || {}) as Record<string, unknown>;
                    const defaultValue = String((currentModel?.defaultParams as Record<string, unknown>)?.[paramKey] || values[0] || "");
                    return (
                      <select
                        key={paramKey}
                        value={String(currentParams[paramKey] || defaultValue)}
                        onChange={(event) =>
                          updateData({ params: { ...currentParams, [paramKey]: event.target.value } })
                        }
                      >
                        {values.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                      </select>
                    );
                  });
                })()}
              </div>
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
            <select value={String(workflow.data.modelId || "")} onChange={(event) => updateData({ modelId: event.target.value })}>
              {models
                .filter((model) => model.type === "audio" && model.enabled !== false)
                .map((model) => (
                  <option key={String(model.id)} value={String(model.id)}>
                    {String(model.displayName || model.name || model.id)}
                  </option>
                ))}
            </select>
            <div className="node-param-row">
              {(() => {
                const currentModel = models.find((m) => m.id === workflow.data.modelId);
                const schema = (currentModel?.paramSchema || {}) as Record<string, unknown>;
                const entries = Object.entries(schema);
                if (entries.length === 0) return null;
                return entries.map(([paramKey, paramValues]) => {
                  const values = Array.isArray(paramValues) ? paramValues : [String(paramValues)];
                  const currentParams = (workflow.data.params || {}) as Record<string, unknown>;
                  const defaultValue = String((currentModel?.defaultParams as Record<string, unknown>)?.[paramKey] || values[0] || "");
                  return (
                    <select
                      key={paramKey}
                      value={String(currentParams[paramKey] || defaultValue)}
                      onChange={(event) =>
                        updateData({ params: { ...currentParams, [paramKey]: event.target.value } })
                      }
                    >
                      {values.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                    </select>
                  );
                });
              })()}
            </div>
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
            <select value={String(workflow.data.modelId || "")} onChange={(event) => updateData({ modelId: event.target.value })}>
              {models
                .filter((model) => model.type === "video" && model.enabled !== false)
                .map((model) => (
                  <option key={String(model.id)} value={String(model.id)}>
                    {String(model.displayName || model.name || model.id)}
                  </option>
                ))}
            </select>
            <div className="node-param-row">
              {(() => {
                const currentModel = models.find((m) => m.id === workflow.data.modelId);
                const schema = (currentModel?.paramSchema || {}) as Record<string, unknown>;
                const entries = Object.entries(schema);
                if (entries.length === 0) return null;
                return entries.map(([paramKey, paramValues]) => {
                  const values = Array.isArray(paramValues) ? paramValues : [String(paramValues)];
                  const currentParams = (workflow.data.params || {}) as Record<string, unknown>;
                  const defaultValue = String((currentModel?.defaultParams as Record<string, unknown>)?.[paramKey] || values[0] || "");
                  return (
                    <select
                      key={paramKey}
                      value={String(currentParams[paramKey] || defaultValue)}
                      onChange={(event) =>
                        updateData({ params: { ...currentParams, [paramKey]: event.target.value } })
                      }
                    >
                      {values.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                    </select>
                  );
                });
              })()}
            </div>
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
    </div>
  );
}

function HandleShim({ id, type }: { id: string; type: "source" | "target" }) {
  return <Handle id={id} type={type} position={type === "source" ? Position.Right : Position.Left} className="handle" />;
}

const nodeTypes = { workflow: WorkflowCard };

export function CanvasPage() {
  const { screenToFlowPosition, setViewport, fitView } = useReactFlow<WorkflowReactNode, WorkflowReactEdge>();
  const viewport = useViewport();
  const { zoom } = viewport;
  const containerRef = useRef<HTMLDivElement>(null);
  const baselineZoomRef = useRef<number>(0);
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  viewportRef.current = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [canvas, setCanvas] = useState<CanvasRecord | null>(null);
  const [workflowNodes, setWorkflowNodes] = useState<WorkflowNode[]>([]);
  const [groups, setGroups] = useState<WorkflowGroup[]>([]);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<WorkflowReactNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<WorkflowReactEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [models, setModels] = useState<Array<Record<string, unknown>>>([]);
  const [notice, setNotice] = useState("正在初始化画布…");
  const [selectionNodeIds, setSelectionNodeIds] = useState<string[]>([]);
  const selectionNodeIdsRef = useRef<string[]>([]);
  const [selectionBounds, setSelectionBounds] = useState<WorkflowGroup["bounds"] | null>(null);
  const [nodeLibraryOpen, setNodeLibraryOpen] = useState(false);
  const [draggingTemplate, setDraggingTemplate] = useState<{
    type: string;
    icon: string;
    x: number;
    y: number;
  } | null>(null);

  const workflowEdges = useMemo(() => fromReactFlowEdges(rfEdges), [rfEdges]);

  const patchNode = useCallback((nodeId: string, patch: Partial<WorkflowNode>) => {
    setWorkflowNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? { ...node, ...patch, data: patch.data || node.data, runtime: patch.runtime || node.runtime, updatedAt: new Date().toISOString() }
          : node,
      ),
    );
  }, []);

  const uploadNodeAsset = useCallback(
    async (nodeId: string, file: File, type: "image" | "audio" | "video") => {
      const url = await fileToDataUrl(file);
      patchNode(nodeId, { data: { ...(workflowNodes.find((node) => node.id === nodeId)?.data || {}), url, name: file.name } });
      if (project) {
        const created = await createAsset({ projectId: project.id, type, url, mimeType: file.type, size: file.size, source: "upload" });
        setAssets((current) => [created.asset, ...current]);
      }
    },
    [patchNode, project, workflowNodes],
  );

  const handleAddAssetAsNode = useCallback(
    (targetNodeId: string, assetUrl: string) => {
      const targetNode = workflowNodes.find((node) => node.id === targetNodeId);
      if (!targetNode) return;
      const newNode = makeWorkflowNode("image.input", {
        x: targetNode.position.x - 320,
        y: targetNode.position.y,
      });
      newNode.data = { ...newNode.data, url: assetUrl };
      const newEdge: WorkflowEdge = {
        id: `edge:${newNode.id}:out:${targetNodeId}:in`,
        sourceNodeId: newNode.id,
        sourcePortId: "out",
        targetNodeId,
        targetPortId: "in",
      };
      setWorkflowNodes((current) => [...current, newNode]);
      setRfEdges((current) => [...current, ...toReactFlowEdges([newEdge])]);
    },
    [workflowNodes, setWorkflowNodes, setRfEdges],
  );

  const runNode = useCallback(
    async (nodeId: string) => {
      if (!project || !canvas) return;
      const node = workflowNodes.find((item) => item.id === nodeId);
      if (!node) return;
      const ready = validateNodeReady(workflowNodes, workflowEdges, nodeId);
      if (!ready.ready) {
        patchNode(nodeId, { runtime: { ...node.runtime, status: "failed", error: ready.message } });
        return;
      }
      patchNode(nodeId, { runtime: { status: "running", progress: 10 } });
      try {
        const taskType = node.type as "image.generate" | "audio.generate" | "video.generate";
        const response = await createTask({
          projectId: project.id,
          canvasId: canvas.id,
          nodeId,
          type: taskType,
          modelId: String(node.data.modelId || "z-image-turbo"),
          input: {
            ...collectNodeInputs(workflowNodes, workflowEdges, nodeId),
            params: node.data.params || {},
          },
        });
        patchNode(nodeId, { runtime: { status: "running", progress: response.task.progress || 10, taskId: response.task.id } });
        setNotice("任务已创建，正在后台生成…");

        let latestTask = response.task;
        for (let attempt = 0; attempt < 90 && ["pending", "running"].includes(latestTask.status); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          latestTask = (await getTask(response.task.id)).task;
          patchNode(nodeId, {
            runtime: {
              status: latestTask.status,
              progress: latestTask.progress || 0,
              taskId: latestTask.id,
              error: latestTask.error,
            },
          });
        }

        if (latestTask.status !== "succeeded") throw new Error(latestTask.error || "生成任务未完成");
        const resultUrl = String(latestTask.output?.url || "");
        patchNode(nodeId, {
          data: { ...node.data, resultUrl },
          runtime: { status: "succeeded", progress: 100, taskId: latestTask.id },
        });
        setNotice("图片生成完成，结果已保存到素材库");
        if (project) setAssets((await listAssets(project.id)).assets);
      } catch (error) {
        patchNode(nodeId, {
          runtime: { status: "failed", progress: 0, error: error instanceof Error ? error.message : String(error) },
        });
      }
    },
    [canvas, project, workflowEdges, workflowNodes, patchNode],
  );

  useEffect(() => {
    ensureProject()
      .then(async ({ project: loadedProject, canvases }) => {
        const loadedCanvas = (await getCanvas(canvases[0].id)).canvas;
        setProject(loadedProject);
        setCanvas(loadedCanvas);
        const snapshot = loadedCanvas.snapshot?.nodes?.length ? migrateSnapshot(loadedCanvas.snapshot) : readLocalSnapshot();
        setWorkflowNodes(snapshot.nodes || []);
        setGroups(snapshot.groups || []);
        setRfEdges(toReactFlowEdges(snapshot.edges || []));
        setAssets((await listAssets(loadedProject.id)).assets);
        setModels((await listModels()).models);
        setNotice("画布已连接后端并加载完成");
      })
      .catch(() => {
        const snapshot = readLocalSnapshot();
        setWorkflowNodes(snapshot.nodes);
        setGroups(snapshot.groups || []);
        setRfEdges(toReactFlowEdges(snapshot.edges));
        setNotice("后端不可用，已进入浏览器本地模式");
      });
  }, [setRfEdges]);

  const deleteNode = useCallback((nodeId: string) => {
    setWorkflowNodes((current) => current.filter((node) => node.id !== nodeId));
    setRfEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setGroups((current) =>
      current
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) }))
        .filter((group) => group.nodeIds.length > 1),
    );
    if (expandedNodeId === nodeId) setExpandedNodeId(null);
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  }, [expandedNodeId, selectedNodeId]);

  useEffect(() => {
    setRfNodes(toReactFlowNodes(workflowNodes, workflowEdges, patchNode, runNode, deleteNode, assets, models, uploadNodeAsset, handleAddAssetAsNode, expandedNodeId));
  }, [workflowNodes, workflowEdges, patchNode, runNode, deleteNode, assets, models, uploadNodeAsset, handleAddAssetAsNode, expandedNodeId, setRfNodes]);

  useEffect(() => {
    if (baselineZoomRef.current !== 0 || rfNodes.length === 0) return;
    const timer = window.setTimeout(() => {
      fitView({ duration: 0, padding: 0.15 }).then(() => {
        requestAnimationFrame(() => {
          const fitZoom = viewportRef.current.zoom;
          const desiredZoom = fitZoom * 5.9;
          baselineZoomRef.current = desiredZoom;
          setViewport({ x: viewportRef.current.x, y: viewportRef.current.y, zoom: desiredZoom }, { duration: 0 });
        });
      });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [rfNodes.length, fitView, setViewport]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ZOOM_STEP = 1.03;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y, zoom: currentZoom } = viewportRef.current;
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const newZoom = Math.min(8, Math.max(0.03, currentZoom * factor));
      const ratio = newZoom / currentZoom;
      setViewport(
        { x: cursorX - ratio * (cursorX - x), y: cursorY - ratio * (cursorY - y), zoom: newZoom },
        { duration: 0 },
      );
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [setViewport]);

  useEffect(() => {
    const snapshot = snapshotFromState(workflowNodes, workflowEdges, groups);
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
    if (!canvas || !workflowNodes.length) return;
    const timer = window.setTimeout(() => {
      saveSnapshot(canvas.id, snapshot).catch(() => setNotice("自动保存到后端失败，本地快照仍已保存"));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [canvas, groups, workflowEdges, workflowNodes]);

  const selectedNode = workflowNodes.find((node) => node.id === selectedNodeId) || null;

  const addWorkflowNode = (type: string, position = { x: 180 + workflowNodes.length * 32, y: 120 + workflowNodes.length * 24 }) => {
    const next = makeWorkflowNode(type, position);
    setWorkflowNodes((current) => [...current, next]);
    setSelectedNodeId(next.id);
    setExpandedNodeId(next.id);
  };

  const onConnect = (connection: Connection) => {
    const normalizedConnection = {
      ...connection,
      sourceHandle: normalizePortId(String(connection.sourceHandle || "")),
      targetHandle: normalizePortId(String(connection.targetHandle || "")),
    };
    const validation = validateConnection(workflowNodes, workflowEdges, normalizedConnection);
    if (!validation.valid) {
      setNotice(validation.message || "连接不合法");
      return;
    }
    setRfEdges((current) =>
      addEdge(
        {
          ...connection,
          id: createId("edge"),
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
          animated: true,
        },
        current,
      ),
    );
    setNotice("连接成功");
  };

  const deleteSelected = () => {
    if (!selectedNodeId) return;
    deleteNode(selectedNodeId);
  };

  const saveNow = async () => {
    const snapshot = snapshotFromState(workflowNodes, workflowEdges, groups);
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
    if (!canvas) {
      setNotice("已保存到浏览器本地");
      return;
    }
    await saveSnapshot(canvas.id, snapshot);
    setNotice("已保存到后端快照");
  };

  useEffect(() => {
    if (!draggingTemplate) return;

    const onPointerMove = (event: PointerEvent) => {
      setDraggingTemplate((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
    };

    const onPointerUp = (event: PointerEvent) => {
      const canvasElement = document.querySelector(".canvas-panel");
      const canvasRect = canvasElement?.getBoundingClientRect();
      const isInsideCanvas = Boolean(
        canvasRect
          && event.clientX >= canvasRect.left
          && event.clientX <= canvasRect.right
          && event.clientY >= canvasRect.top
          && event.clientY <= canvasRect.bottom,
      );
      if (isInsideCanvas) {
        addWorkflowNode(draggingTemplate.type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
        setNotice("节点已从节点库拖入画布");
      } else {
        setNotice("已取消拖入节点");
      }
      setDraggingTemplate(null);
      setNodeLibraryOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraggingTemplate(null);
        setNotice("已取消拖入节点");
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [draggingTemplate, screenToFlowPosition, workflowNodes.length]);

  const createGroupFromSelection = useCallback((nodeIds = selectionNodeIdsRef.current) => {
    const selectedNodes = workflowNodes.filter((node) => nodeIds.includes(node.id));
    if (selectedNodes.length < 2) return;
    const selectedNodeIds = selectedNodes.map((node) => node.id);
    const exists = groups.some((group) => sameNodeSet(group.nodeIds, selectedNodeIds));
    const bounds = getGroupBounds(selectedNodes);
    if (exists) {
      setGroups((current) => current.map((group) => sameNodeSet(group.nodeIds, selectedNodeIds) ? { ...group, bounds } : group));
      setSelectionBounds(null);
      return;
    }
    const timestamp = new Date().toISOString();
    setGroups((current) => [
      ...current,
      {
        id: createId("group"),
        title: `组合 ${current.length + 1}`,
        nodeIds: selectedNodeIds,
        bounds,
        createdAt: timestamp,
      },
    ]);
    setSelectionBounds(null);
    setNotice("已根据框选自动创建组合框");
  }, [groups, workflowNodes]);

  useEffect(() => {
    const onPointerUp = () => {
      const nodeIds = selectionNodeIdsRef.current;
      if (nodeIds.length >= 2) window.setTimeout(() => createGroupFromSelection(nodeIds), 0);
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, [createGroupFromSelection]);

  const ungroup = (groupId: string) => {
    setGroups((current) => current.filter((group) => group.id !== groupId));
    setNotice("组合已解除");
  };

  const moveGroup = useCallback((groupId: string, delta: { x: number; y: number }, phase: "start" | "move" | "end") => {
    if (phase === "start") {
      setGroups((current) => current.map((group) => group.id === groupId ? { ...group, dragging: true } : group));
      return;
    }

    setWorkflowNodes((currentNodes) => {
      const activeGroup = groups.find((item) => item.id === groupId);
      if (!activeGroup) return currentNodes;
      const nodeIdSet = new Set(activeGroup.nodeIds);
      const movedNodes = currentNodes.map((node) =>
        nodeIdSet.has(node.id)
          ? { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y }, updatedAt: new Date().toISOString() }
          : node,
      );
      setGroups((currentGroups) =>
        recomputeGroups(
          currentGroups.map((item) => item.id === groupId ? { ...item, dragging: phase !== "end" } : item),
          movedNodes,
        ),
      );
      return movedNodes;
    });
  }, [groups]);

  const runGroup = async (group: WorkflowGroup) => {
    const ordered = topologicalExecutableOrder(group.nodeIds, workflowEdges, workflowNodes);
    setNotice(`开始运行组合：${ordered.length} 个生成节点`);
    for (const node of ordered) {
      await runNode(node.id);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>无限画布 AI 动漫创作工具</strong>
          <span>{project?.name || "本地项目"}</span>
        </div>
        <nav>
          <button className="weui-btn weui-btn_mini weui-btn_primary" onClick={saveNow}>保存</button>
          <button className="weui-btn weui-btn_mini weui-btn_default" onClick={() => (window.location.href = "/admin")}>管理端</button>
        </nav>
      </header>

      {nodeLibraryOpen && (
        <div className="floating-node-library">
          <span className="floating-library-title">添加节点</span>
          <div className="floating-library-list">
            {nodeDefinitions.map((definition) => (
              <button
                key={definition.type}
                className="floating-node-template"
                onClick={() => {
                  addWorkflowNode(definition.type);
                  setNodeLibraryOpen(false);
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  setDraggingTemplate({
                    type: definition.type,
                    icon: getNodeIcon(definition.type),
                    x: event.clientX,
                    y: event.clientY,
                  });
                  setNotice(`拖动「${definition.name}」到画布后松开放置`);
                }}
              >
                <span className="floating-node-icon">{getNodeIcon(definition.type)}</span>
                <strong>{definition.name}</strong>
                {definition.type === "text.input" && <em>Gemini3</em>}
                {definition.type === "image.generate" && <em>Neo Image Pro</em>}
                <small>{definition.description || "配置创作节点"}</small>
              </button>
            ))}
          </div>
          <div className="floating-library-section">临时资源</div>
          <button className="floating-node-template upload-local" type="button">
            <span className="floating-node-icon">⇧</span>
            <strong>上传本地</strong>
            <small>图片、视频、音频</small>
          </button>
        </div>
      )}
      <div className="floating-dock">
        <button className={nodeLibraryOpen ? "active" : ""} title="添加节点" onClick={() => setNodeLibraryOpen((open) => !open)}>
          {nodeLibraryOpen ? "×" : "+"}
        </button>
        <span />
        <button title="素材库">□</button>
        <button title="历史">◷</button>
        <button title="定位">⌖</button>
        <span />
        <button title="设置">⚙</button>
        <button title="帮助">?</button>
        <span />
        <button title="固定">⌖</button>
      </div>
      {draggingTemplate && (
        <div className="node-drag-preview" style={{ left: draggingTemplate.x, top: draggingTemplate.y }}>
          {draggingTemplate.icon}
        </div>
      )}

      <main
        ref={containerRef}
        className={`canvas-panel ${draggingTemplate ? "placing-node" : ""}`}
        onContextMenu={(event) => {
          if (!draggingTemplate) return;
          event.preventDefault();
          setDraggingTemplate(null);
          setNotice("已取消放置节点");
        }}
      >
        <ReactFlow<WorkflowReactNode, WorkflowReactEdge>
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={(_, node, draggedNodes) => {
            const draggedPositions = new Map(
              [node, ...(draggedNodes || [])].map((draggedNode) => [draggedNode.id, draggedNode.position]),
            );
            const nextWorkflowNodes = workflowNodes.map((item) =>
              draggedPositions.has(item.id) ? { ...item, position: draggedPositions.get(item.id)! } : item,
            );
            setWorkflowNodes(nextWorkflowNodes);
            setGroups((currentGroups) => recomputeGroups(currentGroups, nextWorkflowNodes));
            const selectedNodes = nextWorkflowNodes.filter((item) => selectionNodeIds.includes(item.id));
            setSelectionBounds(selectedNodes.length >= 2 ? getGroupBounds(selectedNodes) : null);
          }}
          onNodeClick={(event, node) => {
            if (event.defaultPrevented) return;
            setSelectedNodeId(node.id);
            setExpandedNodeId(node.id);
          }}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setExpandedNodeId(null);
          }}
          onSelectionChange={(params: OnSelectionChangeParams<WorkflowReactNode, WorkflowReactEdge>) => {
            const nodeIds = params.nodes.map((node) => node.id);
            selectionNodeIdsRef.current = nodeIds;
            setSelectionNodeIds(nodeIds);
            const selectedNodes = workflowNodes.filter((node) => nodeIds.includes(node.id));
            setSelectionBounds(selectedNodes.length >= 2 ? getGroupBounds(selectedNodes) : null);
          }}
          selectionKeyCode="Control"
          multiSelectionKeyCode="Control"
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag
          minZoom={0.03}
          maxZoom={8}
          zoomOnPinch
          zoomOnDoubleClick={false}
        >
          <ViewportPortal>
            <GroupOverlay groups={groups} nodes={workflowNodes} zoom={zoom} onUngroup={ungroup} onRun={runGroup} onMove={moveGroup} />
            {selectionBounds && (
              <SelectionGroupPreview
                bounds={selectionBounds}
                onCreate={() => createGroupFromSelection(selectionNodeIds)}
              />
            )}
          </ViewportPortal>
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgba(255, 255, 255, 0.2)" />
          <MiniMap />
          <Controls />
        </ReactFlow>
      </main>

      <footer className="statusbar">
        <span>{notice}</span>
        <span className="statusbar-right">
          <span className="zoom-indicator">{baselineZoomRef.current > 0 ? Math.round(zoom / baselineZoomRef.current * 100) : 100}%</span>
          <span>节点 {workflowNodes.length} · 连线 {workflowEdges.length} · 素材 {assets.length}</span>
        </span>
      </footer>
    </div>
  );
}

function GroupOverlay({
  groups,
  nodes,
  zoom,
  onUngroup,
  onRun,
  onMove,
}: {
  groups: WorkflowGroup[];
  nodes: WorkflowNode[];
  zoom: number;
  onUngroup: (groupId: string) => void;
  onRun: (group: WorkflowGroup) => void;
  onMove: (groupId: string, delta: { x: number; y: number }, phase: "start" | "move" | "end") => void;
}) {
  return (
    <div className="group-layer">
      {groups.map((group) => {
        const bounds = getGroupBounds(nodes.filter((node) => group.nodeIds.includes(node.id)));
        return (
        <div
          key={group.id}
          className={`workflow-group ${group.dragging ? "dragging" : ""}`}
          style={{
            left: bounds.x,
            top: bounds.y,
            width: bounds.width,
            height: bounds.height,
          }}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            event.preventDefault();
            event.stopPropagation();
            const start = { x: event.clientX, y: event.clientY };
            let previous = start;
            onMove(group.id, { x: 0, y: 0 }, "start");
            const onPointerMove = (moveEvent: PointerEvent) => {
              const delta = { x: (moveEvent.clientX - previous.x) / zoom, y: (moveEvent.clientY - previous.y) / zoom };
              previous = { x: moveEvent.clientX, y: moveEvent.clientY };
              onMove(group.id, delta, "move");
            };
            const onPointerUp = () => {
              window.removeEventListener("pointermove", onPointerMove);
              onMove(group.id, { x: 0, y: 0 }, "end");
            };
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp, { once: true });
          }}
        >
          <div className="group-toolbar">
            <span>{group.title}</span>
            <button title="运行组合工作流" onClick={() => onRun(group)}>▶</button>
            <button title="解除组合节点" onClick={() => onUngroup(group.id)}>✕</button>
          </div>
        </div>
      );
      })}
    </div>
  );
}

function SelectionGroupPreview({
  bounds,
  onCreate,
}: {
  bounds: WorkflowGroup["bounds"];
  onCreate: () => void;
}) {
  return (
    <div
      className="workflow-group selection-preview"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
    >
      <div className="group-toolbar">
        <span>选区</span>
        <button title="创建组合节点" onClick={onCreate}>＋</button>
      </div>
    </div>
  );
}

function snapshotFromState(nodes: WorkflowNode[], edges: WorkflowEdge[], groups: WorkflowGroup[]): CanvasSnapshot {
  return {
    nodes,
    edges,
    groups,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function readLocalSnapshot(): CanvasSnapshot {
  const fallback: CanvasSnapshot = {
    nodes: [
      makeWorkflowNode("text.input", { x: 120, y: 160 }),
      makeWorkflowNode("image.generate", { x: 520, y: 160 }),
    ],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const raw = localStorage.getItem(LOCAL_SNAPSHOT_KEY);
  if (!raw) return fallback;
  try {
    const snapshot = JSON.parse(raw) as CanvasSnapshot;
    return migrateSnapshot(snapshot);
  } catch {
    return fallback;
  }
}

function migrateSnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  const edges = (snapshot.edges || []).map((edge) => ({
    ...edge,
    sourcePortId: "out",
    targetPortId: "in",
  }));
  return { ...snapshot, edges };
}

function getNodePreviewText(node: WorkflowNode) {
  if (node.type === "text.input") return String(node.data.prompt || "输入提示词生成文本").slice(0, 48);
  if (node.type === "image.input") return node.data.url ? "图片素材已就绪" : "上传图片作为参考";
  if (node.type === "audio.input") return node.data.name ? String(node.data.name) : "上传音频素材";
  if (node.type === "video.input") return node.data.name ? String(node.data.name) : "上传视频素材";
  if (node.type === "image.generate") return node.data.resultUrl ? "图片生成完成" : "连接文本后生成图片";
  if (node.type === "audio.generate") return "音频生成节点已预留接口";
  if (node.type === "video.generate") return "视频生成节点已预留接口";
  return "配置节点内容";
}

function getNodeIcon(type: string) {
  if (type === "text.input") return "Aa";
  if (type === "image.input") return "▣";
  if (type === "audio.input") return "♪";
  if (type === "video.input") return "▶";
  if (type === "image.generate") return "✦";
  if (type === "audio.generate") return "♫";
  if (type === "video.generate") return "⯈";
  return "●";
}

function getNodeAssetType(type: string): AssetRecord["type"] | undefined {
  if (type.includes("image")) return "image";
  if (type.includes("audio")) return "audio";
  if (type.includes("video")) return "video";
  return undefined;
}

function sameNodeSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function getGroupBounds(nodes: WorkflowNode[]) {
  const padding = 42;
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + getNodeVisualSize(node).width));
  const maxY = Math.max(...nodes.map((node) => node.position.y + getNodeVisualSize(node).height));
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

function getNodeVisualSize(node: WorkflowNode) {
  const expanded = false;
  return {
    width: expanded ? 500 : 286,
    height: expanded ? 340 : 248,
  };
}

function recomputeGroups(groups: WorkflowGroup[], nodes: WorkflowNode[]) {
  return groups.map((group) => {
    const groupNodes = nodes.filter((node) => group.nodeIds.includes(node.id));
    if (!groupNodes.length) return group;
    return {
      ...group,
      bounds: getGroupBounds(groupNodes),
    };
  });
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


