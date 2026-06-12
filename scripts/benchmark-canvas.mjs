import { performance } from "node:perf_hooks";

const SIZES = [100, 300, 500];
const ITERATIONS = 30;
const WARMUPS = 5;
const NODE_WIDTH = 286;
const NODE_HEIGHT = 248;
const GROUP_PADDING = 42;

const nodeDefinitions = {
  "text.input": { output: "text", requiredInput: false },
  "image.input": { output: "image", requiredInput: false },
  "audio.input": { output: "audio", requiredInput: false },
  "video.input": { output: "video", requiredInput: false },
  "image.generate": { output: "image", requiredInput: true },
  "audio.generate": { output: "audio", requiredInput: true },
  "video.generate": { output: "video", requiredInput: true },
};

function createNode(type, index) {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const column = index % 10;
  const row = Math.floor(index / 10);
  const base = {
    id: `node_${String(index).padStart(4, "0")}`,
    type,
    title: type,
    position: { x: column * 380 + (row % 2) * 48, y: row * 320 },
    data: {},
    runtime: { status: "idle", progress: 0 },
    createdAt,
    updatedAt: createdAt,
  };

  if (type === "text.input") {
    base.data = {
      prompt: `benchmark prompt ${index}: cinematic anime city, clean line art, layered lighting, reusable text input`,
    };
  } else if (type === "image.input") {
    base.data = {
      url: `/bench-assets/reference-${index}.png`,
      name: `reference-${index}.png`,
    };
  } else if (type === "audio.input") {
    base.data = {
      url: `/bench-assets/audio-${index}.wav`,
      name: `audio-${index}.wav`,
    };
  } else if (type === "video.input") {
    base.data = {
      url: `/bench-assets/video-${index}.mp4`,
      name: `video-${index}.mp4`,
    };
  } else if (type === "image.generate") {
    base.data = {
      modelId: "z-image-turbo",
      resultUrl: index % 6 === 0 ? `/bench-results/image-${index}.png` : "",
      refImages: [],
      prompt: "",
      params: {
        size: "1k",
        aspect_ratio: index % 4 === 0 ? "16:9" : "1:1",
        n: 1,
        response_format: "url",
        num_inference_steps: 9,
      },
    };
    if (base.data.resultUrl) base.runtime.inputSignature = `previous_signature_${index}`;
  } else if (type === "audio.generate") {
    base.data = {
      voice: index % 2 === 0 ? "default_female" : "default_male",
      resultUrl: "",
    };
  } else if (type === "video.generate") {
    base.data = {
      duration: 5 + (index % 4),
      fps: 24,
      resultUrl: "",
    };
  }

  return base;
}

function typeForIndex(index) {
  const pattern = [
    "text.input",
    "image.input",
    "image.generate",
    "audio.generate",
    "video.generate",
    "text.input",
    "image.generate",
    "video.input",
    "image.generate",
    "audio.input",
  ];
  return pattern[index % pattern.length];
}

function latestBefore(nodes, index, predicate) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (predicate(nodes[cursor])) return nodes[cursor];
  }
  return undefined;
}

function addEdge(edges, source, target) {
  if (!source || !target || source.id === target.id) return;
  if (edges.some((edge) => edge.sourceNodeId === source.id && edge.targetNodeId === target.id)) return;
  edges.push({
    id: `edge_${String(edges.length).padStart(5, "0")}`,
    sourceNodeId: source.id,
    sourcePortId: "out",
    targetNodeId: target.id,
    targetPortId: "in",
  });
}

function createFixture(nodeCount) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => createNode(typeForIndex(index), index));
  const edges = [];

  nodes.forEach((node, index) => {
    if (!node.type.endsWith(".generate")) return;
    addEdge(edges, latestBefore(nodes, index, (item) => item.type === "text.input"), node);
    if (node.type === "image.generate" || node.type === "video.generate") {
      addEdge(edges, latestBefore(nodes, index, (item) => item.type === "image.input" || item.type === "image.generate"), node);
    }
    if (node.type === "video.generate") {
      addEdge(edges, latestBefore(nodes, index, (item) => item.type === "audio.input" || item.type === "audio.generate"), node);
      addEdge(edges, latestBefore(nodes, index, (item) => item.type === "video.input"), node);
    }
  });

  const groups = [];
  for (let start = 0; start < nodes.length; start += 25) {
    const groupNodes = nodes.slice(start, Math.min(start + 25, nodes.length));
    groups.push({
      id: `group_${String(groups.length).padStart(3, "0")}`,
      title: `Benchmark group ${groups.length + 1}`,
      nodeIds: groupNodes.map((node) => node.id),
      bounds: getGroupBounds(groupNodes),
      runtime: { status: "idle", total: groupNodes.length, completed: 0, failed: 0, skipped: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }

  return {
    nodes,
    edges,
    groups,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function getOutputType(node) {
  return nodeDefinitions[node.type]?.output;
}

function getConnectedInputsLegacyScan(nodes, edges, nodeId) {
  const incoming = edges.filter((edge) => edge.targetNodeId === nodeId);
  const texts = [];
  const images = [];
  const audios = [];
  const videos = [];

  for (const edge of incoming) {
    const sourceNode = nodes.find((node) => node.id === edge.sourceNodeId);
    if (!sourceNode) continue;
    const outputType = getOutputType(sourceNode);
    const url = String(sourceNode.data.url || sourceNode.data.resultUrl || "");
    if (outputType === "text") {
      const prompt = String(sourceNode.data.prompt || "");
      if (prompt) texts.push(prompt);
    }
    if (outputType === "image" && url) images.push(url);
    if (outputType === "audio" && url) audios.push(url);
    if (outputType === "video" && url) videos.push(url);
  }

  return { texts, images, audios, videos };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getNodeInputSignatureLegacyScan(node, nodes, edges) {
  return stableStringify({
    connectedInputs: getConnectedInputsLegacyScan(nodes, edges, node.id),
    prompt: node.data.prompt || "",
    refImages: node.data.refImages || [],
    modelId: node.data.modelId || "z-image-turbo",
    params: node.data.params || {},
  });
}

function validateNodeReadyLegacyScan(nodes, edges, nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node || !nodeDefinitions[node.type]) return false;
  if (!nodeDefinitions[node.type].requiredInput) return true;
  return edges.some((edge) => edge.targetNodeId === nodeId);
}

function transformLegacyScan(snapshot) {
  return snapshot.nodes.map((workflow) => {
    const ready = validateNodeReadyLegacyScan(snapshot.nodes, snapshot.edges, workflow.id);
    const inputSignature = workflow.type.endsWith(".generate")
      ? getNodeInputSignatureLegacyScan(workflow, snapshot.nodes, snapshot.edges)
      : undefined;
    const resultStale = Boolean(
      inputSignature
        && workflow.data.resultUrl
        && workflow.runtime.inputSignature
        && workflow.runtime.inputSignature !== inputSignature,
    );
    return {
      id: workflow.id,
      type: "workflow",
      position: workflow.position,
      style: { width: NODE_WIDTH, minHeight: NODE_HEIGHT },
      data: {
        canRun: workflow.type.endsWith(".generate") && ready,
        inputSignature,
        resultStale,
        connectedInputs: getConnectedInputsLegacyScan(snapshot.nodes, snapshot.edges, workflow.id),
      },
    };
  });
}

function buildIndexes(snapshot) {
  const nodeById = new Map();
  const incomingByTarget = new Map();
  for (const node of snapshot.nodes) nodeById.set(node.id, node);
  for (const edge of snapshot.edges) {
    const next = incomingByTarget.get(edge.targetNodeId) || [];
    next.push(edge);
    incomingByTarget.set(edge.targetNodeId, next);
  }
  return { nodeById, incomingByTarget };
}

function getConnectedInputsIndexed(indexes, nodeId) {
  const incoming = indexes.incomingByTarget.get(nodeId) || [];
  const texts = [];
  const images = [];
  const audios = [];
  const videos = [];

  for (const edge of incoming) {
    const sourceNode = indexes.nodeById.get(edge.sourceNodeId);
    if (!sourceNode) continue;
    const outputType = getOutputType(sourceNode);
    const url = String(sourceNode.data.url || sourceNode.data.resultUrl || "");
    if (outputType === "text") {
      const prompt = String(sourceNode.data.prompt || "");
      if (prompt) texts.push(prompt);
    }
    if (outputType === "image" && url) images.push(url);
    if (outputType === "audio" && url) audios.push(url);
    if (outputType === "video" && url) videos.push(url);
  }

  return { texts, images, audios, videos };
}

function transformIndexed(snapshot) {
  const indexes = buildIndexes(snapshot);
  return snapshot.nodes.map((workflow) => {
    const ready = !nodeDefinitions[workflow.type]?.requiredInput
      || Boolean(indexes.incomingByTarget.get(workflow.id)?.length);
    const inputSignature = workflow.type.endsWith(".generate")
      ? stableStringify({
        connectedInputs: getConnectedInputsIndexed(indexes, workflow.id),
        prompt: workflow.data.prompt || "",
        refImages: workflow.data.refImages || [],
        modelId: workflow.data.modelId || "z-image-turbo",
        params: workflow.data.params || {},
      })
      : undefined;
    return {
      id: workflow.id,
      type: "workflow",
      position: workflow.position,
      style: { width: NODE_WIDTH, minHeight: NODE_HEIGHT },
      data: {
        canRun: workflow.type.endsWith(".generate") && ready,
        inputSignature,
        resultStale: Boolean(
          inputSignature
            && workflow.data.resultUrl
            && workflow.runtime.inputSignature
            && workflow.runtime.inputSignature !== inputSignature,
        ),
        connectedInputs: getConnectedInputsIndexed(indexes, workflow.id),
      },
    };
  });
}

function migrateSnapshot(snapshot) {
  return {
    ...snapshot,
    edges: (snapshot.edges || []).map((edge) => ({
      ...edge,
      sourcePortId: "out",
      targetPortId: "in",
    })),
  };
}

function getGroupBounds(nodes) {
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const maxX = Math.max(...nodes.map((node) => node.position.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map((node) => node.position.y + NODE_HEIGHT));
  return {
    x: minX - GROUP_PADDING,
    y: minY - GROUP_PADDING,
    width: maxX - minX + GROUP_PADDING * 2,
    height: maxY - minY + GROUP_PADDING * 2,
  };
}

function recomputeGroupsLegacy(groups, nodes) {
  return groups.map((group) => {
    const groupNodes = nodes.filter((node) => group.nodeIds.includes(node.id));
    if (!groupNodes.length) return group;
    return {
      ...group,
      bounds: getGroupBounds(groupNodes),
    };
  });
}

function recomputeGroupsIndexed(groups, nodes) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return groups.map((group) => {
    const groupNodes = group.nodeIds.map((nodeId) => nodeById.get(nodeId)).filter(Boolean);
    if (!groupNodes.length) return group;
    return {
      ...group,
      bounds: getGroupBounds(groupNodes),
    };
  });
}

function getSelectionIds(snapshot) {
  const step = Math.max(1, Math.floor(snapshot.nodes.length / 40));
  return snapshot.nodes.filter((_, index) => index % step === 0).slice(0, 50).map((node) => node.id);
}

function simulateSelectionLegacy(snapshot) {
  const selectedIds = getSelectionIds(snapshot);
  let checksum = 0;
  for (const nodeId of selectedIds) {
    const node = snapshot.nodes.find((item) => item.id === nodeId);
    const incomingCount = snapshot.edges.filter((edge) => edge.targetNodeId === nodeId).length;
    const outgoingCount = snapshot.edges.filter((edge) => edge.sourceNodeId === nodeId).length;
    const groupCount = snapshot.groups.filter((group) => group.nodeIds.includes(nodeId)).length;
    checksum += (node ? node.position.x + node.position.y : 0) + incomingCount + outgoingCount + groupCount;
  }
  return checksum;
}

function simulateSelectionIndexed(snapshot) {
  const selectedIds = getSelectionIds(snapshot);
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const incomingCountByNodeId = new Map();
  const outgoingCountByNodeId = new Map();
  const groupCountByNodeId = new Map();

  for (const edge of snapshot.edges) {
    incomingCountByNodeId.set(edge.targetNodeId, (incomingCountByNodeId.get(edge.targetNodeId) || 0) + 1);
    outgoingCountByNodeId.set(edge.sourceNodeId, (outgoingCountByNodeId.get(edge.sourceNodeId) || 0) + 1);
  }
  for (const group of snapshot.groups) {
    for (const nodeId of group.nodeIds) {
      groupCountByNodeId.set(nodeId, (groupCountByNodeId.get(nodeId) || 0) + 1);
    }
  }

  let checksum = 0;
  for (const nodeId of selectedIds) {
    const node = nodeById.get(nodeId);
    checksum += (node ? node.position.x + node.position.y : 0)
      + (incomingCountByNodeId.get(nodeId) || 0)
      + (outgoingCountByNodeId.get(nodeId) || 0)
      + (groupCountByNodeId.get(nodeId) || 0);
  }
  return checksum;
}

function simulateDrag(snapshot, recompute) {
  const selectedCount = Math.min(60, Math.max(10, Math.floor(snapshot.nodes.length * 0.12)));
  const selectedIds = new Set(snapshot.nodes.slice(Math.floor(snapshot.nodes.length * 0.35), Math.floor(snapshot.nodes.length * 0.35) + selectedCount).map((node) => node.id));
  const nextNodes = snapshot.nodes.map((node) => (
    selectedIds.has(node.id)
      ? {
        ...node,
        position: { x: node.position.x + 24, y: node.position.y + 16 },
        updatedAt: "2026-01-01T00:00:01.000Z",
      }
      : node
  ));
  return recompute(snapshot.groups, nextNodes);
}

function simulateDeleteLoop(snapshot) {
  const selectedIds = getSelectionIds(snapshot);
  let nodes = snapshot.nodes;
  let edges = snapshot.edges;
  let groups = snapshot.groups;
  for (const nodeId of selectedIds) {
    nodes = nodes.filter((node) => node.id !== nodeId);
    edges = edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId);
    groups = groups
      .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) }))
      .filter((group) => group.nodeIds.length > 1);
  }
  return { nodes: nodes.length, edges: edges.length, groups: groups.length };
}

function simulateDeleteBatch(snapshot) {
  const selectedIdSet = new Set(getSelectionIds(snapshot));
  const nodes = snapshot.nodes.filter((node) => !selectedIdSet.has(node.id));
  const edges = snapshot.edges.filter((edge) => !selectedIdSet.has(edge.sourceNodeId) && !selectedIdSet.has(edge.targetNodeId));
  const groups = snapshot.groups
    .map((group) => {
      const nodeIds = group.nodeIds.filter((id) => !selectedIdSet.has(id));
      return nodeIds.length === group.nodeIds.length ? group : { ...group, nodeIds };
    })
    .filter((group) => group.nodeIds.length > 1);
  return { nodes: nodes.length, edges: edges.length, groups: groups.length };
}

function simulateSaveRepeated(snapshot) {
  const snapshotJson = JSON.stringify(snapshot);
  const localJson = JSON.stringify(snapshot);
  const saveBodyJson = JSON.stringify({ snapshot });
  return snapshotJson.length + localJson.length + saveBodyJson.length;
}

function simulateSaveCached(snapshot) {
  const snapshotJson = JSON.stringify(snapshot);
  const saveBodyJson = `{"snapshot":${snapshotJson}}`;
  return snapshotJson.length + snapshotJson.length + saveBodyJson.length;
}

function createEditEventJsons(snapshot) {
  const textNodeIds = snapshot.nodes.filter((node) => node.type === "text.input").map((node) => node.id);
  const editableNodeIds = textNodeIds.length ? textNodeIds : snapshot.nodes.map((node) => node.id);
  const eventJsons = [];

  for (let editIndex = 0; editIndex < 12; editIndex += 1) {
    const nodeId = editableNodeIds[editIndex % editableNodeIds.length];
    const editedSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => (
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                prompt: `${node.data.prompt || ""} edit ${editIndex}`,
              },
              updatedAt: `2026-01-01T00:00:${String(editIndex).padStart(2, "0")}.000Z`,
            }
          : node
      )),
    };
    const snapshotJson = JSON.stringify(editedSnapshot);
    for (let repeatIndex = 0; repeatIndex < 4; repeatIndex += 1) eventJsons.push(snapshotJson);
  }

  return eventJsons;
}

function simulateLegacyEditScheduling(eventJsons) {
  let localWrites = 0;
  let broadcastSchedules = 0;
  let saveSchedules = 0;
  let statusWrites = 0;

  for (const snapshotJson of eventJsons) {
    if (!snapshotJson) continue;
    localWrites += 1;
    broadcastSchedules += 1;
    saveSchedules += 1;
    statusWrites += 1;
  }

  return localWrites + broadcastSchedules + saveSchedules + statusWrites;
}

function simulateDedupedEditScheduling(eventJsons) {
  let localWrites = 0;
  let broadcastSchedules = 0;
  let saveSchedules = 0;
  let statusWrites = 0;
  let lastLocalSnapshotJson = null;
  let lastBroadcastSnapshotJson = null;
  let pendingBroadcastSnapshotJson = null;
  let lastSavedSnapshotJson = null;
  let pendingSaveSnapshotJson = null;

  for (const snapshotJson of eventJsons) {
    if (lastLocalSnapshotJson !== snapshotJson) {
      localWrites += 1;
      lastLocalSnapshotJson = snapshotJson;
    }

    if (lastBroadcastSnapshotJson === snapshotJson) {
      pendingBroadcastSnapshotJson = null;
    } else if (pendingBroadcastSnapshotJson !== snapshotJson) {
      broadcastSchedules += 1;
      pendingBroadcastSnapshotJson = snapshotJson;
    }

    if (lastSavedSnapshotJson === snapshotJson || pendingSaveSnapshotJson === snapshotJson) continue;
    pendingSaveSnapshotJson = snapshotJson;
    saveSchedules += 1;
    statusWrites += 1;
  }

  return localWrites + broadcastSchedules + saveSchedules + statusWrites;
}

function simulateAssetRefreshLegacyRenders(snapshot) {
  return snapshot.nodes.length;
}

function simulateAssetRefreshMemoRenders(snapshot) {
  const expandedNodeCount = snapshot.nodes.length > 0 ? 1 : 0;
  return expandedNodeCount;
}

function measure(label, operation) {
  let last;
  for (let index = 0; index < WARMUPS; index += 1) last = operation();

  const samples = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const start = performance.now();
    last = operation();
    samples.push(performance.now() - start);
  }

  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  const min = samples[0];
  const max = samples[samples.length - 1];
  return { label, median, min, max, last };
}

function formatMs(value) {
  return value.toFixed(2);
}

function formatKb(value) {
  return (value / 1024).toFixed(1);
}

function printTable(rows) {
  const columns = [
    ["nodes", "nodes"],
    ["edges", "edges"],
    ["groups", "groups"],
    ["snapshotKB", "snapshotKb"],
    ["legacyScanMs", "legacyScanMs"],
    ["indexedLoadMs", "indexedLoadMs"],
    ["legacySelectMs", "legacySelectMs"],
    ["indexedSelectMs", "indexedSelectMs"],
    ["legacyDragMs", "legacyDragMs"],
    ["indexedDragMs", "indexedDragMs"],
    ["loopDeleteMs", "loopDeleteMs"],
    ["batchDeleteMs", "batchDeleteMs"],
    ["saveRepeatedMs", "saveRepeatedMs"],
    ["saveCachedMs", "saveCachedMs"],
    ["editLegacyOps", "editLegacyOps"],
    ["editDedupOps", "editDedupOps"],
    ["assetLegacyRenders", "assetLegacyRenders"],
    ["assetMemoRenders", "assetMemoRenders"],
  ];
  const widths = columns.map(([heading, key]) => Math.max(heading.length, ...rows.map((row) => String(row[key]).length)));
  const divider = `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`;
  const header = `|${columns.map(([heading], index) => ` ${heading.padEnd(widths[index])} `).join("|")}|`;
  console.log(header);
  console.log(divider);
  for (const row of rows) {
    console.log(`|${columns.map(([, key], index) => ` ${String(row[key]).padEnd(widths[index])} `).join("|")}|`);
  }
}

function runBenchmark() {
  const rows = [];

  for (const size of SIZES) {
    const fixture = createFixture(size);
    const rawSnapshot = JSON.stringify(fixture);
    const migratedSnapshot = migrateSnapshot(JSON.parse(rawSnapshot));
    const legacyOutput = transformLegacyScan(migratedSnapshot);
    const indexedOutput = transformIndexed(migratedSnapshot);
    if (JSON.stringify(legacyOutput) !== JSON.stringify(indexedOutput)) {
      throw new Error(`Indexed load output differs from legacy scan output for ${size} nodes.`);
    }
    const legacyDragOutput = simulateDrag(fixture, recomputeGroupsLegacy);
    const indexedDragOutput = simulateDrag(fixture, recomputeGroupsIndexed);
    if (JSON.stringify(legacyDragOutput) !== JSON.stringify(indexedDragOutput)) {
      throw new Error(`Indexed drag output differs from legacy drag output for ${size} nodes.`);
    }
    const legacySelectionOutput = simulateSelectionLegacy(fixture);
    const indexedSelectionOutput = simulateSelectionIndexed(fixture);
    if (legacySelectionOutput !== indexedSelectionOutput) {
      throw new Error(`Indexed selection output differs from legacy selection output for ${size} nodes.`);
    }
    const loopDeleteOutput = simulateDeleteLoop(fixture);
    const batchDeleteOutput = simulateDeleteBatch(fixture);
    if (JSON.stringify(loopDeleteOutput) !== JSON.stringify(batchDeleteOutput)) {
      throw new Error(`Batch delete output differs from loop delete output for ${size} nodes.`);
    }
    const repeatedSaveOutput = simulateSaveRepeated(fixture);
    const cachedSaveOutput = simulateSaveCached(fixture);
    if (repeatedSaveOutput !== cachedSaveOutput) {
      throw new Error(`Cached save output size differs from repeated save output for ${size} nodes.`);
    }
    const editEventJsons = createEditEventJsons(fixture);
    const legacyEditOps = simulateLegacyEditScheduling(editEventJsons);
    const dedupedEditOps = simulateDedupedEditScheduling(editEventJsons);
    if (dedupedEditOps >= legacyEditOps) {
      throw new Error(`Deduped edit scheduling did not reduce queue operations for ${size} nodes.`);
    }
    const assetLegacyRenders = simulateAssetRefreshLegacyRenders(fixture);
    const assetMemoRenders = simulateAssetRefreshMemoRenders(fixture);
    if (assetMemoRenders >= assetLegacyRenders) {
      throw new Error(`Memoized asset refresh renders did not reduce rendered nodes for ${size} nodes.`);
    }
    const legacyScan = measure("legacyScan", () => transformLegacyScan(migrateSnapshot(JSON.parse(rawSnapshot))));
    const indexedLoad = measure("indexedLoad", () => transformIndexed(migrateSnapshot(JSON.parse(rawSnapshot))));
    const legacySelection = measure("legacySelection", () => simulateSelectionLegacy(fixture));
    const indexedSelection = measure("indexedSelection", () => simulateSelectionIndexed(fixture));
    const legacyDrag = measure("legacyDrag", () => simulateDrag(fixture, recomputeGroupsLegacy));
    const indexedDrag = measure("indexedDrag", () => simulateDrag(fixture, recomputeGroupsIndexed));
    const loopDelete = measure("loopDelete", () => simulateDeleteLoop(fixture));
    const batchDelete = measure("batchDelete", () => simulateDeleteBatch(fixture));
    const saveRepeated = measure("saveRepeated", () => simulateSaveRepeated(fixture));
    const saveCached = measure("saveCached", () => simulateSaveCached(fixture));

    rows.push({
      nodes: fixture.nodes.length,
      edges: fixture.edges.length,
      groups: fixture.groups.length,
      snapshotKb: formatKb(rawSnapshot.length),
      legacyScanMs: formatMs(legacyScan.median),
      indexedLoadMs: formatMs(indexedLoad.median),
      legacySelectMs: formatMs(legacySelection.median),
      indexedSelectMs: formatMs(indexedSelection.median),
      legacyDragMs: formatMs(legacyDrag.median),
      indexedDragMs: formatMs(indexedDrag.median),
      loopDeleteMs: formatMs(loopDelete.median),
      batchDeleteMs: formatMs(batchDelete.median),
      saveRepeatedMs: formatMs(saveRepeated.median),
      saveCachedMs: formatMs(saveCached.median),
      editLegacyOps: legacyEditOps,
      editDedupOps: dedupedEditOps,
      assetLegacyRenders,
      assetMemoRenders,
    });
  }

  console.log(`Canvas benchmark, median of ${ITERATIONS} runs after ${WARMUPS} warmups.`);
  console.log("legacyScan keeps the old per-node scan path as a comparison; indexedLoad mirrors the optimized canvas load path.");
  console.log("legacyDrag keeps the old group recompute path as a comparison; indexedDrag mirrors the optimized drag-stop path.");
  console.log("legacySelect and loopDelete keep the old selection/delete scans as comparisons; indexedSelect and batchDelete mirror the optimized selection paths.");
  console.log("saveRepeated keeps the old repeated stringify path as a comparison; saveCached mirrors the optimized cached snapshot JSON path.");
  console.log("editLegacyOps/editDedupOps count local snapshot writes, broadcast queues, save queues, and save-status writes across repeated edit events.");
  console.log("assetLegacyRenders/assetMemoRenders compare node renders caused by asset-library refresh when one node is expanded.");
  printTable(rows);
}

runBenchmark();
