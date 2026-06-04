import { getNodeDefinition } from "./nodeDefinitions";
import type { MediaType, WorkflowEdge, WorkflowNode } from "./types";

interface PortLookup {
  node: WorkflowNode;
  portId: string;
  mediaType: MediaType;
  accepts?: MediaType[];
  direction: "input" | "output";
  multiple?: boolean;
}

export interface ConnectionCandidate {
  source: string | null;
  sourceHandle: string | null;
  target: string | null;
  targetHandle: string | null;
}

export function findPort(nodes: WorkflowNode[], nodeId?: string | null, portId?: string | null): PortLookup | undefined {
  if (!nodeId || !portId) return undefined;
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return undefined;
  const definition = getNodeDefinition(node.type);
  const portBaseId = normalizePortId(portId);
  const port = [...(definition?.inputs || []), ...(definition?.outputs || [])].find((item) => item.id === portBaseId);
  if (!port) return undefined;
  return {
    node,
    portId: portBaseId,
    mediaType: port.mediaType,
    accepts: port.accepts,
    direction: port.direction,
    multiple: port.multiple,
  };
}

export function validateConnection(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  candidate: ConnectionCandidate,
): { valid: boolean; message?: string } {
  const source = findPort(nodes, candidate.source, candidate.sourceHandle);
  const target = findPort(nodes, candidate.target, candidate.targetHandle);

  if (!source || !target) return { valid: false, message: "端口不存在" };
  if (source.node.id === target.node.id) return { valid: false, message: "节点不能连接自身" };
  if (source.direction !== "output" || target.direction !== "input") {
    return { valid: false, message: "只能从输出端口连接到输入端口" };
  }
  const alreadyConnected = edges.some(
    (edge) => edge.sourceNodeId === source.node.id && edge.targetNodeId === target.node.id,
  );
  if (alreadyConnected) {
    return { valid: false, message: "这两个节点之间已存在连接" };
  }

  const sourceType = source.mediaType;
  const targetAccepts = target.accepts || [target.mediaType];
  if (!targetAccepts.includes(sourceType)) {
    const typeNames: Record<MediaType, string> = { text: "文本", image: "图片", audio: "音频", video: "视频" };
    return { valid: false, message: `无效连接：${typeNames[sourceType]}数据不兼容当前节点` };
  }

  const sameTargetConnections = edges.filter(
    (edge) => edge.targetNodeId === target.node.id && edge.targetPortId === target.portId,
  );
  if (!target.multiple && sameTargetConnections.length > 0) {
    return { valid: false, message: "该输入端口只允许一个连接" };
  }
  if (wouldCreateCycle(edges, source.node.id, target.node.id)) {
    return { valid: false, message: "不允许形成循环依赖" };
  }
  return { valid: true };
}

export function validateNodeReady(nodes: WorkflowNode[], edges: WorkflowEdge[], nodeId: string) {
  const node = nodes.find((item) => item.id === nodeId);
  const definition = node ? getNodeDefinition(node.type) : undefined;
  if (!node || !definition) return { ready: false, message: "节点不存在" };

  for (const input of definition.inputs) {
    if (!input.required) continue;
    const connected = edges.some((edge) => edge.targetNodeId === nodeId);
    if (!connected) return { ready: false, message: "缺少必需输入连接" };
  }

  return { ready: true };
}

export function collectNodeInputs(nodes: WorkflowNode[], edges: WorkflowEdge[], nodeId: string) {
  const incoming = edges.filter((edge) => edge.targetNodeId === nodeId);
  const promptParts: string[] = [];
  const images: string[] = [];
  const audios: string[] = [];
  const videos: string[] = [];

  for (const edge of incoming) {
    const sourceNode = nodes.find((node) => node.id === edge.sourceNodeId);
    if (!sourceNode) continue;
    const sourceDef = getNodeDefinition(sourceNode.type);
    const outputType = sourceDef?.outputs[0]?.mediaType;
    if (outputType === "text") promptParts.push(String(sourceNode.data.prompt || ""));
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

  return {
    prompt: promptParts.join("\n\n"),
    images,
    audios,
    videos,
  };
}

export function normalizePortId(portId: string) {
  return portId.replace(/__\d+$/, "");
}

function wouldCreateCycle(edges: WorkflowEdge[], sourceNodeId: string, targetNodeId: string) {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const next = graph.get(edge.sourceNodeId) || [];
    next.push(edge.targetNodeId);
    graph.set(edge.sourceNodeId, next);
  }
  graph.set(sourceNodeId, [...(graph.get(sourceNodeId) || []), targetNodeId]);

  const visited = new Set<string>();
  const stack = [targetNodeId];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    if (current === sourceNodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(graph.get(current) || []));
  }
  return false;
}
