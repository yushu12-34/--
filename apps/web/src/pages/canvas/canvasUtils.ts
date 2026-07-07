import type { Edge } from "@xyflow/react";
import { getNodeDefinition } from "../../nodeDefinitions";
import type { AssetRecord, CanvasSnapshot, ProjectBundle, WorkflowEdge, WorkflowGroup, WorkflowNode } from "../../types";
import { normalizePortId } from "../../workflowValidation";
import { pickPublicParams } from "./modelParams";
import type { ConnectedInputs, RelatedNodeSummary, WorkflowNodeData, WorkflowReactEdge, WorkflowReactNode } from "./workflowTypes";

export const LOCAL_SNAPSHOT_KEY = "anime-canvas-local-snapshot";

export function formatHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function formatOptionalTime(value?: string) {
  if (!value) return "暂无记录";
  return formatHistoryTime(value);
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function summarizeSnapshot(snapshot: CanvasSnapshot | null | undefined) {
  return {
    nodes: snapshot?.nodes?.length || 0,
    edges: snapshot?.edges?.length || 0,
    groups: snapshot?.groups?.length || 0,
  };
}

export function validateProjectBundleForImport(value: unknown): value is ProjectBundle {
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

export function createId(prefix: string) {
  const randomId = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${randomId}`;
}

export function makeWorkflowNode(type: string, position = { x: 120, y: 120 }): WorkflowNode {
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

interface WorkflowGraphIndex {
  nodeById: Map<string, WorkflowNode>;
  incomingEdgesByTarget: Map<string, WorkflowEdge[]>;
  outgoingEdgesBySource: Map<string, WorkflowEdge[]>;
}

export function createWorkflowGraphIndex(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowGraphIndex {
  const nodeById = new Map<string, WorkflowNode>();
  const incomingEdgesByTarget = new Map<string, WorkflowEdge[]>();
  const outgoingEdgesBySource = new Map<string, WorkflowEdge[]>();

  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  for (const edge of edges) {
    const incoming = incomingEdgesByTarget.get(edge.targetNodeId) || [];
    incoming.push(edge);
    incomingEdgesByTarget.set(edge.targetNodeId, incoming);
    const outgoing = outgoingEdgesBySource.get(edge.sourceNodeId) || [];
    outgoing.push(edge);
    outgoingEdgesBySource.set(edge.sourceNodeId, outgoing);
  }

  return { nodeById, incomingEdgesByTarget, outgoingEdgesBySource };
}

function getConnectedInputsFromIndex(graphIndex: WorkflowGraphIndex, nodeId: string): ConnectedInputs {
  const incoming = graphIndex.incomingEdgesByTarget.get(nodeId) || [];
  const texts: string[] = [];
  const images: string[] = [];
  const audios: string[] = [];
  const videos: string[] = [];
  for (const edge of incoming) {
    const sourceNode = graphIndex.nodeById.get(edge.sourceNodeId);
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

export function getConnectedInputs(nodes: WorkflowNode[], edges: WorkflowEdge[], nodeId: string): ConnectedInputs {
  return getConnectedInputsFromIndex(createWorkflowGraphIndex(nodes, edges), nodeId);
}

function summarizeConnectedNode(node: WorkflowNode): RelatedNodeSummary {
  const definition = getNodeDefinition(node.type);
  const mediaType = definition?.outputs[0]?.mediaType;
  const url = String(node.data.url || node.data.resultUrl || "");
  const prompt = String(node.data.prompt || "");
  return {
    id: node.id,
    title: node.title,
    type: node.type,
    mediaType,
    hasValue: Boolean(url || prompt),
  };
}

function getUpstreamNodeSummariesFromIndex(graphIndex: WorkflowGraphIndex, nodeId: string): RelatedNodeSummary[] {
  return (graphIndex.incomingEdgesByTarget.get(nodeId) || [])
    .map((edge) => graphIndex.nodeById.get(edge.sourceNodeId))
    .filter((node): node is WorkflowNode => Boolean(node))
    .map(summarizeConnectedNode);
}

function getDownstreamNodeSummariesFromIndex(graphIndex: WorkflowGraphIndex, nodeId: string): RelatedNodeSummary[] {
  return (graphIndex.outgoingEdgesBySource.get(nodeId) || [])
    .map((edge) => graphIndex.nodeById.get(edge.targetNodeId))
    .filter((node): node is WorkflowNode => Boolean(node))
    .map(summarizeConnectedNode);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getNodeInputSignatureFromIndex(
  node: WorkflowNode,
  graphIndex: WorkflowGraphIndex,
  model?: Record<string, unknown>,
  connectedInputs = getConnectedInputsFromIndex(graphIndex, node.id),
) {
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

export function getNodeInputSignature(node: WorkflowNode, nodes: WorkflowNode[], edges: WorkflowEdge[], model?: Record<string, unknown>) {
  return getNodeInputSignatureFromIndex(node, createWorkflowGraphIndex(nodes, edges), model);
}

function validateNodeReadyFromIndex(graphIndex: WorkflowGraphIndex, nodeId: string) {
  const node = graphIndex.nodeById.get(nodeId);
  const definition = node ? getNodeDefinition(node.type) : undefined;
  if (!node || !definition) return { ready: false, message: "节点不存在" };

  for (const input of definition.inputs) {
    if (!input.required) continue;
    const connected = Boolean(graphIndex.incomingEdgesByTarget.get(nodeId)?.length);
    if (!connected) return { ready: false, message: "缺少必需输入连接" };
  }

  return { ready: true };
}

export function toReactFlowNodes(
  workflowNodes: WorkflowNode[],
  workflowEdges: WorkflowEdge[],
  onPatch: WorkflowNodeData["onPatch"],
  onRun: WorkflowNodeData["onRun"],
  onDelete: WorkflowNodeData["onDelete"],
  onDuplicate: WorkflowNodeData["onDuplicate"],
  onCollapse: WorkflowNodeData["onCollapse"],
  onInspectInputs: WorkflowNodeData["onInspectInputs"],
  onInspectOutputs: WorkflowNodeData["onInspectOutputs"],
  assets: AssetRecord[],
  models: Array<Record<string, unknown>>,
  onUploadAsset: WorkflowNodeData["onUploadAsset"],
  onAddAssetAsNode: WorkflowNodeData["onAddAssetAsNode"],
  onSaveResultAsset: WorkflowNodeData["onSaveResultAsset"],
  onCopyResultUrl: WorkflowNodeData["onCopyResultUrl"],
  onPreviewResult: WorkflowNodeData["onPreviewResult"],
  expandedNodeId: string | null,
  traceNodeId: string | null = null,
  traceMode: "inputs" | "outputs" | null = null,
): WorkflowReactNode[] {
  const graphIndex = createWorkflowGraphIndex(workflowNodes, workflowEdges);
  const modelById = new Map(models.map((model) => [String(model.id), model]));
  const tracedUpstreamIds = new Set(
    traceNodeId && traceMode === "inputs"
      ? (graphIndex.incomingEdgesByTarget.get(traceNodeId) || []).map((edge) => edge.sourceNodeId)
      : [],
  );
  const tracedDownstreamIds = new Set(
    traceNodeId && traceMode === "outputs"
      ? (graphIndex.outgoingEdgesBySource.get(traceNodeId) || []).map((edge) => edge.targetNodeId)
      : [],
  );

  return workflowNodes.map((workflow) => {
    const ready = validateNodeReadyFromIndex(graphIndex, workflow.id);
    const currentModel = modelById.get(String(workflow.data.modelId || "z-image-turbo"));
    const connectedInputs = getConnectedInputsFromIndex(graphIndex, workflow.id);
    const inputSignature = workflow.type.endsWith(".generate")
      ? getNodeInputSignatureFromIndex(workflow, graphIndex, currentModel, connectedInputs)
      : undefined;
    const resultStale = Boolean(inputSignature && workflow.data.resultUrl && workflow.runtime.inputSignature && workflow.runtime.inputSignature !== inputSignature);
    const highlightRole =
      workflow.id === traceNodeId
        ? "trace-target"
        : tracedUpstreamIds.has(workflow.id)
          ? "trace-upstream"
          : tracedDownstreamIds.has(workflow.id)
            ? "trace-downstream"
            : undefined;
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
        onDuplicate,
        onCollapse,
        onInspectInputs,
        onInspectOutputs,
        canRun: workflow.type.endsWith(".generate") && ready.ready,
        readyMessage: ready.message,
        inputSignature,
        resultStale,
        connectedInputs,
        upstreamNodes: getUpstreamNodeSummariesFromIndex(graphIndex, workflow.id),
        downstreamNodes: getDownstreamNodeSummariesFromIndex(graphIndex, workflow.id),
        highlightRole,
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

export function toReactFlowEdges(workflowEdges: WorkflowEdge[], selectedEdgeId?: string | null, onSelect?: (edgeId: string) => void): WorkflowReactEdge[] {
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

export function fromReactFlowEdges(edges: Edge[]): WorkflowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    sourceNodeId: edge.source,
    sourcePortId: normalizePortId(String(edge.sourceHandle || "")),
    targetNodeId: edge.target,
    targetPortId: normalizePortId(String(edge.targetHandle || "")),
  }));
}

export function snapshotFromState(nodes: WorkflowNode[], edges: WorkflowEdge[], groups: WorkflowGroup[]): CanvasSnapshot {
  return {
    nodes,
    edges,
    groups,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function hasSnapshotContent(snapshot: CanvasSnapshot | null | undefined) {
  return Boolean(
    snapshot
      && (
        (snapshot.nodes?.length || 0) > 0
        || (snapshot.edges?.length || 0) > 0
        || (snapshot.groups?.length || 0) > 0
      ),
  );
}

export function readLocalSnapshot(storageKey = LOCAL_SNAPSHOT_KEY): CanvasSnapshot {
  const fallback: CanvasSnapshot = {
    nodes: [
      makeWorkflowNode("text.input", { x: 120, y: 160 }),
      makeWorkflowNode("image.generate", { x: 520, y: 160 }),
    ],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const raw = localStorage.getItem(storageKey) || localStorage.getItem(LOCAL_SNAPSHOT_KEY);
  if (!raw) return fallback;
  try {
    const snapshot = JSON.parse(raw) as CanvasSnapshot;
    return migrateSnapshot(snapshot);
  } catch {
    return fallback;
  }
}

export function migrateSnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  const edges = (snapshot.edges || []).map((edge) => ({
    ...edge,
    sourcePortId: "out",
    targetPortId: "in",
  }));
  return { ...snapshot, edges };
}

export function getNodePreviewText(node: WorkflowNode) {
  if (node.type === "text.input") return String(node.data.prompt || "输入提示词生成文本").slice(0, 48);
  if (node.type === "image.input") return node.data.url ? "图片素材已就绪" : "上传图片作为参考";
  if (node.type === "audio.input") return node.data.name ? String(node.data.name) : "上传音频素材";
  if (node.type === "video.input") return node.data.name ? String(node.data.name) : "上传视频素材";
  if (node.type === "image.generate") return node.data.resultUrl ? "图片生成完成" : "连接文本后生成图片";
  if (node.type === "audio.generate") return "音频生成节点已预留接口";
  if (node.type === "video.generate") return "视频生成节点已预留接口";
  return "配置节点内容";
}

export function getNodeIcon(type: string) {
  if (type === "text.input") return "Aa";
  if (type === "image.input") return "▣";
  if (type === "audio.input") return "♪";
  if (type === "video.input") return "▶";
  if (type === "image.generate") return "✦";
  if (type === "audio.generate") return "♫";
  if (type === "video.generate") return "⯈";
  return "●";
}

export function getNodeAssetType(type: string): AssetRecord["type"] | undefined {
  if (type.includes("image")) return "image";
  if (type.includes("audio")) return "audio";
  if (type.includes("video")) return "video";
  return undefined;
}

export function sameNodeSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

export function getReactFlowNodeBounds(nodes: WorkflowReactNode[]) {
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

export function getGroupBounds(nodes: WorkflowNode[]) {
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

export function getNodeVisualSize(node: WorkflowNode) {
  const expanded = false;
  return {
    width: expanded ? 500 : 286,
    height: expanded ? 340 : 248,
  };
}

export function recomputeGroups(groups: WorkflowGroup[], nodes: WorkflowNode[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return groups.map((group) => {
    const groupNodes = group.nodeIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is WorkflowNode => Boolean(node));
    if (!groupNodes.length) return group;
    return {
      ...group,
      bounds: getGroupBounds(groupNodes),
    };
  });
}

export function stableJson(value: unknown) {
  return JSON.stringify(value ?? null);
}

export function nodeChanged(left?: WorkflowNode, right?: WorkflowNode) {
  return stableJson(left) !== stableJson(right);
}

export function mergeRemoteSnapshotWithProtectedNode(
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

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
