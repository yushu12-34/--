import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  getBezierPath,
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
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { compactYjsDocument, copyCanvas, copyProject, createAsset, createCanvas, createProject, createTask, createUser, deleteAsset, deleteCanvas, deleteProject, ensureProject, exportProject, getCanvas, getProject, getTask, getYjsHistorySnapshot, importProject, listAssets, listModels, listProjects, listUsers, listYjsHistory, saveSnapshot, updateAsset, updateCanvas, updateProject } from "../api";
import { createCollaborationClient, type CollaborationStatus, type CollaborationUser } from "../collaboration";
import { getNodeDefinition, nodeDefinitions } from "../nodeDefinitions";
import type { AssetRecord, CanvasRecord, CanvasSnapshot, ProjectBundle, ProjectRecord, UserRecord, WorkflowEdge, WorkflowGroup, WorkflowNode, YjsSnapshotDetail, YjsSnapshotRecord } from "../types";
import { collectNodeInputs, normalizePortId, validateConnection, validateNodeReady } from "../workflowValidation";
import { topologicalExecutableOrder } from "../workflowGraph";
import {
  applySnapshotToYDoc,
  applyYCanvasUpdate,
  canRedoYCanvas,
  canUndoYCanvas,
  createYCanvasDocument,
  encodeYCanvasDiffUpdate,
  encodeYCanvasStateVector,
  observeYCanvas,
  patchYCanvasGroup,
  patchYCanvasNode,
  redoYCanvas,
  removeYCanvasEdge,
  removeYCanvasGroup,
  removeYCanvasNode,
  transactYCanvas,
  undoYCanvas,
  upsertYCanvasEdge,
  upsertYCanvasEdges,
  upsertYCanvasGroup,
  upsertYCanvasGroups,
  upsertYCanvasNode,
  upsertYCanvasNodes,
  Y_CANVAS_HISTORY_ORIGIN,
  Y_CANVAS_LOAD_ORIGIN,
  Y_CANVAS_LOCAL_ORIGIN,
  Y_CANVAS_REMOTE_ORIGIN,
} from "../yCanvasDocument";

const LOCAL_SNAPSHOT_KEY = "anime-canvas-local-snapshot";

interface ConnectedInputs {
  texts: string[];
  images: string[];
  audios: string[];
  videos: string[];
}

type PublicParamType = "string" | "number" | "boolean";
type PublicParamControl = "select" | "input" | "checkbox";

interface PublicParamConfig {
  key: string;
  label: string;
  type: PublicParamType;
  control: PublicParamControl;
  options: unknown[];
  defaultValue?: unknown;
  required: boolean;
}

interface WorkflowNodeData extends Record<string, unknown> {
  workflow: WorkflowNode;
  onPatch: (nodeId: string, patch: Partial<WorkflowNode>, options?: { markLocalEdit?: boolean }) => void;
  onRun: (nodeId: string, options?: { force?: boolean }) => Promise<boolean>;
  onDelete: (nodeId: string) => void;
  canRun: boolean;
  readyMessage?: string;
  inputSignature?: string;
  resultStale?: boolean;
  connectedInputs: ConnectedInputs;
  assets: AssetRecord[];
  models: Array<Record<string, unknown>>;
  onUploadAsset: (nodeId: string, file: File, type: "image" | "audio" | "video") => Promise<void>;
  onAddAssetAsNode: (nodeId: string, assetUrl: string) => void;
  onSaveResultAsset: (nodeId: string) => Promise<void>;
  onCopyResultUrl: (nodeId: string) => Promise<void>;
  onPreviewResult: (nodeId: string) => void;
  expanded: boolean;
}

type WorkflowReactNode = Node<WorkflowNodeData, "workflow">;
type WorkflowEdgeData = { onSelect: (edgeId: string) => void; selected: boolean };
type WorkflowReactEdge = Edge<WorkflowEdgeData, "workflow">;

function formatHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatOptionalTime(value?: string) {
  if (!value) return "暂无记录";
  return formatHistoryTime(value);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function summarizeSnapshot(snapshot: CanvasSnapshot | null | undefined) {
  return {
    nodes: snapshot?.nodes?.length || 0,
    edges: snapshot?.edges?.length || 0,
    groups: snapshot?.groups?.length || 0,
  };
}

function validateProjectBundleForImport(value: unknown): value is ProjectBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bundle = value as Partial<ProjectBundle>;
  if (bundle.version !== 1) return false;
  if (!bundle.project || typeof bundle.project !== "object") return false;
  if (!Array.isArray(bundle.canvases) || bundle.canvases.length === 0) return false;
  if (bundle.assets !== undefined && !Array.isArray(bundle.assets)) return false;
  if (bundle.workflowUpdates !== undefined && !Array.isArray(bundle.workflowUpdates)) return false;
  if (bundle.workflowSnapshots !== undefined && !Array.isArray(bundle.workflowSnapshots)) return false;
  return bundle.canvases.every((canvas) =>
    Boolean(canvas?.id)
      && (!canvas.snapshot || (
        typeof canvas.snapshot === "object"
        && Array.isArray(canvas.snapshot.nodes)
        && Array.isArray(canvas.snapshot.edges)
      )),
  );
}

function WorkflowEdge(props: EdgeProps<WorkflowReactEdge>) {
  const [edgePath] = getBezierPath(props);
  return (
    <>
      <BaseEdge path={edgePath} markerEnd={props.markerEnd} style={props.style} />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="workflow-edge-hit-area"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          props.data?.onSelect(props.id);
        }}
      />
      {props.data?.selected && <BaseEdge path={edgePath} style={{ stroke: "rgba(141, 124, 255, 0.95)", strokeWidth: 3 }} />}
    </>
  );
}

const edgeTypes = { workflow: WorkflowEdge };

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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getNodeInputSignature(node: WorkflowNode, nodes: WorkflowNode[], edges: WorkflowEdge[], model?: Record<string, unknown>) {
  const connectedInputs = getConnectedInputs(nodes, edges, node.id);
  const defaultParams = (model?.defaultParams || {}) as Record<string, unknown>;
  const nodeParams = pickPublicParams(model, (node.data.params || {}) as Record<string, unknown>);
  return stableStringify({
    connectedInputs,
    prompt: node.data.prompt || "",
    refImages: node.data.refImages || [],
    modelId: node.data.modelId || model?.id || "",
    params: { ...defaultParams, ...nodeParams },
  });
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
  onSaveResultAsset: WorkflowNodeData["onSaveResultAsset"],
  onCopyResultUrl: WorkflowNodeData["onCopyResultUrl"],
  onPreviewResult: WorkflowNodeData["onPreviewResult"],
  expandedNodeId: string | null,
): WorkflowReactNode[] {
  return workflowNodes.map((workflow) => {
    const ready = validateNodeReady(workflowNodes, workflowEdges, workflow.id);
    const currentModel = models.find((model) => model.id === (workflow.data.modelId || "z-image-turbo"));
    const inputSignature = workflow.type.endsWith(".generate") ? getNodeInputSignature(workflow, workflowNodes, workflowEdges, currentModel) : undefined;
    const resultStale = Boolean(inputSignature && workflow.data.resultUrl && workflow.runtime.inputSignature && workflow.runtime.inputSignature !== inputSignature);
    return {
      id: workflow.id,
      type: "workflow",
      position: workflow.position,
      style: {
        width: workflow.id === expandedNodeId ? 500 : 286,
        minHeight: workflow.id === expandedNodeId ? 340 : 248,
      },
      zIndex: workflow.id === expandedNodeId ? 1000 : 0,
      data: {
        workflow,
        onPatch,
        onRun,
        onDelete,
        canRun: workflow.type.endsWith(".generate") && ready.ready,
        readyMessage: ready.message,
        inputSignature,
        resultStale,
        connectedInputs: getConnectedInputs(workflowNodes, workflowEdges, workflow.id),
        assets,
        models,
        onUploadAsset,
        onAddAssetAsNode,
        onSaveResultAsset,
        onCopyResultUrl,
        onPreviewResult,
        expanded: workflow.id === expandedNodeId,
      },
    };
  });
}

function toReactFlowEdges(workflowEdges: WorkflowEdge[], selectedEdgeId?: string | null, onSelect?: (edgeId: string) => void): WorkflowReactEdge[] {
  return workflowEdges.map((edge) => ({
    id: edge.id,
    type: "workflow",
    source: edge.sourceNodeId,
    sourceHandle: edge.sourcePortId,
    target: edge.targetNodeId,
    targetHandle: edge.targetPortId,
    animated: true,
    selectable: false,
    focusable: false,
    data: {
      onSelect: onSelect || (() => {}),
      selected: edge.id === selectedEdgeId,
    },
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

function normalizePublicParamConfig(key: string, config: unknown): PublicParamConfig {
  if (Array.isArray(config)) {
    return {
      key,
      label: key,
      type: "string",
      control: config.length > 0 ? "select" : "input",
      options: config,
      required: false,
    };
  }

  if (config && typeof config === "object") {
    const record = config as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options
      : Array.isArray(record.values)
        ? record.values
        : [];
    const type: PublicParamType = record.type === "number" || record.type === "boolean" ? record.type : "string";
    const configuredControl = record.control === "input" || record.control === "checkbox" || record.control === "select"
      ? record.control
      : undefined;
    const control: PublicParamControl = configuredControl === "select" && options.length === 0
      ? type === "boolean" ? "checkbox" : "input"
      : configuredControl || (options.length > 0 ? "select" : type === "boolean" ? "checkbox" : "input");
    return {
      key,
      label: String(record.label || key),
      type,
      control,
      options,
      defaultValue: record.defaultValue,
      required: record.required === true,
    };
  }

  return {
    key,
    label: key,
    type: "string",
    control: "select",
    options: [config],
    required: false,
  };
}

function getModelParamConfigs(model?: Record<string, unknown>): PublicParamConfig[] {
  const schema = (model?.paramSchema || {}) as Record<string, unknown>;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  return Object.entries(schema)
    .filter(([, config]) => {
      if (!config || typeof config !== "object" || Array.isArray(config)) return true;
      return (config as Record<string, unknown>).publicVisible !== false;
    })
    .map(([key, config]) => normalizePublicParamConfig(key, config));
}

function hasOwnParam(params: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(params, key);
}

function getParamValue(config: PublicParamConfig, params: Record<string, unknown>, defaults: Record<string, unknown>) {
  if (hasOwnParam(params, config.key)) return params[config.key];
  if (hasOwnParam(defaults, config.key)) return defaults[config.key];
  if (config.defaultValue !== undefined) return config.defaultValue;
  if (config.options.length > 0) return config.options[0];
  if (config.type === "boolean") return false;
  return "";
}

function coerceNodeParamValue(value: string | boolean, type: PublicParamType): unknown {
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || value.trim() === "是";
  }
  if (type === "number") {
    const nextValue = Number(value);
    return Number.isFinite(nextValue) ? nextValue : 0;
  }
  return String(value);
}

function getCheckedParamValue(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "是";
}

function pickPublicParams(model: Record<string, unknown> | undefined, params: Record<string, unknown>) {
  const configs = getModelParamConfigs(model);
  if (configs.length === 0) return params;
  const keys = new Set(configs.map((config) => config.key));
  return Object.fromEntries(Object.entries(params).filter(([key]) => keys.has(key)));
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
  const { workflow, onPatch, onRun, onDelete, canRun, readyMessage, resultStale, connectedInputs, assets, models, onUploadAsset, onAddAssetAsNode, onSaveResultAsset, onCopyResultUrl, onPreviewResult, expanded } = data;
  const definition = getNodeDefinition(workflow.type);
  const runtime = workflow.runtime;
  const isGenerate = definition?.category === "generate";
  const updateData = (patch: Record<string, unknown>, options?: { markLocalEdit?: boolean }) => onPatch(workflow.id, { data: { ...workflow.data, ...patch } }, options);
  const assetType = getNodeAssetType(workflow.type);
  const visibleAssets = assetType ? assets.filter((asset) => asset.type === assetType) : [];
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
  const imageAssets = assets.filter((asset) => asset.type === "image");
  const [expandedText, setExpandedText] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const statusLabel = runtime.cacheHit ? "缓存命中" : runtime.status === "pending" ? "排队中" : runtime.status === "running" ? "运行中" : runtime.status === "succeeded" ? "成功" : runtime.status === "failed" ? "失败" : runtime.status === "cancelled" ? "已取消" : "待运行";

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
                defaultValue={initialText}
                placeholder="请输入提示词，可分行描述角色、场景、镜头、风格"
                onInput={(event) => updateData({ prompt: event.currentTarget.value }, { markLocalEdit: true })}
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

      {expandedText && workflow.type === "text.input" && (
        <div className="node-text-overlay nodrag" onClick={(e) => e.stopPropagation()}>
          <div className="node-text-overlay-header">
            <span>编辑文本</span>
            <button onClick={() => setExpandedText(false)}>✕</button>
          </div>
          <textarea
            className="node-text-overlay-textarea"
            defaultValue={String(workflow.data.prompt || "")}
            placeholder="请输入提示词"
            onBlur={(event) => updateData({ prompt: event.target.value })}
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

const nodeTypes = { workflow: WorkflowCard };

export function CanvasPage() {
  const { screenToFlowPosition, setViewport, fitView } = useReactFlow<WorkflowReactNode, WorkflowReactEdge>();
  const viewport = useViewport();
  const { zoom } = viewport;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  viewportRef.current = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [canvases, setCanvases] = useState<CanvasRecord[]>([]);
  const [canvas, setCanvas] = useState<CanvasRecord | null>(null);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [currentUser, setCurrentUser] = useState<UserRecord | null>(null);
  const [workflowNodes, setWorkflowNodes] = useState<WorkflowNode[]>([]);
  const [groups, setGroups] = useState<WorkflowGroup[]>([]);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<WorkflowReactNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<WorkflowReactEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [yjsHistory, setYjsHistory] = useState<YjsSnapshotRecord[]>([]);
  const [selectedYjsHistoryDetail, setSelectedYjsHistoryDetail] = useState<YjsSnapshotDetail | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRestoreSummary, setHistoryRestoreSummary] = useState<{
    before: ReturnType<typeof summarizeSnapshot>;
    after: ReturnType<typeof summarizeSnapshot>;
  } | null>(null);
  const [assetFilter, setAssetFilter] = useState<"all" | "image" | "audio" | "video">("all");
  const [previewAsset, setPreviewAsset] = useState<AssetRecord | null>(null);
  const [previewResult, setPreviewResult] = useState<{ url: string; type: "image" | "audio" | "video"; title: string } | null>(null);
  const [models, setModels] = useState<Array<Record<string, unknown>>>([]);
  const [notice, setNotice] = useState("正在初始化画布…");
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationStatus>("offline");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [collaborationUsers, setCollaborationUsers] = useState<CollaborationUser[]>([]);
  const [collaborationConflict, setCollaborationConflict] = useState<{
    nodeId: string;
    nodeTitle: string;
    remoteUserName: string;
    detectedAt: string;
  } | null>(null);
  const collaborationClientRef = useRef<ReturnType<typeof createCollaborationClient> | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const localUserRef = useRef<CollaborationUser>({
    id: localStorage.getItem("anime-canvas-user-id") || createId("user"),
    name: `用户${Math.floor(Math.random() * 900 + 100)}`,
    color: ["#8b6cff", "#36d1dc", "#f85bbd", "#10b981"][Math.floor(Math.random() * 4)],
  });
  useEffect(() => {
    localStorage.setItem("anime-canvas-user-id", localUserRef.current.id);
  }, []);
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number; nodeId?: string } | null>(null);
  const isDraggingNodeRef = useRef(false);
  const groupDragRef = useRef<{
    groupId: string;
    startBounds: WorkflowGroup["bounds"];
    startNodePositions: Record<string, { x: number; y: number }>;
  } | null>(null);
  const activeTaskPollsRef = useRef(new Set<string>());
  const applyingRemoteSnapshotRef = useRef(false);
  const snapshotVersionRef = useRef(0);
  const collaborationBroadcastTimerRef = useRef(0);
  const localEditUntilRef = useRef(0);
  const historyRef = useRef<{ past: CanvasSnapshot[]; future: CanvasSnapshot[]; restoring: boolean }>({ past: [], future: [], restoring: false });
  const currentSnapshotRef = useRef<CanvasSnapshot | null>(null);
  const dragHistoryBaselineRef = useRef<CanvasSnapshot | null>(null);
  const yCanvasRef = useRef<ReturnType<typeof createYCanvasDocument> | null>(null);
  if (!yCanvasRef.current) yCanvasRef.current = createYCanvasDocument();
  const applyingYCanvasSnapshotRef = useRef(false);
  const syncingReactStateToYDocRef = useRef(false);
  const skipNextYDocSyncRef = useRef(false);
  const yjsBroadcastTimerRef = useRef(0);
  const lastYjsUpdateRef = useRef<Uint8Array | null>(null);
  const workflowNodesRef = useRef<WorkflowNode[]>([]);
  const workflowEdgesRef = useRef<WorkflowEdge[]>([]);
  const groupsRef = useRef<WorkflowGroup[]>([]);
  const expandedNodeIdRef = useRef<string | null>(null);
  const selectedNodeIdRef = useRef<string | null>(null);
  const collaborationUsersRef = useRef<CollaborationUser[]>([]);

  const workflowEdges = useMemo(() => fromReactFlowEdges(rfEdges), [rfEdges]);
  useEffect(() => {
    workflowNodesRef.current = workflowNodes;
  }, [workflowNodes]);
  useEffect(() => {
    workflowEdgesRef.current = workflowEdges;
  }, [workflowEdges]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  useEffect(() => {
    expandedNodeIdRef.current = expandedNodeId;
  }, [expandedNodeId]);
  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);
  useEffect(() => {
    collaborationUsersRef.current = collaborationUsers;
  }, [collaborationUsers]);
  const filteredAssets = useMemo(
    () => assetFilter === "all" ? assets : assets.filter((asset) => asset.type === assetFilter),
    [assetFilter, assets],
  );

  const selectEdge = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
    setExpandedNodeId(null);
  }, []);

  const applySnapshotFromYCanvas = useCallback((snapshot: CanvasSnapshot, options: { resetSelection?: boolean } = {}) => {
    const migrated = migrateSnapshot(snapshot);
    applyingYCanvasSnapshotRef.current = true;
    setWorkflowNodes(migrated.nodes || []);
    setGroups(migrated.groups || []);
    setRfEdges(toReactFlowEdges(migrated.edges || []));
    window.setTimeout(() => {
      applyingYCanvasSnapshotRef.current = false;
    }, 0);
    if (options.resetSelection) {
      setSelectedNodeId(null);
      setExpandedNodeId(null);
      setSelectedEdgeId(null);
      setSelectionBounds(null);
    }
  }, [setRfEdges]);

  useEffect(() => {
    const yCanvas = yCanvasRef.current;
    if (!yCanvas) return;
    return observeYCanvas(yCanvas, (snapshot, transaction, update) => {
      if (transaction.origin === Y_CANVAS_LOCAL_ORIGIN && syncingReactStateToYDocRef.current) return;
      skipNextYDocSyncRef.current = true;
      applySnapshotFromYCanvas(snapshot);
      if (transaction.origin === Y_CANVAS_REMOTE_ORIGIN || transaction.origin === Y_CANVAS_LOAD_ORIGIN) return;
      if (!update) return;
      lastYjsUpdateRef.current = update;
      window.clearTimeout(yjsBroadcastTimerRef.current);
      yjsBroadcastTimerRef.current = window.setTimeout(() => {
        const update = lastYjsUpdateRef.current;
        if (update) collaborationClientRef.current?.sendYjsUpdate(update);
      }, 80);
    });
  }, [applySnapshotFromYCanvas]);

  useEffect(() => {
    return () => {
      yCanvasRef.current?.destroy();
      yCanvasRef.current = null;
    };
  }, []);

  const displayEdges = useMemo<WorkflowReactEdge[]>(() =>
    rfEdges.map((edge) => ({
      ...edge,
      type: "workflow",
      selectable: false,
      focusable: false,
      data: { onSelect: selectEdge, selected: edge.id === selectedEdgeId },
    })),
    [rfEdges, selectEdge, selectedEdgeId],
  );

  const patchNode = useCallback((nodeId: string, patch: Partial<WorkflowNode>, options: { markLocalEdit?: boolean } = {}) => {
    if (options.markLocalEdit) {
      localEditUntilRef.current = Date.now() + 2500;
      setCollaborationConflict((current) => current?.nodeId === nodeId ? null : current);
    }
    const yCanvas = yCanvasRef.current;
    if (yCanvas) patchYCanvasNode(yCanvas, nodeId, patch, Y_CANVAS_LOCAL_ORIGIN);
    setWorkflowNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              ...patch,
              data: patch.data ? { ...node.data, ...patch.data } : node.data,
              runtime: patch.runtime ? { ...node.runtime, ...patch.runtime } : node.runtime,
              updatedAt: new Date().toISOString(),
            }
          : node,
      ),
    );
  }, []);

  const patchNodeFromUi = useCallback((nodeId: string, patch: Partial<WorkflowNode>, options: { markLocalEdit?: boolean } = {}) => {
    patchNode(nodeId, patch, { markLocalEdit: options.markLocalEdit ?? true });
  }, [patchNode]);

  const syncTaskToNode = useCallback(
    async (nodeId: string, taskId: string) => {
      const task = (await getTask(taskId)).task;
      patchNode(nodeId, {
        data: task.status === "succeeded" ? { resultUrl: String(task.output?.url || "") } : undefined,
        runtime: {
          status: task.status,
          progress: task.status === "succeeded" ? 100 : task.progress || 0,
          taskId: task.id,
          error: task.error,
        },
      });
      if (task.status === "succeeded" && project) {
        setNotice("图片生成完成，结果已保存到素材库");
        setAssets((await listAssets(project.id)).assets);
      }
      return task;
    },
    [patchNode, project],
  );

  const pollTaskUntilSettled = useCallback(
    async (nodeId: string, taskId: string, pollIntervalMs = 2000, timeoutMs = 120000) => {
      if (activeTaskPollsRef.current.has(taskId)) return;
      activeTaskPollsRef.current.add(taskId);
      let consecutiveErrors = 0;
      const startTime = Date.now();
      try {
        let task;
        try {
          task = await syncTaskToNode(nodeId, taskId);
        } catch (err) {
          consecutiveErrors++;
          task = null;
        }
        while (!task || ["pending", "running"].includes(task.status)) {
          if (Date.now() - startTime >= timeoutMs) {
            setNotice(`任务超时（${Math.round(timeoutMs / 1000)}秒），已停止轮询`);
            patchNode(nodeId, { runtime: { status: "failed", progress: 0, error: `任务超时（${Math.round(timeoutMs / 1000)}秒）` } });
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, pollIntervalMs));
          try {
            task = await syncTaskToNode(nodeId, taskId);
            consecutiveErrors = 0;
          } catch (error) {
            consecutiveErrors++;
            if (consecutiveErrors >= 10) {
              setNotice(`任务状态同步失败，已停止轮询：${error instanceof Error ? error.message : String(error)}`);
              break;
            }
          }
        }
        return task;
      } finally {
        activeTaskPollsRef.current.delete(taskId);
      }
    },
    [patchNode, syncTaskToNode],
  );

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

  const saveNodeResultAsAsset = useCallback(async (nodeId: string) => {
    const node = workflowNodes.find((item) => item.id === nodeId);
    const url = String(node?.data.resultUrl || node?.data.url || "");
    if (!node || !project || !url) return;
    const type = node.type.includes("audio") ? "audio" : node.type.includes("video") ? "video" : "image";
    const created = await createAsset({
      projectId: project.id,
      type,
      url,
      name: `${node.title} 结果`,
      mimeType: type === "image" ? "image/png" : type === "audio" ? "audio/mpeg" : "video/mp4",
      size: 0,
      source: "ai-generated",
      createdBy: currentUser?.id,
    });
    setAssets((current) => [created.asset, ...current]);
    setAssetLibraryOpen(true);
    setNotice("节点结果已保存到素材库");
  }, [currentUser, project, workflowNodes]);

  const copyNodeResultUrl = useCallback(async (nodeId: string) => {
    const node = workflowNodes.find((item) => item.id === nodeId);
    const url = String(node?.data.resultUrl || node?.data.url || "");
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setNotice("节点结果 URL 已复制");
  }, [workflowNodes]);

  const previewNodeResult = useCallback((nodeId: string) => {
    const node = workflowNodes.find((item) => item.id === nodeId);
    const url = String(node?.data.resultUrl || node?.data.url || "");
    if (!node || !url) return;
    const type = node.type.includes("audio") ? "audio" : node.type.includes("video") ? "video" : "image";
    setPreviewResult({ url, type, title: node.title });
  }, [workflowNodes]);

  const addAssetNode = useCallback((asset: AssetRecord, position = { x: 180 + workflowNodes.length * 36, y: 160 + workflowNodes.length * 24 }) => {
    const type = asset.type === "image" ? "image.input" : asset.type === "audio" ? "audio.input" : "video.input";
    const next = makeWorkflowNode(type, position);
    next.data = { ...next.data, url: asset.url, name: asset.name || asset.url.slice(0, 32) };
    const yCanvas = yCanvasRef.current;
    if (yCanvas) upsertYCanvasNode(yCanvas, next, Y_CANVAS_LOCAL_ORIGIN);
    setWorkflowNodes((current) => [...current, next]);
    setSelectedNodeId(next.id);
    setExpandedNodeId(next.id);
    setAssetLibraryOpen(false);
    setNotice("已从素材创建节点");
  }, [workflowNodes.length]);

  const renameAsset = useCallback(async (asset: AssetRecord) => {
    const name = window.prompt("请输入素材名称", asset.name || "");
    if (name === null) return;
    const updated = (await updateAsset(asset.id, { name })).asset;
    setAssets((current) => current.map((item) => item.id === updated.id ? updated : item));
    if (previewAsset?.id === updated.id) setPreviewAsset(updated);
  }, [previewAsset]);

  const removeAsset = useCallback(async (asset: AssetRecord) => {
    if (!window.confirm("确定删除这个素材吗？")) return;
    await deleteAsset(asset.id);
    setAssets((current) => current.filter((item) => item.id !== asset.id));
    if (previewAsset?.id === asset.id) setPreviewAsset(null);
  }, [previewAsset]);

  const copyAssetUrl = useCallback(async (asset: AssetRecord) => {
    await navigator.clipboard.writeText(asset.url);
    setNotice("素材 URL 已复制");
  }, []);

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
      const yCanvas = yCanvasRef.current;
      if (yCanvas) {
        upsertYCanvasNodes(yCanvas, [newNode], Y_CANVAS_LOCAL_ORIGIN);
        upsertYCanvasEdges(yCanvas, [newEdge], Y_CANVAS_LOCAL_ORIGIN);
      }
      setWorkflowNodes((current) => [...current, newNode]);
      setRfEdges((current) => [...current, ...toReactFlowEdges([newEdge])]);
    },
    [workflowNodes, setWorkflowNodes, setRfEdges],
  );

  const runNode = useCallback(
    async (nodeId: string, options: { force?: boolean } = {}) => {
      if (!project || !canvas) return false;
      const node = workflowNodes.find((item) => item.id === nodeId);
      if (!node) return false;
      const ready = validateNodeReady(workflowNodes, workflowEdges, nodeId);
      if (!ready.ready) {
        patchNode(nodeId, { runtime: { ...node.runtime, status: "failed", error: ready.message } });
        return false;
      }
      try {
        const taskType = node.type as "image.generate" | "audio.generate" | "video.generate";
        const currentModel = models.find((m) => m.id === (node.data.modelId || "z-image-turbo"));
        const defaultParams = (currentModel?.defaultParams || {}) as Record<string, unknown>;
        const nodeParams = pickPublicParams(currentModel, (node.data.params || {}) as Record<string, unknown>);
        const inputSignature = getNodeInputSignature(node, workflowNodes, workflowEdges, currentModel);
        if (!options.force && node.data.resultUrl && node.runtime.inputSignature === inputSignature) {
          patchNode(nodeId, { runtime: { status: "succeeded", progress: 100, inputSignature, cacheHit: true, error: undefined } });
          setNotice("输入未变化，已使用缓存结果");
          return true;
        }
        patchNode(nodeId, { runtime: { status: "pending", progress: 0, inputSignature, cacheHit: false, error: undefined } });
        const inputValues = collectNodeInputs(workflowNodes, workflowEdges, nodeId);
        const response = await createTask({
          projectId: project.id,
          canvasId: canvas.id,
          nodeId,
          type: taskType,
          modelId: String(node.data.modelId || "z-image-turbo"),
          input: {
            ...inputValues,
            prompt: String(node.data.prompt || inputValues.prompt || ""),
            params: { ...defaultParams, ...nodeParams },
          },
        });
        patchNode(nodeId, { runtime: { status: "running", progress: response.task.progress || 10, taskId: response.task.id, inputSignature, cacheHit: false } });
        setNotice("任务已创建，正在后台生成…");
        const settledTask = await pollTaskUntilSettled(nodeId, response.task.id);
        return settledTask?.status === "succeeded";
      } catch (error) {
        patchNode(nodeId, {
          runtime: { status: "failed", progress: 0, error: error instanceof Error ? error.message : String(error) },
        });
        return false;
      }
    },
    [canvas, project, workflowEdges, workflowNodes, patchNode, models, pollTaskUntilSettled],
  );

  const recoveryPolledRef = useRef(new Set<string>());
  useEffect(() => {
    for (const node of workflowNodes) {
      const taskId = node.runtime.taskId;
      if (!taskId || !["pending", "running"].includes(node.runtime.status)) continue;
      if (recoveryPolledRef.current.has(taskId)) continue;
      recoveryPolledRef.current.add(taskId);
      pollTaskUntilSettled(node.id, taskId);
    }
  }, [pollTaskUntilSettled, workflowNodes]);

  const loadCanvasRecord = useCallback(async (canvasId: string, useLocalFallback = false) => {
    const loadedCanvas = (await getCanvas(canvasId)).canvas;
    setCanvas(loadedCanvas);
    localStorage.setItem("anime-canvas-canvas-id", loadedCanvas.id);
    const snapshot = loadedCanvas.snapshot?.nodes?.length
      ? migrateSnapshot(loadedCanvas.snapshot)
      : useLocalFallback
        ? readLocalSnapshot()
        : migrateSnapshot(loadedCanvas.snapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
    const yCanvas = yCanvasRef.current;
    if (yCanvas) applySnapshotToYDoc(yCanvas, snapshot, Y_CANVAS_LOAD_ORIGIN);
    applySnapshotFromYCanvas(snapshot, { resetSelection: true });
  }, [applySnapshotFromYCanvas]);

  useEffect(() => {
    Promise.all([listUsers(), listModels()])
      .then(async ([userResult, modelResult]) => {
        let loadedUsers = userResult.users;
        if (!loadedUsers.length) {
          const created = await createUser("默认用户");
          loadedUsers = [created.user];
        }
        const savedUserId = localStorage.getItem("anime-canvas-active-user-id");
        const activeUser = loadedUsers.find((user) => user.id === savedUserId) || loadedUsers[0];
        localStorage.setItem("anime-canvas-active-user-id", activeUser.id);
        localUserRef.current = { ...localUserRef.current, id: activeUser.id, name: activeUser.name };
        setUsers(loadedUsers);
        setCurrentUser(activeUser);
        setModels(modelResult.models);

        const { project: loadedProject, canvases: loadedCanvases } = await ensureProject(activeUser.id);
        const loadedProjects = (await listProjects()).projects;
        setProjects(loadedProjects);
        setProject(loadedProject);
        setCanvases(loadedCanvases);
        const savedCanvasId = localStorage.getItem("anime-canvas-canvas-id");
        const selectedCanvas = loadedCanvases.find((item) => item.id === savedCanvasId) || loadedCanvases[0];
        await loadCanvasRecord(selectedCanvas.id, true);
        setAssets((await listAssets(loadedProject.id)).assets);
        setNotice("画布已连接后端并加载完成");
      })
      .catch(() => {
        const snapshot = readLocalSnapshot();
        const yCanvas = yCanvasRef.current;
        if (yCanvas) applySnapshotToYDoc(yCanvas, snapshot, Y_CANVAS_LOAD_ORIGIN);
        applySnapshotFromYCanvas(snapshot, { resetSelection: true });
        setNotice("后端不可用，已进入浏览器本地模式");
      });
  }, [applySnapshotFromYCanvas, loadCanvasRecord]);

  useEffect(() => {
    if (!canvas || !currentUser) return;
    collaborationClientRef.current?.close();
    collaborationClientRef.current = createCollaborationClient({
      canvasId: canvas.id,
      user: localUserRef.current,
      onUsers: setCollaborationUsers,
      onStatus: setCollaborationStatus,
      getSnapshot: () => snapshotFromState(workflowNodesRef.current, workflowEdgesRef.current, groupsRef.current),
      getYjsStateVector: () => {
        const yCanvas = yCanvasRef.current;
        return yCanvas ? encodeYCanvasStateVector(yCanvas) : null;
      },
      getYjsDiffUpdate: (stateVector) => {
        const yCanvas = yCanvasRef.current;
        return yCanvas ? encodeYCanvasDiffUpdate(yCanvas, stateVector) : null;
      },
      onYjsUpdate: (update) => {
        const yCanvas = yCanvasRef.current;
        if (!yCanvas) return;
        applyingRemoteSnapshotRef.current = true;
        applyYCanvasUpdate(yCanvas, update, Y_CANVAS_REMOTE_ORIGIN);
        window.setTimeout(() => {
          applyingRemoteSnapshotRef.current = false;
        }, 0);
      },
      onSnapshot: (remoteSnapshot, version, sourceUserId) => {
        if (isDraggingNodeRef.current) return;
        const snapshot = migrateSnapshot(remoteSnapshot);
        const localSnapshot = snapshotFromState(workflowNodesRef.current, workflowEdgesRef.current, groupsRef.current);
        const localHasContent = hasSnapshotContent(localSnapshot);
        const remoteHasContent = hasSnapshotContent(snapshot);
        if (version < snapshotVersionRef.current && sourceUserId && (localHasContent || !remoteHasContent)) return;
        applyingRemoteSnapshotRef.current = true;
        snapshotVersionRef.current = Math.max(snapshotVersionRef.current, version);
        const editingNodeId = expandedNodeIdRef.current || selectedNodeIdRef.current;
        const localEditingNode = editingNodeId
          ? workflowNodesRef.current.find((node) => node.id === editingNodeId)
          : undefined;
        const remoteEditingNode = editingNodeId
          ? snapshot.nodes.find((node) => node.id === editingNodeId)
          : undefined;
        const shouldProtectLocalEdit = Boolean(
          editingNodeId
            && Date.now() < localEditUntilRef.current
            && localEditingNode
            && remoteEditingNode
            && nodeChanged(localEditingNode, remoteEditingNode),
        );
        const nextSnapshot = shouldProtectLocalEdit
          ? mergeRemoteSnapshotWithProtectedNode(snapshot, localSnapshot, editingNodeId!)
          : snapshot;
        if (shouldProtectLocalEdit && localEditingNode) {
          const remoteUser = collaborationUsersRef.current.find((user) => user.id === sourceUserId);
          setCollaborationConflict({
            nodeId: localEditingNode.id,
            nodeTitle: localEditingNode.title,
            remoteUserName: remoteUser?.name || "其他协作者",
            detectedAt: new Date().toISOString(),
          });
          setNotice(`已保护本地正在编辑的「${localEditingNode.title}」，远端更新稍后再合并`);
        }
        const yCanvas = yCanvasRef.current;
        if (yCanvas) applySnapshotToYDoc(yCanvas, nextSnapshot, Y_CANVAS_REMOTE_ORIGIN);
        applySnapshotFromYCanvas(nextSnapshot);
        window.setTimeout(() => {
          applyingRemoteSnapshotRef.current = false;
        }, 0);
      },
    });
    setNotice("画布已连接后端并启用协作状态");
    return () => {
      collaborationClientRef.current?.close();
      collaborationClientRef.current = null;
      setCollaborationUsers([]);
      setCollaborationStatus("offline");
    };
  }, [canvas, currentUser]);

  useEffect(() => {
    collaborationClientRef.current?.update({
      selectedNodeIds: selectionNodeIds,
      editingNodeId: expandedNodeId || selectedNodeId || null,
    });
  }, [expandedNodeId, selectedNodeId, selectionNodeIds]);

  const deleteNode = useCallback((nodeId: string) => {
    const yCanvas = yCanvasRef.current;
    if (yCanvas) removeYCanvasNode(yCanvas, nodeId, Y_CANVAS_LOCAL_ORIGIN);
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

  const deleteEdge = useCallback((edgeId: string) => {
    const yCanvas = yCanvasRef.current;
    if (yCanvas) removeYCanvasEdge(yCanvas, edgeId, Y_CANVAS_LOCAL_ORIGIN);
    setRfEdges((current) => current.filter((edge) => edge.id !== edgeId));
    if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
  }, [selectedEdgeId]);

  useEffect(() => {
    if (isDraggingNodeRef.current) return;
    setRfNodes(toReactFlowNodes(workflowNodes, workflowEdges, patchNodeFromUi, runNode, deleteNode, assets, models, uploadNodeAsset, handleAddAssetAsNode, saveNodeResultAsAsset, copyNodeResultUrl, previewNodeResult, expandedNodeId));
  }, [workflowNodes, workflowEdges, patchNodeFromUi, runNode, deleteNode, assets, models, uploadNodeAsset, handleAddAssetAsNode, saveNodeResultAsAsset, copyNodeResultUrl, previewNodeResult, expandedNodeId, setRfNodes]);

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

  const applyCanvasSnapshot = useCallback((snapshot: CanvasSnapshot) => {
    const migrated = migrateSnapshot(snapshot);
    const yCanvas = yCanvasRef.current;
    if (yCanvas) applySnapshotToYDoc(yCanvas, migrated, Y_CANVAS_LOAD_ORIGIN);
    applySnapshotFromYCanvas(migrated, { resetSelection: true });
  }, [applySnapshotFromYCanvas]);

  const commitDragHistory = useCallback((nextSnapshot: CanvasSnapshot) => {
    const baseline = dragHistoryBaselineRef.current;
    dragHistoryBaselineRef.current = null;
    if (!baseline || JSON.stringify(baseline) === JSON.stringify(nextSnapshot)) {
      currentSnapshotRef.current = nextSnapshot;
      return;
    }
    historyRef.current.past = [...historyRef.current.past.slice(-39), baseline];
    historyRef.current.future = [];
    currentSnapshotRef.current = nextSnapshot;
    historyRef.current.restoring = true;
  }, []);

  useEffect(() => {
    const snapshot = snapshotFromState(workflowNodes, workflowEdges, groups);
    if (historyRef.current.restoring) {
      historyRef.current.restoring = false;
      currentSnapshotRef.current = snapshot;
      return;
    }
    if (isDraggingNodeRef.current || groupDragRef.current) {
      currentSnapshotRef.current = snapshot;
      return;
    }
    const previous = currentSnapshotRef.current;
    if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot)) {
      historyRef.current.past = [...historyRef.current.past.slice(-39), previous];
      historyRef.current.future = [];
    }
    currentSnapshotRef.current = snapshot;
  }, [groups, workflowEdges, workflowNodes]);

  useEffect(() => {
    if (applyingYCanvasSnapshotRef.current || skipNextYDocSyncRef.current) {
      skipNextYDocSyncRef.current = false;
      return;
    }
    const yCanvas = yCanvasRef.current;
    if (!yCanvas) return;
    const snapshot = snapshotFromState(workflowNodes, workflowEdges, groups);
    syncingReactStateToYDocRef.current = true;
    try {
      applySnapshotToYDoc(yCanvas, snapshot, Y_CANVAS_LOCAL_ORIGIN);
    } finally {
      syncingReactStateToYDocRef.current = false;
    }
  }, [groups, workflowEdges, workflowNodes]);

  useEffect(() => {
    const snapshot = snapshotFromState(workflowNodes, workflowEdges, groups);
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
    if (applyingRemoteSnapshotRef.current) return;
    snapshotVersionRef.current = Date.now();
    const version = snapshotVersionRef.current;
    window.clearTimeout(collaborationBroadcastTimerRef.current);
    if (!isDraggingNodeRef.current) {
      collaborationBroadcastTimerRef.current = window.setTimeout(() => {
        collaborationClientRef.current?.sendSnapshot(snapshot, version);
      }, 180);
    }
    if (!canvas || !workflowNodes.length) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      saveSnapshot(canvas.id, snapshot)
        .then(() => setSaveStatus("saved"))
        .catch(() => {
          setSaveStatus("failed");
          setNotice("自动保存到后端失败，本地快照仍已保存");
        });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [canvas, groups, workflowEdges, workflowNodes]);

  const selectedNode = workflowNodes.find((node) => node.id === selectedNodeId) || null;

  const addWorkflowNode = (type: string, position = { x: 180 + workflowNodes.length * 32, y: 120 + workflowNodes.length * 24 }) => {
    const next = makeWorkflowNode(type, position);
    const yCanvas = yCanvasRef.current;
    if (yCanvas) upsertYCanvasNode(yCanvas, next, Y_CANVAS_LOCAL_ORIGIN);
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
    const targetNode = workflowNodes.find((node) => node.id === normalizedConnection.target);
    const sourceNode = workflowNodes.find((node) => node.id === normalizedConnection.source);
    if (
      targetNode?.type === "image.generate"
      && sourceNode?.type === "text.input"
      && !targetNode.data.promptTouched
      && !String(targetNode.data.prompt || "").trim()
    ) {
      patchNode(targetNode.id, { data: { ...targetNode.data, prompt: String(sourceNode.data.prompt || "") } });
    }

    const edgeId = createId("edge");
    const workflowEdge: WorkflowEdge = {
      id: edgeId,
      sourceNodeId: String(connection.source || ""),
      sourcePortId: normalizePortId(String(connection.sourceHandle || "")),
      targetNodeId: String(connection.target || ""),
      targetPortId: normalizePortId(String(connection.targetHandle || "")),
    };
    const yCanvas = yCanvasRef.current;
    if (yCanvas) upsertYCanvasEdge(yCanvas, workflowEdge, Y_CANVAS_LOCAL_ORIGIN);

    setRfEdges((current) =>
      addEdge(
        {
          ...connection,
          id: edgeId,
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
          animated: true,
        },
        current,
      ),
    );
    setNotice("连接成功");
  };

  const deleteSelected = useCallback(() => {
    if (selectedEdgeId) {
      deleteEdge(selectedEdgeId);
    } else if (selectionNodeIds.length > 0) {
      selectionNodeIds.forEach((nodeId) => deleteNode(nodeId));
      setSelectionNodeIds([]);
    } else if (selectedNodeId) {
      deleteNode(selectedNodeId);
    }
  }, [selectedEdgeId, selectionNodeIds, selectedNodeId, deleteEdge, deleteNode]);

  const duplicateSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    const source = workflowNodes.find((node) => node.id === selectedNodeId);
    if (!source) return;
    const timestamp = new Date().toISOString();
    const duplicated: WorkflowNode = {
      ...source,
      id: createId("node"),
      position: { x: source.position.x + 36, y: source.position.y + 36 },
      runtime: { status: "idle", progress: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const yCanvas = yCanvasRef.current;
    if (yCanvas) upsertYCanvasNode(yCanvas, duplicated, Y_CANVAS_LOCAL_ORIGIN);
    setWorkflowNodes((current) => [...current, duplicated]);
    setSelectedNodeId(duplicated.id);
    setExpandedNodeId(duplicated.id);
    setNotice("节点已复制");
  }, [selectedNodeId, workflowNodes]);

  const undoCanvas = useCallback(() => {
    const yCanvas = yCanvasRef.current;
    if (yCanvas && canUndoYCanvas(yCanvas)) {
      undoYCanvas(yCanvas);
      setNotice("已撤销");
      return;
    }
    const previous = historyRef.current.past.pop();
    const current = currentSnapshotRef.current;
    if (!previous || !current) return;
    historyRef.current.future.push(current);
    historyRef.current.restoring = true;
    applyCanvasSnapshot(previous);
    setNotice("已撤销");
  }, [applyCanvasSnapshot]);

  const redoCanvas = useCallback(() => {
    const yCanvas = yCanvasRef.current;
    if (yCanvas && canRedoYCanvas(yCanvas)) {
      redoYCanvas(yCanvas);
      setNotice("已重做");
      return;
    }
    const next = historyRef.current.future.pop();
    const current = currentSnapshotRef.current;
    if (!next || !current) return;
    historyRef.current.past.push(current);
    historyRef.current.restoring = true;
    applyCanvasSnapshot(next);
    setNotice("已重做");
  }, [applyCanvasSnapshot]);

  const fitAllNodes = useCallback(() => {
    if (workflowNodes.length === 0) {
      setViewport({ x: 0, y: 0, zoom: 2 / 3 }, { duration: 240 });
      return;
    }
    fitView({ padding: 0.22, duration: 260 });
  }, [fitView, setViewport, workflowNodes.length]);

  const centerCanvas = useCallback(() => {
    setViewport({ x: 0, y: 0, zoom: 2 / 3 }, { duration: 260 });
  }, [setViewport]);

  const saveNow = async () => {
    const snapshot = snapshotFromState(workflowNodes, workflowEdges, groups);
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
    if (!canvas) {
      setNotice("已保存到浏览器本地");
      setSaveStatus("saved");
      return;
    }
    setSaveStatus("saving");
    await saveSnapshot(canvas.id, snapshot);
    setSaveStatus("saved");
    setNotice("已保存到后端快照");
  };

  const refreshProjectList = async () => {
    const loadedProjects = (await listProjects()).projects;
    setProjects(loadedProjects);
    if (project) {
      const refreshedProject = loadedProjects.find((item) => item.id === project.id);
      if (refreshedProject) setProject(refreshedProject);
    }
    return loadedProjects;
  };

  const loadProjectRecord = async (projectId: string, preferredCanvasId?: string, projectSummaries = projects) => {
    const loaded = await getProject(projectId);
    localStorage.setItem("anime-canvas-project-id", loaded.project.id);
    const projectSummary = projectSummaries.find((item) => item.id === loaded.project.id);
    setProject(projectSummary ? { ...loaded.project, ...projectSummary } : loaded.project);
    setCanvases(loaded.canvases);
    const selectedCanvas = loaded.canvases.find((item) => item.id === preferredCanvasId) || loaded.canvases[0];
    if (selectedCanvas) await loadCanvasRecord(selectedCanvas.id);
    setAssets((await listAssets(loaded.project.id)).assets);
    setYjsHistory([]);
    setSelectedYjsHistoryDetail(null);
    setHistoryError(null);
    setHistoryRestoreSummary(null);
    setHistoryPanelOpen(false);
  };

  const switchProject = async (projectId: string) => {
    if (!project || project.id === projectId) return;
    setProjectBusy(true);
    try {
      await saveNow();
      await loadProjectRecord(projectId);
      setNotice("已切换项目");
    } finally {
      setProjectBusy(false);
    }
  };

  const addProject = async () => {
    const name = window.prompt("请输入新项目名称", `项目 ${projects.length + 1}`);
    if (!name) return;
    setProjectBusy(true);
    try {
      const created = await createProject(name, currentUser?.id || "default-user");
      await refreshProjectList();
      await loadProjectRecord(created.project.id, created.canvas.id);
      setProjectDrawerOpen(true);
      setNotice("新项目已创建");
    } finally {
      setProjectBusy(false);
    }
  };

  const renameProject = async () => {
    if (!project) return;
    const name = window.prompt("请输入项目名称", project.name);
    if (!name || name === project.name) return;
    setProjectBusy(true);
    try {
      const updated = (await updateProject(project.id, { name })).project;
      setProject((current) => current ? { ...current, ...updated } : updated);
      await refreshProjectList();
      setNotice("项目已重命名");
    } finally {
      setProjectBusy(false);
    }
  };

  const duplicateProject = async () => {
    if (!project) return;
    await duplicateProjectById(project);
  };

  const duplicateProjectById = async (targetProject: ProjectRecord) => {
    const name = window.prompt("请输入项目副本名称", `${targetProject.name} 副本`);
    if (!name) return;
    setProjectBusy(true);
    try {
      if (project?.id === targetProject.id) await saveNow();
      const copied = await copyProject(targetProject.id, name, currentUser?.id);
      const loadedProjects = await refreshProjectList();
      await loadProjectRecord(copied.project.id, copied.canvases[0]?.id, loadedProjects);
      setProjectDrawerOpen(true);
      setNotice("项目已复制");
    } finally {
      setProjectBusy(false);
    }
  };

  const removeProject = async (targetProject = project) => {
    if (!targetProject) return;
    if (!window.confirm(`确定删除项目「${targetProject.name}」吗？项目内画布、素材和历史记录都会删除。`)) return;
    setProjectBusy(true);
    try {
      const result = await deleteProject(targetProject.id);
      await refreshProjectList();
      if (targetProject.id === project?.id) {
        await loadProjectRecord(result.nextProject.id, result.nextCanvases[0]?.id);
      }
      setNotice("项目已删除");
    } finally {
      setProjectBusy(false);
    }
  };

  const exportProjectById = async (targetProject: ProjectRecord) => {
    if (project?.id === targetProject.id) await saveNow();
    const { bundle } = await exportProject(targetProject.id);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${targetProject.name || "project"}.anime-canvas.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setNotice("项目 JSON 已导出");
  };

  const exportCurrentProject = async () => {
    if (!project) return;
    await exportProjectById(project);
  };

  const importProjectFromFile = async (file: File) => {
    setProjectBusy(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setNotice("导入失败：文件不是有效 JSON");
        return;
      }
      if (!validateProjectBundleForImport(parsed)) {
        setNotice("导入失败：项目文件版本或结构不兼容");
        return;
      }
      const bundle = parsed;
      const imported = await importProject(bundle, `${bundle.project?.name || "导入项目"} 导入`, currentUser?.id);
      const loadedProjects = await refreshProjectList();
      await loadProjectRecord(imported.project.id, imported.canvases[0]?.id, loadedProjects);
      setProjectDrawerOpen(true);
      setNotice("项目 JSON 已导入");
    } catch (error) {
      setNotice(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setProjectBusy(false);
    }
  };

  const refreshYjsHistory = async () => {
    if (!canvas) return;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      setYjsHistory((await listYjsHistory(canvas.id)).snapshots);
      setHistoryPanelOpen(true);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
      setHistoryPanelOpen(true);
    } finally {
      setHistoryBusy(false);
    }
  };

  const previewYjsHistorySnapshot = async (snapshotId: string) => {
    if (!canvas) return;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const detail = await getYjsHistorySnapshot(canvas.id, snapshotId);
      setSelectedYjsHistoryDetail(detail);
      setHistoryRestoreSummary({
        before: summarizeSnapshot(snapshotFromState(workflowNodesRef.current, workflowEdgesRef.current, groupsRef.current)),
        after: summarizeSnapshot(detail.snapshot),
      });
    } catch (error) {
      setSelectedYjsHistoryDetail(null);
      setHistoryRestoreSummary(null);
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryBusy(false);
    }
  };

  const compactCurrentYjsDocument = async () => {
    if (!canvas) return;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      await compactYjsDocument(canvas.id);
      setYjsHistory((await listYjsHistory(canvas.id)).snapshots);
      setNotice("Yjs 历史已压缩为快照");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryBusy(false);
    }
  };

  const restoreYjsHistorySnapshot = async () => {
    if (!canvas || !selectedYjsHistoryDetail) return;
    const restoredSnapshot = migrateSnapshot(selectedYjsHistoryDetail.snapshot);
    const before = summarizeSnapshot(snapshotFromState(workflowNodesRef.current, workflowEdgesRef.current, groupsRef.current));
    const after = summarizeSnapshot(restoredSnapshot);
    const isEmptyTarget = !hasSnapshotContent(restoredSnapshot);
    const message = [
      "恢复到该历史版本会替换当前画布内容，恢复前会自动保存当前版本。",
      `当前：${before.nodes} 节点 / ${before.edges} 连线 / ${before.groups} 组合`,
      `目标：${after.nodes} 节点 / ${after.edges} 连线 / ${after.groups} 组合`,
      isEmptyTarget ? "目标快照为空画布，请确认不是误操作。" : "",
      "确定继续吗？",
    ].filter(Boolean).join("\n");
    if (!window.confirm(message)) return;
    if (isEmptyTarget && !window.confirm("再次确认：这会把当前画布恢复为空历史版本。")) return;
    const yCanvas = yCanvasRef.current;
    if (!yCanvas) return;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      await compactYjsDocument(canvas.id);
      applySnapshotToYDoc(yCanvas, restoredSnapshot, Y_CANVAS_HISTORY_ORIGIN);
      applySnapshotFromYCanvas(restoredSnapshot, { resetSelection: true });
      await saveSnapshot(canvas.id, restoredSnapshot);
      collaborationClientRef.current?.sendSnapshot(restoredSnapshot, Date.now());
      setYjsHistory((await listYjsHistory(canvas.id)).snapshots);
      setHistoryRestoreSummary({ before, after });
      setNotice("已恢复到选中的历史版本");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
      setNotice("历史版本恢复失败");
    } finally {
      setHistoryBusy(false);
    }
  };

  const switchCanvas = async (canvasId: string) => {
    await saveNow();
    await loadCanvasRecord(canvasId);
    setNotice("已切换画布");
  };

  const addCanvas = async () => {
    if (!project) return;
    const name = window.prompt("请输入新画布名称", `画布 ${canvases.length + 1}`);
    if (!name) return;
    const created = (await createCanvas(project.id, name)).canvas;
    setCanvases((current) => [...current, created]);
    await loadCanvasRecord(created.id);
    setNotice("新画布已创建");
  };

  const renameCanvas = async () => {
    if (!canvas) return;
    const name = window.prompt("请输入画布名称", canvas.name);
    if (!name || name === canvas.name) return;
    const updated = (await updateCanvas(canvas.id, { name })).canvas;
    setCanvas(updated);
    setCanvases((current) => current.map((item) => item.id === updated.id ? updated : item));
    setNotice("画布已重命名");
  };

  const duplicateCanvas = async () => {
    if (!canvas) return;
    await saveNow();
    const name = window.prompt("请输入副本名称", `${canvas.name} 副本`);
    if (!name) return;
    const created = (await copyCanvas(canvas.id, name)).canvas;
    setCanvases((current) => [...current, created]);
    await loadCanvasRecord(created.id);
    setNotice("画布已复制");
  };

  const removeCanvas = async () => {
    if (!canvas) return;
    if (!window.confirm(`确定删除「${canvas.name}」吗？`)) return;
    const result = await deleteCanvas(canvas.id);
    setCanvases((current) => current.filter((item) => item.id !== canvas.id));
    await loadCanvasRecord(result.nextCanvas.id);
    setNotice("画布已删除");
  };

  const switchUser = async (userId: string) => {
    const user = users.find((item) => item.id === userId);
    if (!user) return;
    localStorage.setItem("anime-canvas-active-user-id", user.id);
    localUserRef.current = { ...localUserRef.current, id: user.id, name: user.name };
    setCurrentUser(user);
    collaborationClientRef.current?.close();
    setCollaborationUsers([]);
    setNotice(`已切换为 ${user.name}`);
  };

  const addUser = async () => {
    const name = window.prompt("请输入用户名称", `用户${users.length + 1}`);
    if (!name) return;
    const created = (await createUser(name)).user;
    setUsers((current) => [...current, created]);
    localStorage.setItem("anime-canvas-active-user-id", created.id);
    localUserRef.current = { ...localUserRef.current, id: created.id, name: created.name };
    setCurrentUser(created);
    collaborationClientRef.current?.close();
    setCollaborationUsers([]);
    setNotice(`已新增并切换为 ${created.name}`);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName || "") || target?.isContentEditable;
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveNow().catch(() => {
          setSaveStatus("failed");
          setNotice("保存失败");
        });
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoCanvas();
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoCanvas();
        return;
      }
      if (event.key === "Escape") {
        setContextMenu(null);
        setNodeLibraryOpen(false);
        setAssetLibraryOpen(false);
        setPreviewAsset(null);
        setPreviewResult(null);
        setSelectedNodeId(null);
        setExpandedNodeId(null);
        setSelectedEdgeId(null);
        return;
      }
      if (isTyping) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected();
      }
      if (event.ctrlKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelectedNode();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelected, duplicateSelectedNode, redoCanvas, saveNow, undoCanvas]);

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
    const bounds = selectionBounds || getGroupBounds(selectedNodes);
    if (exists) {
      const existingGroup = groups.find((group) => sameNodeSet(group.nodeIds, selectedNodeIds));
      if (existingGroup) {
        const yCanvas = yCanvasRef.current;
        if (yCanvas) patchYCanvasGroup(yCanvas, existingGroup.id, { bounds }, Y_CANVAS_LOCAL_ORIGIN);
      }
      setGroups((current) => current.map((group) => sameNodeSet(group.nodeIds, selectedNodeIds) ? { ...group, bounds } : group));
      setSelectionBounds(null);
      return;
    }
    const timestamp = new Date().toISOString();
    const group: WorkflowGroup = {
      id: createId("group"),
      title: `组合 ${groups.length + 1}`,
      nodeIds: selectedNodeIds,
      bounds,
      createdAt: timestamp,
    };
    const yCanvas = yCanvasRef.current;
    if (yCanvas) upsertYCanvasGroup(yCanvas, group, Y_CANVAS_LOCAL_ORIGIN);
    setGroups((current) => [
      ...current,
      { ...group, title: `组合 ${current.length + 1}` },
    ]);
    setSelectionBounds(null);
    setNotice("已根据框选自动创建组合框");
  }, [groups, workflowNodes, selectionBounds]);

  useEffect(() => {
    const onPointerUp = () => {
      const nodeIds = selectionNodeIdsRef.current;
      if (nodeIds.length >= 2) window.setTimeout(() => createGroupFromSelection(nodeIds), 0);
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, [createGroupFromSelection]);

  const ungroup = (groupId: string) => {
    const yCanvas = yCanvasRef.current;
    if (yCanvas) removeYCanvasGroup(yCanvas, groupId, Y_CANVAS_LOCAL_ORIGIN);
    setGroups((current) => current.filter((group) => group.id !== groupId));
    setNotice("组合已解除");
  };

  const renameGroup = (groupId: string) => {
    const group = groups.find((item) => item.id === groupId);
    if (!group) return;
    const title = window.prompt("请输入组合名称", group.title);
    if (!title || title === group.title) return;
    const yCanvas = yCanvasRef.current;
    if (yCanvas) patchYCanvasGroup(yCanvas, groupId, { title }, Y_CANVAS_LOCAL_ORIGIN);
    setGroups((current) => current.map((item) => item.id === groupId ? { ...item, title } : item));
  };

  const moveGroup = useCallback((groupId: string, delta: { x: number; y: number }, phase: "start" | "move" | "end") => {
    if (phase === "start") {
      dragHistoryBaselineRef.current = snapshotFromState(workflowNodes, workflowEdges, groups);
      setGroups((currentGroups) => {
        const activeGroup = currentGroups.find((item) => item.id === groupId);
        if (!activeGroup) return currentGroups;
        const nodeIdSet = new Set(activeGroup.nodeIds);
        setWorkflowNodes((currentNodes) => {
          groupDragRef.current = {
            groupId,
            startBounds: activeGroup.bounds,
            startNodePositions: Object.fromEntries(
              currentNodes
                .filter((node) => nodeIdSet.has(node.id))
                .map((node) => [node.id, node.position]),
            ),
          };
          return currentNodes;
        });
        const yCanvas = yCanvasRef.current;
        if (yCanvas) patchYCanvasGroup(yCanvas, groupId, { dragging: true }, Y_CANVAS_LOCAL_ORIGIN);
        return currentGroups.map((group) => group.id === groupId ? { ...group, dragging: true } : group);
      });
      return;
    }

    const dragState = groupDragRef.current;
    if (!dragState || dragState.groupId !== groupId) return;

    const movedNodes = workflowNodesRef.current
      .filter((node) => Boolean(dragState.startNodePositions[node.id]))
      .map((node) => {
        const startPosition = dragState.startNodePositions[node.id];
        return {
          ...node,
          position: { x: startPosition.x + delta.x, y: startPosition.y + delta.y },
          updatedAt: new Date().toISOString(),
        };
      });
    const nextGroupBounds = {
      ...dragState.startBounds,
      x: dragState.startBounds.x + delta.x,
      y: dragState.startBounds.y + delta.y,
    };
    const yCanvas = yCanvasRef.current;
    if (yCanvas) {
      upsertYCanvasNodes(yCanvas, movedNodes, Y_CANVAS_LOCAL_ORIGIN);
      patchYCanvasGroup(yCanvas, groupId, { dragging: phase !== "end", bounds: nextGroupBounds }, Y_CANVAS_LOCAL_ORIGIN);
    }

    setWorkflowNodes((currentNodes) =>
      currentNodes.map((node) => {
        const startPosition = dragState.startNodePositions[node.id];
        return startPosition
          ? { ...node, position: { x: startPosition.x + delta.x, y: startPosition.y + delta.y }, updatedAt: new Date().toISOString() }
          : node;
      }),
    );
    setGroups((currentGroups) =>
      currentGroups.map((item) => item.id === groupId
        ? {
            ...item,
            dragging: phase !== "end",
            bounds: nextGroupBounds,
          }
        : item),
    );
    if (phase === "end") {
      groupDragRef.current = null;
      window.setTimeout(() => {
        const nextSnapshot = currentSnapshotRef.current;
        if (nextSnapshot) commitDragHistory(nextSnapshot);
      }, 0);
    }
  }, [commitDragHistory, groups, workflowEdges, workflowNodes]);

  const runGroup = async (group: WorkflowGroup) => {
    const patchGroupRuntime = (runtime: NonNullable<WorkflowGroup["runtime"]>) => {
      const yCanvas = yCanvasRef.current;
      if (yCanvas) patchYCanvasGroup(yCanvas, group.id, { runtime }, Y_CANVAS_LOCAL_ORIGIN);
      setGroups((current) => current.map((item) => item.id === group.id ? { ...item, runtime } : item));
    };
    let ordered: WorkflowNode[] = [];
    try {
      ordered = topologicalExecutableOrder(group.nodeIds, workflowEdges, workflowNodes);
    } catch (error) {
      patchGroupRuntime({ status: "failed", total: 0, completed: 0, failed: 1, skipped: 0 });
      setNotice(error instanceof Error ? error.message : String(error));
      return;
    }
    if (ordered.length === 0) {
      setNotice("组合内没有可运行的生成节点");
      patchGroupRuntime({ status: "succeeded", total: 0, completed: 0, failed: 0, skipped: 0 });
      return;
    }
    patchGroupRuntime({ status: "running", total: ordered.length, completed: 0, failed: 0, skipped: 0 });
    setNotice(`开始运行组合：${ordered.length} 个生成节点`);
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    const failedNodeIds = new Set<string>();
    for (const node of ordered) {
      const hasFailedDependency = workflowEdges.some((edge) => edge.targetNodeId === node.id && failedNodeIds.has(edge.sourceNodeId));
      if (hasFailedDependency) {
        skipped++;
        failedNodeIds.add(node.id);
        patchNode(node.id, { runtime: { status: "failed", progress: 0, error: "上游节点失败，已跳过" } });
      } else {
        const succeeded = await runNode(node.id);
        if (!succeeded) {
          failed++;
          failedNodeIds.add(node.id);
        } else {
          completed++;
        }
      }
      patchGroupRuntime({ status: "running", total: ordered.length, completed, failed, skipped });
    }
    const status = failed > 0 || skipped > 0 ? "failed" : "succeeded";
    patchGroupRuntime({ status, total: ordered.length, completed, failed, skipped });
    setNotice(`组合运行完成：成功 ${completed}，失败 ${failed}，跳过 ${skipped}`);
  };

  const sortedProjects = useMemo(
    () => [...projects].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    [projects],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>无限画布 AI 动漫创作工具</strong>
          <span>{project?.name || "本地项目"}</span>
        </div>
        <nav>
          <div className="project-switcher">
            <select value={project?.id || ""} onChange={(event) => switchProject(event.target.value)} title="当前项目">
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button type="button" className="topbar-action-trigger" onClick={() => setProjectDrawerOpen(true)} disabled={projectBusy}>项目</button>
            <div className="topbar-action-menu">
              <button type="button" className="topbar-action-trigger" aria-haspopup="menu">操作</button>
              <div className="topbar-action-popover" role="menu">
                <button type="button" role="menuitem" onClick={() => setProjectDrawerOpen(true)}>项目列表</button>
                <button type="button" role="menuitem" onClick={addProject}>新项目</button>
                <button type="button" role="menuitem" onClick={renameProject} disabled={!project}>重命名</button>
                <button type="button" role="menuitem" onClick={duplicateProject} disabled={!project}>复制</button>
                <button type="button" role="menuitem" onClick={() => removeProject()} disabled={!project}>删除</button>
                <button type="button" role="menuitem" onClick={exportCurrentProject} disabled={!project}>导出</button>
                <button type="button" role="menuitem" onClick={() => importFileRef.current?.click()}>导入</button>
                <button type="button" role="menuitem" onClick={refreshYjsHistory} disabled={!canvas}>历史</button>
              </div>
            </div>
            <input
              ref={importFileRef}
              className="hidden-file-input"
              type="file"
              accept="application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) void importProjectFromFile(file);
              }}
            />
          </div>
          <div className="canvas-switcher">
            <select value={currentUser?.id || ""} onChange={(event) => switchUser(event.target.value)} title="当前用户">
              {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
            </select>
            <button type="button" onClick={addUser}>新用户</button>
          </div>
          <div className="canvas-switcher">
            <select value={canvas?.id || ""} onChange={(event) => switchCanvas(event.target.value)} title="当前画布">
              {canvases.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <div className="topbar-action-menu">
              <button type="button" className="topbar-action-trigger" aria-haspopup="menu">画布操作</button>
              <div className="topbar-action-popover" role="menu">
                <button type="button" role="menuitem" onClick={addCanvas}>新画布</button>
                <button type="button" role="menuitem" onClick={renameCanvas}>重命名</button>
                <button type="button" role="menuitem" onClick={duplicateCanvas}>复制</button>
                <button type="button" role="menuitem" onClick={removeCanvas} disabled={canvases.length <= 1}>删除</button>
              </div>
            </div>
          </div>
          <div className={`status-pill ${collaborationStatus}`} title="协作连接状态">
            {collaborationStatus === "connected" ? "已连接" : collaborationStatus === "reconnecting" ? "重连中" : collaborationStatus === "connecting" ? "连接中" : "离线"}
          </div>
          <div className={`status-pill save-${saveStatus}`} title="保存状态">
            {saveStatus === "saving" ? "保存中" : saveStatus === "saved" ? "已保存" : saveStatus === "failed" ? "保存失败" : "未保存"}
          </div>
          <div className="collaboration-users" title="在线协作者">
            <span className="collaboration-dot" />
            <strong>{collaborationUsers.length + 1}</strong>
            {collaborationUsers.slice(0, 4).map((user) => (
              <i
                key={user.id}
                style={{ background: user.color }}
                title={user.editingNodeId
                  ? `${user.name} 正在编辑 ${workflowNodes.find((node) => node.id === user.editingNodeId)?.title || "某个节点"}`
                  : `${user.name} 在线`}
              >
                {user.name.slice(0, 1)}
              </i>
            ))}
            {collaborationUsers.length > 0 && (
              <div className="collaboration-user-popover">
                {collaborationUsers.map((user) => {
                  const editingNode = user.editingNodeId
                    ? workflowNodes.find((node) => node.id === user.editingNodeId)
                    : undefined;
                  return (
                    <div key={user.id}>
                      <i style={{ background: user.color }}>{user.name.slice(0, 1)}</i>
                      <span>{user.name}</span>
                      <em>{editingNode ? `正在编辑 ${editingNode.title}` : "在线"}</em>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <button className={`asset-library-top-button ${assetLibraryOpen ? "active" : ""}`} onClick={() => setAssetLibraryOpen((open) => !open)}>素材库</button>
          <button className="weui-btn weui-btn_mini weui-btn_primary" onClick={saveNow}>保存</button>
        </nav>
      </header>
      {collaborationConflict && (
        <div className="collaboration-conflict-banner">
          <strong>协作冲突已拦截</strong>
          <span>
            {collaborationConflict.remoteUserName} 更新了你正在编辑的「{collaborationConflict.nodeTitle}」，本地内容已暂时保留。
          </span>
          <button type="button" onClick={() => setCollaborationConflict(null)}>知道了</button>
        </div>
      )}

      {projectDrawerOpen && (
        <aside className="project-drawer">
          <header>
            <div>
              <strong>项目列表</strong>
              <span>{projects.length} 个项目 · 当前 {project?.name || "未选择"}</span>
            </div>
            <button type="button" onClick={() => setProjectDrawerOpen(false)}>×</button>
          </header>
          <div className="project-drawer-actions">
            <button type="button" onClick={addProject} disabled={projectBusy}>新项目</button>
            <button type="button" onClick={() => importFileRef.current?.click()} disabled={projectBusy}>导入 JSON</button>
            <button type="button" onClick={() => refreshProjectList()} disabled={projectBusy}>刷新</button>
          </div>
          <div className="project-list">
            {sortedProjects.map((item) => (
              <article key={item.id} className={`project-row ${item.id === project?.id ? "active" : ""}`}>
                <button
                  type="button"
                  className="project-row-main"
                  onClick={() => switchProject(item.id)}
                  disabled={projectBusy || item.id === project?.id}
                >
                  <strong>{item.name}</strong>
                  <span>{formatOptionalTime(item.updatedAt)}</span>
                  <dl>
                    <div>
                      <dt>画布</dt>
                      <dd>{item.canvasCount ?? 0}</dd>
                    </div>
                    <div>
                      <dt>素材</dt>
                      <dd>{item.assetCount ?? 0}</dd>
                    </div>
                    <div>
                      <dt>历史</dt>
                      <dd>{item.historySnapshotCount ?? 0}</dd>
                    </div>
                  </dl>
                </button>
                <div className="project-row-actions">
                  <button type="button" onClick={() => exportProjectById(item)} disabled={projectBusy}>导出</button>
                  <button type="button" onClick={() => duplicateProjectById(item)} disabled={projectBusy}>复制</button>
                  <button type="button" onClick={() => removeProject(item)} disabled={projectBusy}>删除</button>
                </div>
              </article>
            ))}
          </div>
        </aside>
      )}

      {historyPanelOpen && (
        <div className="asset-preview" onClick={() => setHistoryPanelOpen(false)}>
          <div className="asset-preview-card history-preview-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>Yjs 历史快照</strong>
                <span>{canvas?.name || "当前画布"}</span>
              </div>
              <button type="button" onClick={() => setHistoryPanelOpen(false)}>×</button>
            </header>
            {historyError && <div className="history-error">{historyError}</div>}
            <div className="history-list">
              {yjsHistory.length === 0 ? (
                <div className="history-empty">暂无历史快照，可先手动压缩当前 Yjs 文档。</div>
              ) : yjsHistory.map((record) => (
                <article key={record.id} className={`history-row ${selectedYjsHistoryDetail?.record.id === record.id ? "active" : ""}`}>
                  <div>
                    <strong>{formatHistoryTime(record.createdAt)}</strong>
                    <span>clock {record.clock}</span>
                  </div>
                  <span>{record.updateCount} updates</span>
                  <span>{formatBytes(record.updateSize)}</span>
                  <button type="button" onClick={() => previewYjsHistorySnapshot(record.id)} disabled={historyBusy}>查看</button>
                </article>
              ))}
            </div>
            {historyRestoreSummary && (
              <section className="history-diff">
                <div>
                  <span>当前画布</span>
                  <strong>{historyRestoreSummary.before.nodes} 节点 · {historyRestoreSummary.before.edges} 连线 · {historyRestoreSummary.before.groups} 组合</strong>
                </div>
                <div>
                  <span>选中版本</span>
                  <strong>{historyRestoreSummary.after.nodes} 节点 · {historyRestoreSummary.after.edges} 连线 · {historyRestoreSummary.after.groups} 组合</strong>
                </div>
              </section>
            )}
            {selectedYjsHistoryDetail && (
              <section className="history-detail">
                <div>
                  <strong>{formatHistoryTime(selectedYjsHistoryDetail.record.createdAt)}</strong>
                  <span>clock {selectedYjsHistoryDetail.record.clock} · {formatBytes(selectedYjsHistoryDetail.record.updateSize)}</span>
                </div>
                <dl>
                  <div>
                    <dt>节点</dt>
                    <dd>{selectedYjsHistoryDetail.summary.nodes}</dd>
                  </div>
                  <div>
                    <dt>连线</dt>
                    <dd>{selectedYjsHistoryDetail.summary.edges}</dd>
                  </div>
                  <div>
                    <dt>组合</dt>
                    <dd>{selectedYjsHistoryDetail.summary.groups}</dd>
                  </div>
                </dl>
                {!hasSnapshotContent(selectedYjsHistoryDetail.snapshot) && (
                  <div className="history-warning">该历史版本是空画布，恢复前会再次确认。</div>
                )}
                <button type="button" onClick={restoreYjsHistorySnapshot} disabled={historyBusy || !canvas}>恢复到此版本</button>
              </section>
            )}
            <footer>
              <button type="button" onClick={refreshYjsHistory} disabled={historyBusy}>刷新</button>
              <button type="button" onClick={compactCurrentYjsDocument} disabled={!canvas || historyBusy}>压缩当前文档</button>
              <button type="button" onClick={() => setHistoryPanelOpen(false)}>关闭</button>
            </footer>
          </div>
        </div>
      )}

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
        <button className={assetLibraryOpen ? "active" : ""} title="素材库" onClick={() => setAssetLibraryOpen((open) => !open)}>库</button>
        <button title="历史" onClick={undoCanvas}>↶</button>
        <button title="重做" onClick={redoCanvas}>↷</button>
        <button title="适配全部" onClick={fitAllNodes}>⌖</button>
        <span />
        <button title="回到中心" onClick={centerCanvas}>◎</button>
        <button title="帮助">?</button>
        <span />
        <button title="固定">⌖</button>
      </div>
      {draggingTemplate && (
        <div className="node-drag-preview" style={{ left: draggingTemplate.x, top: draggingTemplate.y }}>
          {draggingTemplate.icon}
        </div>
      )}
      {assetLibraryOpen && (
        <aside className="asset-drawer">
          <header>
            <div>
              <strong>素材库</strong>
              <span>{assets.length} 个素材</span>
            </div>
            <button type="button" onClick={() => setAssetLibraryOpen(false)}>×</button>
          </header>
          <div className="asset-filters">
            {(["all", "image", "audio", "video"] as const).map((type) => (
              <button key={type} className={assetFilter === type ? "active" : ""} onClick={() => setAssetFilter(type)}>
                {type === "all" ? "全部" : type === "image" ? "图片" : type === "audio" ? "音频" : "视频"}
              </button>
            ))}
          </div>
          <div className="asset-grid">
            {filteredAssets.length === 0 && <div className="asset-empty">暂无素材，生成或上传后会出现在这里</div>}
            {filteredAssets.map((asset) => (
              <article
                key={asset.id}
                className="asset-card"
                draggable
                onDragStart={(event) => event.dataTransfer.setData("application/x-anime-canvas-asset", asset.id)}
              >
                <button className="asset-thumb" type="button" onClick={() => setPreviewAsset(asset)}>
                  {asset.type === "image" ? <img src={asset.thumbnailUrl || asset.url} alt={asset.name || asset.id} /> : <span>{asset.type === "audio" ? "音频" : "视频"}</span>}
                </button>
                <div className="asset-meta">
                  <strong title={asset.name || asset.url}>{asset.name || asset.url.slice(0, 36)}</strong>
                  <span>{asset.type} · {asset.source}</span>
                </div>
                <div className="asset-actions">
                  <button type="button" onClick={() => addAssetNode(asset)}>放入画布</button>
                  <button type="button" onClick={() => copyAssetUrl(asset)}>复制 URL</button>
                  <button type="button" onClick={() => renameAsset(asset)}>重命名</button>
                  <button type="button" onClick={() => removeAsset(asset)}>删除</button>
                </div>
              </article>
            ))}
          </div>
        </aside>
      )}
      {previewAsset && (
        <div className="asset-preview" onClick={() => setPreviewAsset(null)}>
          <div className="asset-preview-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{previewAsset.name || "素材预览"}</strong>
              <button type="button" onClick={() => setPreviewAsset(null)}>×</button>
            </header>
            {previewAsset.type === "image" && <img src={previewAsset.url} alt={previewAsset.name || previewAsset.id} />}
            {previewAsset.type === "audio" && <audio src={previewAsset.url} controls />}
            {previewAsset.type === "video" && <video src={previewAsset.url} controls />}
            <footer>
              <button type="button" onClick={() => addAssetNode(previewAsset)}>放入画布</button>
              <button type="button" onClick={() => copyAssetUrl(previewAsset)}>复制 URL</button>
              <button type="button" onClick={() => renameAsset(previewAsset)}>重命名</button>
              <button type="button" onClick={() => removeAsset(previewAsset)}>删除</button>
            </footer>
          </div>
        </div>
      )}
      {previewResult && (
        <div className="asset-preview" onClick={() => setPreviewResult(null)}>
          <div className="asset-preview-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{previewResult.title}</strong>
              <button type="button" onClick={() => setPreviewResult(null)}>×</button>
            </header>
            {previewResult.type === "image" && <img src={previewResult.url} alt={previewResult.title} />}
            {previewResult.type === "audio" && <audio src={previewResult.url} controls />}
            {previewResult.type === "video" && <video src={previewResult.url} controls />}
            <footer>
              <button type="button" onClick={() => navigator.clipboard.writeText(previewResult.url).then(() => setNotice("节点结果 URL 已复制"))}>复制 URL</button>
              <button type="button" onClick={() => setPreviewResult(null)}>关闭</button>
            </footer>
          </div>
        </div>
      )}
      {contextMenu && (
        <div className="canvas-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={() => setContextMenu(null)}>
          <button type="button" onClick={() => addWorkflowNode("text.input", { x: contextMenu.flowX, y: contextMenu.flowY })}>添加文本节点</button>
          <button type="button" onClick={() => addWorkflowNode("image.generate", { x: contextMenu.flowX, y: contextMenu.flowY })}>添加图片生成</button>
          <button type="button" onClick={duplicateSelectedNode} disabled={!selectedNodeId}>复制选中节点</button>
          <button type="button" onClick={deleteSelected} disabled={!selectedNodeId && !selectedEdgeId && selectionNodeIds.length === 0}>删除选中</button>
          <button type="button" onClick={fitAllNodes}>适配全部节点</button>
          <button type="button" onClick={centerCanvas}>回到中心</button>
        </div>
      )}

      <main
        ref={containerRef}
        className={`canvas-panel ${draggingTemplate ? "placing-node" : ""}`}
        onPointerMove={(event) => {
          const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          collaborationClientRef.current?.update({ cursor: position });
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          const assetId = event.dataTransfer.getData("application/x-anime-canvas-asset");
          if (!assetId) return;
          event.preventDefault();
          const asset = assets.find((item) => item.id === assetId);
          if (!asset) return;
          addAssetNode(asset, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (draggingTemplate) {
            setDraggingTemplate(null);
            setNotice("已取消放置节点");
            return;
          }
          const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          setContextMenu({ x: event.clientX, y: event.clientY, flowX: flow.x, flowY: flow.y, nodeId: selectedNodeId || undefined });
        }}
      >
        <ReactFlow<WorkflowReactNode, WorkflowReactEdge>
          nodes={rfNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={() => {
            dragHistoryBaselineRef.current = snapshotFromState(workflowNodes, workflowEdges, groups);
            isDraggingNodeRef.current = true;
          }}
          onNodeDrag={(_, node, draggedNodes) => {
            const draggedPositions = new Map(
              [node, ...(draggedNodes || [])].map((draggedNode) => [draggedNode.id, draggedNode.position]),
            );
            const movedNodes = workflowNodesRef.current.map((item) =>
              draggedPositions.has(item.id) ? { ...item, position: draggedPositions.get(item.id)! } : item,
            ).filter((item) => draggedPositions.has(item.id));
            const yCanvas = yCanvasRef.current;
            if (yCanvas) upsertYCanvasNodes(yCanvas, movedNodes, Y_CANVAS_LOCAL_ORIGIN);
            setWorkflowNodes((current) =>
              current.map((item) =>
                draggedPositions.has(item.id) ? { ...item, position: draggedPositions.get(item.id)! } : item,
              ),
            );
          }}
          onNodeDragStop={(_, node, draggedNodes) => {
            isDraggingNodeRef.current = false;
            const draggedPositions = new Map(
              [node, ...(draggedNodes || [])].map((draggedNode) => [draggedNode.id, draggedNode.position]),
            );
            setWorkflowNodes((current) => {
              const next = current.map((item) =>
                draggedPositions.has(item.id) ? { ...item, position: draggedPositions.get(item.id)! } : item,
              );
              setGroups((currentGroups) => {
                const nextGroups = recomputeGroups(currentGroups, next);
                const movedNodes = next.filter((item) => draggedPositions.has(item.id));
                const yCanvas = yCanvasRef.current;
                if (yCanvas) {
                  upsertYCanvasNodes(yCanvas, movedNodes, Y_CANVAS_LOCAL_ORIGIN);
                  upsertYCanvasGroups(yCanvas, nextGroups, Y_CANVAS_LOCAL_ORIGIN);
                }
                commitDragHistory(snapshotFromState(next, workflowEdges, nextGroups));
                return nextGroups;
              });
              const selectedNodes = next.filter((item) => selectionNodeIds.includes(item.id));
              setSelectionBounds(selectedNodes.length >= 2 ? getGroupBounds(selectedNodes) : null);
              return next;
            });
          }}
          onNodeClick={(event, node) => {
            if (event.defaultPrevented) return;
            setSelectedNodeId(node.id);
            setExpandedNodeId(node.id);
            setSelectedEdgeId(null);
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedNodeId(null);
            setExpandedNodeId(null);
          }}
          onPaneClick={() => {
            setContextMenu(null);
            setSelectedNodeId(null);
            setExpandedNodeId(null);
            setSelectedEdgeId(null);
          }}
          onSelectionChange={(params: OnSelectionChangeParams<WorkflowReactNode, WorkflowReactEdge>) => {
            const nodeIds = params.nodes.map((node) => node.id);
            selectionNodeIdsRef.current = nodeIds;
            setSelectionNodeIds(nodeIds);
            if (nodeIds.length > 0) setSelectedEdgeId(null);
            setSelectionBounds(params.nodes.length >= 2 ? getReactFlowNodeBounds(params.nodes) : null);
          }}
          selectionKeyCode="Control"
          multiSelectionKeyCode="Control"
          selectionMode={SelectionMode.Full}
          panOnDrag
          deleteKeyCode={null}
          disableKeyboardA11y
          minZoom={0.03}
          maxZoom={8}
          zoomOnPinch
          zoomOnDoubleClick={false}
          defaultViewport={{ x: 0, y: 0, zoom: 2 / 3 }}
        >
          <ViewportPortal>
            <CollaborationOverlay users={collaborationUsers} nodes={workflowNodes} />
            <GroupOverlay groups={groups} nodes={workflowNodes} zoom={zoom} onUngroup={ungroup} onRename={renameGroup} onRun={runGroup} onMove={moveGroup} />
          </ViewportPortal>
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="rgba(255, 255, 255, 0.2)" />
          <MiniMap />
          <Controls />
        </ReactFlow>
      </main>

      <footer className="statusbar">
        <span>{notice}</span>
        <span className="statusbar-right">
          <span className="zoom-indicator">{Math.round(zoom / (2 / 3) * 100)}%</span>
          <span>节点 {workflowNodes.length} · 连线 {workflowEdges.length} · 素材 {assets.length}</span>
        </span>
      </footer>
    </div>
  );
}

function CollaborationOverlay({ users, nodes }: { users: CollaborationUser[]; nodes: WorkflowNode[] }) {
  return (
    <div className="collaboration-layer">
      {users.map((user) => (
        <div key={user.id}>
          {user.cursor && (
            <div className="collaboration-cursor" style={{ left: user.cursor.x, top: user.cursor.y, color: user.color }}>
              <span />
              <em>{user.name}</em>
            </div>
          )}
          {user.editingNodeId && nodes.some((node) => node.id === user.editingNodeId) && (() => {
            const node = nodes.find((item) => item.id === user.editingNodeId)!;
            return (
              <div className="collaboration-node-badge" style={{ left: node.position.x + 12, top: node.position.y - 26, background: user.color }}>
                {user.name} 正在编辑
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}

function GroupOverlay({
  groups,
  nodes,
  zoom,
  onUngroup,
  onRename,
  onRun,
  onMove,
}: {
  groups: WorkflowGroup[];
  nodes: WorkflowNode[];
  zoom: number;
  onUngroup: (groupId: string) => void;
  onRename: (groupId: string) => void;
  onRun: (group: WorkflowGroup) => void;
  onMove: (groupId: string, delta: { x: number; y: number }, phase: "start" | "move" | "end") => void;
}) {
  return (
    <div className="group-layer">
      {groups.map((group) => {
        const bounds = group.bounds || getGroupBounds(nodes.filter((node) => group.nodeIds.includes(node.id)));
        return (
        <div
          key={group.id}
          className={`workflow-group ${group.dragging ? "dragging" : ""} ${group.runtime?.status || "idle"}`}
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
            let latestDelta = { x: 0, y: 0 };
            onMove(group.id, latestDelta, "start");
            const onPointerMove = (moveEvent: PointerEvent) => {
              latestDelta = { x: (moveEvent.clientX - start.x) / zoom, y: (moveEvent.clientY - start.y) / zoom };
              onMove(group.id, latestDelta, "move");
            };
            const onPointerUp = () => {
              window.removeEventListener("pointermove", onPointerMove);
              onMove(group.id, latestDelta, "end");
            };
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp, { once: true });
          }}
        >
          <div className="group-toolbar">
            <span>{group.title}</span>
            {group.runtime?.status === "running" && <em>{group.runtime.completed || 0} / {group.runtime.total || 0}</em>}
            {group.runtime?.status === "failed" && <em>失败 {group.runtime.failed || 0} · 跳过 {group.runtime.skipped || 0}</em>}
            {group.runtime?.status === "succeeded" && <em>已完成</em>}
            <button title="运行组合工作流" onClick={() => onRun(group)}>▶</button>
            <button title="重命名组合" onClick={() => onRename(group.id)}>T</button>
            <button title="解除组合节点" onClick={() => onUngroup(group.id)}>✕</button>
          </div>
        </div>
      );
      })}
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

function hasSnapshotContent(snapshot: CanvasSnapshot | null | undefined) {
  return Boolean(
    snapshot
      && (
        (snapshot.nodes?.length || 0) > 0
        || (snapshot.edges?.length || 0) > 0
        || (snapshot.groups?.length || 0) > 0
      ),
  );
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

function getReactFlowNodeBounds(nodes: WorkflowReactNode[]) {
  const padding = 42;
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + (node.measured?.width || Number(node.style?.width) || 286)));
  const maxY = Math.max(...nodes.map((node) => node.position.y + (node.measured?.height || Number(node.style?.minHeight) || 248)));
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
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

function stableJson(value: unknown) {
  return JSON.stringify(value ?? null);
}

function nodeChanged(left?: WorkflowNode, right?: WorkflowNode) {
  return stableJson(left) !== stableJson(right);
}

function mergeRemoteSnapshotWithProtectedNode(
  remoteSnapshot: CanvasSnapshot,
  localSnapshot: CanvasSnapshot,
  protectedNodeId: string,
) {
  const localNode = localSnapshot.nodes.find((node) => node.id === protectedNodeId);
  if (!localNode) return remoteSnapshot;
  const remoteNodes = remoteSnapshot.nodes || [];
  if (!remoteNodes.some((node) => node.id === protectedNodeId)) return remoteSnapshot;
  return {
    ...remoteSnapshot,
    nodes: remoteNodes.map((node) => node.id === protectedNodeId ? localNode : node),
    edges: remoteSnapshot.edges || localSnapshot.edges || [],
    groups: remoteSnapshot.groups || localSnapshot.groups || [],
  };
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
