import type { WorkflowEdge, WorkflowNode } from "./types";

export function topologicalExecutableOrder(nodeIds: string[], edges: WorkflowEdge[], nodes: WorkflowNode[]) {
  const selectedNodeIds = new Set(nodeIds);
  const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of selectedNodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    if (!selectedNodeIds.has(edge.sourceNodeId) || !selectedNodeIds.has(edge.targetNodeId)) continue;
    adjacency.get(edge.sourceNodeId)?.push(edge.targetNodeId);
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) || 0) + 1);
  }

  const positionIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const queue = selectedNodes
    .filter((node) => (indegree.get(node.id) || 0) === 0)
    .sort((left, right) => (positionIndex.get(left.id) || 0) - (positionIndex.get(right.id) || 0));
  const ordered: WorkflowNode[] = [];

  while (queue.length) {
    const current = queue.shift()!;
    ordered.push(current);
    for (const nextId of adjacency.get(current.id) || []) {
      const nextDegree = (indegree.get(nextId) || 0) - 1;
      indegree.set(nextId, nextDegree);
      if (nextDegree === 0) {
        const nextNode = selectedNodes.find((node) => node.id === nextId);
        if (nextNode) {
          queue.push(nextNode);
          queue.sort((left, right) => (positionIndex.get(left.id) || 0) - (positionIndex.get(right.id) || 0));
        }
      }
    }
  }

  if (ordered.length !== selectedNodes.length) {
    throw new Error("组合内存在循环依赖，无法运行");
  }

  return ordered.filter((node) => node.type.endsWith(".generate"));
}
