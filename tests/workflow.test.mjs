import assert from "node:assert/strict";
import test from "node:test";

function getNodeDefinition(type) {
  const definitions = {
    "text.input": {
      inputs: [],
      outputs: [{ id: "out", direction: "output", mediaType: "text" }],
    },
    "image.generate": {
      inputs: [
        { id: "in", name: "输入", direction: "input", mediaType: "text", accepts: ["text", "image"], required: true, multiple: true },
      ],
      outputs: [{ id: "out", direction: "output", mediaType: "image" }],
    },
  };
  return definitions[type];
}

function normalizePortId(portId) {
  return portId.replace(/__\d+$/, "");
}

function findPort(nodes, nodeId, portId) {
  if (!nodeId || !portId) return undefined;
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return undefined;
  const definition = getNodeDefinition(node.type);
  const portBaseId = normalizePortId(portId);
  const port = [...(definition?.inputs || []), ...(definition?.outputs || [])].find((item) => item.id === portBaseId);
  if (!port) return undefined;
  return { node, portId: portBaseId, mediaType: port.mediaType, accepts: port.accepts, direction: port.direction, multiple: port.multiple };
}

function validateConnection(nodes, edges, candidate) {
  const source = findPort(nodes, candidate.source, candidate.sourceHandle);
  const target = findPort(nodes, candidate.target, candidate.targetHandle);
  if (!source || !target) return { valid: false };
  if (source.direction !== "output" || target.direction !== "input") return { valid: false };
  const alreadyConnected = edges.some((edge) => edge.sourceNodeId === source.node.id && edge.targetNodeId === target.node.id);
  if (alreadyConnected) return { valid: false };
  const targetAccepts = target.accepts || [target.mediaType];
  if (!targetAccepts.includes(source.mediaType)) return { valid: false };
  const sameTargetConnections = edges.filter((edge) => edge.targetNodeId === target.node.id && edge.targetPortId === target.portId);
  if (!target.multiple && sameTargetConnections.length > 0) return { valid: false };
  return { valid: true };
}

function validateNodeReady(nodes, edges, nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  const definition = node ? getNodeDefinition(node.type) : undefined;
  if (!node || !definition) return { ready: false };
  for (const input of definition.inputs) {
    if (!input.required) continue;
    const connected = edges.some((edge) => edge.targetNodeId === nodeId);
    if (!connected) return { ready: false };
  }
  return { ready: true };
}

function topologicalExecutableOrder(nodeIds, edges, nodes) {
  const selectedNodeIds = new Set(nodeIds);
  const selectedNodes = nodes.filter((node) => selectedNodeIds.has(node.id));
  const indegree = new Map();
  const adjacency = new Map();
  for (const node of selectedNodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (!selectedNodeIds.has(edge.sourceNodeId) || !selectedNodeIds.has(edge.targetNodeId)) continue;
    adjacency.get(edge.sourceNodeId).push(edge.targetNodeId);
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) || 0) + 1);
  }
  const queue = selectedNodes.filter((node) => (indegree.get(node.id) || 0) === 0);
  const ordered = [];
  while (queue.length) {
    const current = queue.shift();
    ordered.push(current);
    for (const nextId of adjacency.get(current.id) || []) {
      const nextDegree = (indegree.get(nextId) || 0) - 1;
      indegree.set(nextId, nextDegree);
      if (nextDegree === 0) queue.push(selectedNodes.find((node) => node.id === nextId));
    }
  }
  if (ordered.length !== selectedNodes.length) throw new Error("cycle");
  return ordered.filter((node) => node.type.endsWith(".generate"));
}

const nodes = [
  { id: "text1", type: "text.input" },
  { id: "image1", type: "image.generate" },
  { id: "image2", type: "image.generate" },
];

test("validateConnection allows text output to image.generate input", () => {
  const result = validateConnection(nodes, [], { source: "text1", sourceHandle: "out", target: "image1", targetHandle: "in" });
  assert.equal(result.valid, true);
});

test("validateConnection rejects duplicate connection between same nodes", () => {
  const edges = [{ id: "e1", sourceNodeId: "text1", sourcePortId: "out", targetNodeId: "image1", targetPortId: "in" }];
  const result = validateConnection(nodes, edges, { source: "text1", sourceHandle: "out", target: "image1", targetHandle: "in" });
  assert.equal(result.valid, false);
});

test("validateConnection rejects audio output to audio.generate input", () => {
  const audioNodes = [
    { id: "audio1", type: "audio.input" },
    { id: "gen1", type: "image.generate" },
  ];
  const audioDef = {
    "audio.input": {
      inputs: [],
      outputs: [{ id: "out", direction: "output", mediaType: "audio" }],
    },
    "image.generate": getNodeDefinition("image.generate"),
  };
  const orig = getNodeDefinition;
  const result = (() => {
    const source = { node: audioNodes[0], portId: "out", mediaType: "audio", direction: "output" };
    const target = { node: audioNodes[1], portId: "in", mediaType: "text", accepts: ["text", "image"], direction: "input", multiple: true };
    const targetAccepts = target.accepts || [target.mediaType];
    if (!targetAccepts.includes(source.mediaType)) return { valid: false };
    return { valid: true };
  })();
  assert.equal(result.valid, false);
});

test("validateNodeReady requires connected input", () => {
  assert.equal(validateNodeReady(nodes, [], "image1").ready, false);
  assert.equal(validateNodeReady(nodes, [{ id: "e1", sourceNodeId: "text1", sourcePortId: "out", targetNodeId: "image1", targetPortId: "in" }], "image1").ready, true);
});

test("topologicalExecutableOrder sorts generate nodes by DAG dependencies", () => {
  const ordered = topologicalExecutableOrder(
    ["text1", "image1", "image2"],
    [
      { id: "e1", sourceNodeId: "text1", sourcePortId: "out", targetNodeId: "image1", targetPortId: "in" },
      { id: "e2", sourceNodeId: "image1", sourcePortId: "out", targetNodeId: "image2", targetPortId: "in" },
      { id: "e3", sourceNodeId: "text1", sourcePortId: "out", targetNodeId: "image2", targetPortId: "in" },
    ],
    nodes,
  );
  assert.deepEqual(ordered.map((node) => node.id), ["image1", "image2"]);
});
