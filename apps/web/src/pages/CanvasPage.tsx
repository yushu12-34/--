import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  useUpdateNodeInternals,
  useViewport,
  ViewportPortal,
  useEdgesState,
  useNodesState,
  type Connection,
  type FinalConnectionState,
  type OnConnectStartParams,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { compactYjsDocument, copyCanvas, copyProject, createAsset, createCanvas, createProject, createTask, createUser, deleteAsset, deleteCanvas, deleteProject, ensureProject, exportProject, getCanvas, getProject, getTask, getYjsHistorySnapshot, importProject, listAssets, listModels, listProjects, listUsers, listYjsHistory, saveSnapshot, saveSnapshotJson, updateAsset, updateCanvas, updateProject } from "../api";
import { createCollaborationClient, type CollaborationStatus, type CollaborationUser } from "../collaboration";
import { nodeDefinitions } from "../nodeDefinitions";
import type { AITask, AssetRecord, CanvasRecord, CanvasSnapshot, ProjectRecord, UserRecord, WorkflowEdge, WorkflowGroup, WorkflowNode, YjsSnapshotDetail, YjsSnapshotRecord } from "../types";
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
  removeYCanvasNodes,
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
import { CollaborationOverlay, GroupOverlay } from "./canvas/CanvasOverlays";
import {
  CONNECTION_PICKER_TEMP_NODE_ID,
  getConnectionPickerCandidates,
  type ConnectionDragStart,
  type ConnectionPickerCandidate,
} from "./canvas/connectionPicker";
import { edgeTypes } from "./canvas/WorkflowEdge";
import { nodeTypes } from "./canvas/WorkflowCard";
import { getVisibleAssetCount, getVisibleAssets, shouldCommitAssetLoad, type ProjectAssetState } from "./canvas/assetRuntime";
import { pickPublicParams } from "./canvas/modelParams";
import type { WorkflowReactEdge, WorkflowReactNode } from "./canvas/workflowTypes";
import {
  LOCAL_SNAPSHOT_KEY,
  createId,
  fileToDataUrl,
  formatBytes,
  formatHistoryTime,
  formatOptionalTime,
  fromReactFlowEdges,
  getGroupBounds,
  getNodeIcon,
  getNodeInputSignature,
  getReactFlowNodeBounds,
  hasSnapshotContent,
  makeWorkflowNode,
  mergeRemoteSnapshotWithProtectedNode,
  migrateSnapshot,
  nodeChanged,
  readLocalSnapshot,
  recomputeGroups,
  sameNodeSet,
  snapshotFromState,
  summarizeSnapshot,
  toReactFlowEdges,
  toReactFlowNodes,
  validateProjectBundleForImport,
} from "./canvas/canvasUtils";

interface SnapshotBundle {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: WorkflowGroup[];
  snapshot: CanvasSnapshot;
  snapshotJson: string;
  saveBodyJson?: string;
}

interface PendingSnapshotSave {
  canvasId: string;
  bodyJson: string;
  snapshotJson: string;
}

interface ConnectionPickerState {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
  dragStart: ConnectionDragStart;
  candidates: ConnectionPickerCandidate[];
}

function getPointerClientPoint(event: MouseEvent | TouchEvent) {
  if ("changedTouches" in event && event.changedTouches.length > 0) {
    const touch = event.changedTouches[0];
    return { x: touch.clientX, y: touch.clientY };
  }
  if ("touches" in event && event.touches.length > 0) {
    const touch = event.touches[0];
    return { x: touch.clientX, y: touch.clientY };
  }
  return { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
}

function applyConnectionDefaults(sourceNode?: WorkflowNode | null, targetNode?: WorkflowNode | null): Partial<WorkflowNode> | null {
  if (
    targetNode?.type === "image.generate"
    && sourceNode?.type === "text.input"
    && !targetNode.data.promptTouched
    && !String(targetNode.data.prompt || "").trim()
  ) {
    return { data: { prompt: String(sourceNode.data.prompt || "") } };
  }
  return null;
}

function mergeWorkflowNodePatch(node: WorkflowNode, patch: Partial<WorkflowNode>): WorkflowNode {
  return {
    ...node,
    ...patch,
    data: patch.data ? { ...node.data, ...patch.data } : node.data,
    runtime: patch.runtime ? { ...node.runtime, ...patch.runtime } : node.runtime,
    updatedAt: new Date().toISOString(),
  };
}

function formatConnectionCandidateMeta(candidate: ConnectionPickerCandidate) {
  const categoryNames: Record<string, string> = {
    input: "输入",
    generate: "生成",
    utility: "工具",
    output: "输出",
  };
  const mediaNames: Record<string, string> = {
    text: "文本",
    image: "图片",
    audio: "音频",
    video: "视频",
  };
  const direction = candidate.direction === "downstream" ? "下游" : "上游";
  const category = categoryNames[candidate.category] || candidate.category;
  const media = candidate.mediaType ? mediaNames[candidate.mediaType] || candidate.mediaType : "";
  return [direction, category, media].filter(Boolean).join(" · ");
}

function getTaskDeadlineAt(task: AITask | null | undefined, fallbackStartedAt: number, timeoutMs: number) {
  if (task?.status === "pending" && !task.startedAt) return Number.POSITIVE_INFINITY;
  const taskStartedAt = task?.startedAt || task?.createdAt;
  const parsedStartedAt = taskStartedAt ? new Date(taskStartedAt).getTime() : Number.NaN;
  return Number.isFinite(parsedStartedAt) ? parsedStartedAt + timeoutMs : fallbackStartedAt + timeoutMs;
}

export function CanvasPage() {
  const { screenToFlowPosition, setViewport, fitView } = useReactFlow<WorkflowReactNode, WorkflowReactEdge>();
  const updateNodeInternals = useUpdateNodeInternals();
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
  const [traceConnection, setTraceConnection] = useState<{ nodeId: string; mode: "inputs" | "outputs" } | null>(null);
  const [assetState, setAssetState] = useState<ProjectAssetState>({ projectId: null, assets: [], loading: false });
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
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number; nodeId?: string } | null>(null);
  const [connectionPicker, setConnectionPicker] = useState<ConnectionPickerState | null>(null);
  const isDraggingNodeRef = useRef(false);
  const groupDragRef = useRef<{
    groupId: string;
    startBounds: WorkflowGroup["bounds"];
    startNodePositions: Record<string, { x: number; y: number }>;
  } | null>(null);
  const activeTaskPollsRef = useRef(new Set<string>());
  const activeProjectIdRef = useRef<string | null>(null);
  const assetLoadRequestIdRef = useRef(0);
  const backendRetryTimerRef = useRef(0);
  const backendLoadInFlightRef = useRef(false);
  const backendLocalFallbackAppliedRef = useRef(false);
  const applyingRemoteSnapshotRef = useRef(false);
  const snapshotVersionRef = useRef(0);
  const collaborationBroadcastTimerRef = useRef(0);
  const saveTimerRef = useRef(0);
  const pendingSaveRef = useRef<PendingSnapshotSave | null>(null);
  const lastSavedSnapshotJsonRef = useRef<string | null>(null);
  const lastBroadcastSnapshotJsonRef = useRef<string | null>(null);
  const pendingBroadcastSnapshotJsonRef = useRef<string | null>(null);
  const lastLocalSnapshotJsonRef = useRef<string | null>(null);
  const localEditUntilRef = useRef(0);
  const historyRef = useRef<{ past: CanvasSnapshot[]; future: CanvasSnapshot[]; restoring: boolean }>({ past: [], future: [], restoring: false });
  const currentSnapshotRef = useRef<CanvasSnapshot | null>(null);
  const currentSnapshotJsonRef = useRef<string | null>(null);
  const snapshotBundleCacheRef = useRef<SnapshotBundle | null>(null);
  const dragHistoryBaselineRef = useRef<CanvasSnapshot | null>(null);
  const dragHistoryBaselineJsonRef = useRef<string | null>(null);
  const yCanvasRef = useRef<ReturnType<typeof createYCanvasDocument> | null>(null);
  if (!yCanvasRef.current) yCanvasRef.current = createYCanvasDocument();
  const applyingYCanvasSnapshotRef = useRef(false);
  const syncingReactStateToYDocRef = useRef(false);
  const skipNextYDocSyncRef = useRef(false);
  const yjsBroadcastTimerRef = useRef(0);
  const lastYjsUpdateRef = useRef<Uint8Array | null>(null);
  const workflowNodesRef = useRef<WorkflowNode[]>([]);
  const workflowEdgesRef = useRef<WorkflowEdge[]>([]);
  const connectionDragStartRef = useRef<ConnectionDragStart | null>(null);
  const connectionSucceededRef = useRef(false);
  const connectionReleaseHandledRef = useRef(false);
  const connectionReleaseAbortRef = useRef<AbortController | null>(null);
  const connectionReleaseFallbackTimerRef = useRef(0);
  const suppressNextPaneClickUntilRef = useRef(0);
  const groupsRef = useRef<WorkflowGroup[]>([]);
  const expandedNodeIdRef = useRef<string | null>(null);
  const selectedNodeIdRef = useRef<string | null>(null);
  const collaborationUsersRef = useRef<CollaborationUser[]>([]);

  const workflowEdges = useMemo(() => fromReactFlowEdges(rfEdges), [rfEdges]);
  useEffect(() => {
    activeProjectIdRef.current = project?.id || null;
  }, [project?.id]);
  const assets = useMemo(() => getVisibleAssets(project?.id, assetState), [assetState, project?.id]);
  const visibleAssetCount = useMemo(
    () => getVisibleAssetCount(project?.id, assetState, project?.assetCount ?? 0),
    [assetState, project?.assetCount, project?.id],
  );
  const visibleAssetCountText = project?.id ? String(visibleAssetCount) : "加载中";
  const assetLibraryLoading = Boolean(project?.id && assetState.loading && (assetState.projectId !== project.id || assetState.assets.length === 0));
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

  // 节点展开/收起后，需要通知 React Flow 重新测量节点尺寸并刷新连接线端点位置。
  // CSS 过渡动画约 180ms，在动画结束后再次刷新以确保最终尺寸正确。
  const prevExpandedNodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    const targets = new Set<string>();
    if (expandedNodeId) targets.add(expandedNodeId);
    const prev = prevExpandedNodeIdRef.current;
    if (prev && prev !== expandedNodeId) targets.add(prev);
    prevExpandedNodeIdRef.current = expandedNodeId;
    if (targets.size === 0) return;
    const rafId = requestAnimationFrame(() => targets.forEach((nodeId) => updateNodeInternals(nodeId)));
    const timerId = window.setTimeout(() => targets.forEach((nodeId) => updateNodeInternals(nodeId)), 220);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
    };
  }, [expandedNodeId, updateNodeInternals]);
  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);
  useEffect(() => {
    collaborationUsersRef.current = collaborationUsers;
  }, [collaborationUsers]);

  const workflowNodeById = useMemo(
    () => new Map(workflowNodes.map((node) => [node.id, node])),
    [workflowNodes],
  );
  const getWorkflowNodesByIds = useCallback((nodeIds: string[]) => {
    const selectedNodes: WorkflowNode[] = [];
    const seen = new Set<string>();
    for (const nodeId of nodeIds) {
      if (seen.has(nodeId)) continue;
      const node = workflowNodeById.get(nodeId);
      if (!node) continue;
      seen.add(nodeId);
      selectedNodes.push(node);
    }
    return selectedNodes;
  }, [workflowNodeById]);

  const getSnapshotBundle = useCallback((nodes = workflowNodes, edges = workflowEdges, currentGroups = groups): SnapshotBundle => {
    const cached = snapshotBundleCacheRef.current;
    if (cached && cached.nodes === nodes && cached.edges === edges && cached.groups === currentGroups) {
      return cached;
    }
    const snapshot = snapshotFromState(nodes, edges, currentGroups);
    const snapshotJson = JSON.stringify(snapshot);
    const bundle: SnapshotBundle = { nodes, edges, groups: currentGroups, snapshot, snapshotJson };
    snapshotBundleCacheRef.current = bundle;
    return bundle;
  }, [groups, workflowEdges, workflowNodes]);

  const getSnapshotSaveBodyJson = useCallback((bundle: SnapshotBundle) => {
    if (!bundle.saveBodyJson) {
      bundle.saveBodyJson = `{"snapshot":${bundle.snapshotJson}}`;
    }
    return bundle.saveBodyJson;
  }, []);

  const cancelPendingSave = useCallback((snapshotJson?: string) => {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = 0;
    pendingSaveRef.current = null;
    setSaveStatus(lastSavedSnapshotJsonRef.current && snapshotJson === lastSavedSnapshotJsonRef.current ? "saved" : "idle");
  }, []);

  const loadProjectAssets = useCallback(async (projectId: string) => {
    const requestId = ++assetLoadRequestIdRef.current;
    setAssetState((current) => current.projectId === projectId
      ? { ...current, loading: true }
      : { projectId, assets: [], loading: true });
    const result = await listAssets(projectId);
    if (!shouldCommitAssetLoad({
      requestId,
      latestRequestId: assetLoadRequestIdRef.current,
      requestedProjectId: projectId,
      activeProjectId: activeProjectIdRef.current,
    })) {
      return null;
    }
    setAssetState({ projectId, assets: result.assets, loading: false });
    return result.assets;
  }, []);

  const prependAsset = useCallback((asset: AssetRecord) => {
    if (activeProjectIdRef.current !== asset.projectId) return;
    setAssetState((current) => current.projectId === asset.projectId
      ? { ...current, assets: [asset, ...current.assets], loading: false }
      : current);
  }, []);

  const patchLoadedAsset = useCallback((asset: AssetRecord) => {
    if (activeProjectIdRef.current !== asset.projectId) return;
    setAssetState((current) => current.projectId === asset.projectId
      ? { ...current, assets: current.assets.map((item) => item.id === asset.id ? asset : item) }
      : current);
  }, []);

  const removeLoadedAsset = useCallback((asset: AssetRecord) => {
    if (activeProjectIdRef.current !== asset.projectId) return;
    setAssetState((current) => current.projectId === asset.projectId
      ? { ...current, assets: current.assets.filter((item) => item.id !== asset.id) }
      : current);
  }, []);

  const filteredAssets = useMemo(
    () => assetFilter === "all" ? assets : assets.filter((asset) => asset.type === assetFilter),
    [assetFilter, assets],
  );

  const selectEdge = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
    setExpandedNodeId(null);
    setTraceConnection(null);
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
      setTraceConnection(null);
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
      window.clearTimeout(collaborationBroadcastTimerRef.current);
      window.clearTimeout(saveTimerRef.current);
      window.clearTimeout(yjsBroadcastTimerRef.current);
      window.clearTimeout(backendRetryTimerRef.current);
      window.clearTimeout(connectionReleaseFallbackTimerRef.current);
      connectionReleaseAbortRef.current?.abort();
      pendingSaveRef.current = null;
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
      data: {
        onSelect: selectEdge,
        selected: edge.id === selectedEdgeId,
        highlighted: Boolean(
          traceConnection
            && (
              traceConnection.mode === "inputs"
                ? edge.target === traceConnection.nodeId
                : edge.source === traceConnection.nodeId
            ),
        ),
        highlightMode: traceConnection?.mode,
      },
    })),
    [rfEdges, selectEdge, selectedEdgeId, traceConnection],
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
        await loadProjectAssets(project.id);
      }
      return task;
    },
    [loadProjectAssets, patchNode, project],
  );

  const pollTaskUntilSettled = useCallback(
    async (nodeId: string, taskId: string, initialPollIntervalMs = 2000, initialTimeoutMs = 120000) => {
      if (activeTaskPollsRef.current.has(taskId)) return;
      activeTaskPollsRef.current.add(taskId);
      let consecutiveErrors = 0;
      const startTime = Date.now();
      let pollIntervalMs = initialPollIntervalMs;
      let timeoutMs = initialTimeoutMs;
      let taskDeadlineAt = getTaskDeadlineAt(null, startTime, timeoutMs);
      try {
        let task;
        try {
          task = await syncTaskToNode(nodeId, taskId);
          pollIntervalMs = Number(task.pollIntervalMs || pollIntervalMs);
          timeoutMs = Number(task.timeoutMs || timeoutMs);
          taskDeadlineAt = getTaskDeadlineAt(task, startTime, timeoutMs);
        } catch (err) {
          consecutiveErrors++;
          task = null;
        }
        while (!task || ["pending", "running"].includes(task.status)) {
          if (Date.now() >= taskDeadlineAt) {
            setNotice(`任务超时（${Math.round(timeoutMs / 1000)}秒），已停止轮询`);
            patchNode(nodeId, { runtime: { status: "failed", progress: 0, taskId, error: `任务等待超过模型配置 ${Math.round(timeoutMs / 1000)} 秒，请稍后从任务记录同步或重试` } });
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, pollIntervalMs));
          try {
            task = await syncTaskToNode(nodeId, taskId);
            pollIntervalMs = Number(task.pollIntervalMs || pollIntervalMs);
            timeoutMs = Number(task.timeoutMs || timeoutMs);
            taskDeadlineAt = getTaskDeadlineAt(task, startTime, timeoutMs);
            consecutiveErrors = 0;
          } catch (error) {
            consecutiveErrors++;
            if (consecutiveErrors >= 10) {
              setNotice(`任务状态同步失败，已停止轮询：${error instanceof Error ? error.message : String(error)}`);
              patchNode(nodeId, {
                runtime: {
                  status: "failed",
                  progress: 0,
                  taskId,
                  error: `任务状态同步失败：${error instanceof Error ? error.message : String(error)}`,
                },
              });
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
        prependAsset(created.asset);
      }
    },
    [patchNode, prependAsset, project, workflowNodes],
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
    prependAsset(created.asset);
    setAssetLibraryOpen(true);
    setNotice("节点结果已保存到素材库");
  }, [currentUser, prependAsset, project, workflowNodes]);

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
    patchLoadedAsset(updated);
    if (previewAsset?.id === updated.id) setPreviewAsset(updated);
  }, [patchLoadedAsset, previewAsset]);

  const removeAsset = useCallback(async (asset: AssetRecord) => {
    if (!window.confirm("确定删除这个素材吗？")) return;
    await deleteAsset(asset.id);
    removeLoadedAsset(asset);
    if (previewAsset?.id === asset.id) setPreviewAsset(null);
  }, [previewAsset, removeLoadedAsset]);

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
        patchNode(nodeId, { runtime: { status: response.task.status, progress: response.task.progress || 0, taskId: response.task.id, inputSignature, cacheHit: false } });
        setNotice("任务已创建，正在后台生成…");
        const settledTask = await pollTaskUntilSettled(
          nodeId,
          response.task.id,
          response.task.pollIntervalMs || 2000,
          response.task.timeoutMs || 120000,
        );
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
    const loadedSnapshotHasContent = Boolean(loadedCanvas.snapshot?.nodes?.length);
    const snapshot = loadedSnapshotHasContent
      ? migrateSnapshot(loadedCanvas.snapshot)
      : useLocalFallback
        ? readLocalSnapshot()
        : migrateSnapshot(loadedCanvas.snapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
    const snapshotJson = JSON.stringify(snapshot);
    lastLocalSnapshotJsonRef.current = snapshotJson;
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, snapshotJson);
    lastSavedSnapshotJsonRef.current = loadedSnapshotHasContent || !useLocalFallback ? snapshotJson : null;
    pendingSaveRef.current = null;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = 0;
    setSaveStatus(lastSavedSnapshotJsonRef.current === snapshotJson ? "saved" : "idle");
    const yCanvas = yCanvasRef.current;
    if (yCanvas) applySnapshotToYDoc(yCanvas, snapshot, Y_CANVAS_LOAD_ORIGIN);
    applySnapshotFromYCanvas(snapshot, { resetSelection: true });
  }, [applySnapshotFromYCanvas]);

  const loadBackendState = useCallback(async (isRetry = false) => {
    if (backendLoadInFlightRef.current) return;
    backendLoadInFlightRef.current = true;
    try {
      const [userResult, modelResult] = await Promise.all([listUsers(), listModels()]);
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
      const projectSummary = loadedProjects.find((item) => item.id === loadedProject.id);
      const nextProject = projectSummary ? { ...loadedProject, ...projectSummary } : loadedProject;
      setProjects(loadedProjects);
      setProject(nextProject);
      activeProjectIdRef.current = nextProject.id;
      localStorage.setItem("anime-canvas-project-id", nextProject.id);
      setCanvases(loadedCanvases);
      const savedCanvasId = localStorage.getItem("anime-canvas-canvas-id");
      const selectedCanvas = loadedCanvases.find((item) => item.id === savedCanvasId) || loadedCanvases[0];
      await loadCanvasRecord(selectedCanvas.id, true);
      await loadProjectAssets(nextProject.id);
      backendLocalFallbackAppliedRef.current = false;
      window.clearTimeout(backendRetryTimerRef.current);
      backendRetryTimerRef.current = 0;
      setNotice(isRetry ? "后端已恢复连接并加载完成" : "画布已连接后端并加载完成");
    } catch {
      if (!backendLocalFallbackAppliedRef.current) {
        const snapshot = readLocalSnapshot();
        const yCanvas = yCanvasRef.current;
        if (yCanvas) applySnapshotToYDoc(yCanvas, snapshot, Y_CANVAS_LOAD_ORIGIN);
        applySnapshotFromYCanvas(snapshot, { resetSelection: true });
        backendLocalFallbackAppliedRef.current = true;
      }
      setNotice("后端不可用，已进入浏览器本地模式；将自动重试连接");
      window.clearTimeout(backendRetryTimerRef.current);
      backendRetryTimerRef.current = window.setTimeout(() => {
        loadBackendState(true).catch(() => {});
      }, 4000);
    } finally {
      backendLoadInFlightRef.current = false;
    }
  }, [applySnapshotFromYCanvas, loadCanvasRecord, loadProjectAssets]);

  useEffect(() => {
    loadBackendState().catch(() => {});
  }, [loadBackendState]);
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

  const deleteNodes = useCallback((nodeIds: string[]) => {
    const nodeIdSet = new Set(nodeIds.filter(Boolean));
    if (!nodeIdSet.size) return;
    const yCanvas = yCanvasRef.current;
    if (yCanvas) removeYCanvasNodes(yCanvas, [...nodeIdSet], Y_CANVAS_LOCAL_ORIGIN);
    setWorkflowNodes((current) => current.filter((node) => !nodeIdSet.has(node.id)));
    setRfEdges((current) => current.filter((edge) => !nodeIdSet.has(edge.source) && !nodeIdSet.has(edge.target)));
    setGroups((current) =>
      current
        .map((group) => {
          const nextNodeIds = group.nodeIds.filter((id) => !nodeIdSet.has(id));
          return nextNodeIds.length === group.nodeIds.length ? group : { ...group, nodeIds: nextNodeIds };
        })
        .filter((group) => group.nodeIds.length > 1),
    );
    setSelectionNodeIds((current) => {
      const next = current.filter((id) => !nodeIdSet.has(id));
      selectionNodeIdsRef.current = next;
      return next;
    });
    setSelectionBounds(null);
    if (expandedNodeId && nodeIdSet.has(expandedNodeId)) setExpandedNodeId(null);
    if (selectedNodeId && nodeIdSet.has(selectedNodeId)) setSelectedNodeId(null);
    setTraceConnection((current) => current && nodeIdSet.has(current.nodeId) ? null : current);
  }, [expandedNodeId, selectedNodeId]);

  const deleteNode = useCallback((nodeId: string) => {
    deleteNodes([nodeId]);
  }, [deleteNodes]);

  const deleteEdge = useCallback((edgeId: string) => {
    const yCanvas = yCanvasRef.current;
    if (yCanvas) removeYCanvasEdge(yCanvas, edgeId, Y_CANVAS_LOCAL_ORIGIN);
    setRfEdges((current) => current.filter((edge) => edge.id !== edgeId));
    if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
  }, [selectedEdgeId]);

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
    const baselineJson = dragHistoryBaselineJsonRef.current;
    dragHistoryBaselineRef.current = null;
    dragHistoryBaselineJsonRef.current = null;
    const nextSnapshotJson = JSON.stringify(nextSnapshot);
    if (!baseline || baselineJson === nextSnapshotJson) {
      currentSnapshotRef.current = nextSnapshot;
      currentSnapshotJsonRef.current = nextSnapshotJson;
      return;
    }
    historyRef.current.past = [...historyRef.current.past.slice(-39), baseline];
    historyRef.current.future = [];
    currentSnapshotRef.current = nextSnapshot;
    currentSnapshotJsonRef.current = nextSnapshotJson;
    historyRef.current.restoring = true;
  }, []);

  useEffect(() => {
    const { snapshot, snapshotJson } = getSnapshotBundle();
    if (historyRef.current.restoring) {
      historyRef.current.restoring = false;
      currentSnapshotRef.current = snapshot;
      currentSnapshotJsonRef.current = snapshotJson;
      return;
    }
    if (isDraggingNodeRef.current || groupDragRef.current) {
      currentSnapshotRef.current = snapshot;
      currentSnapshotJsonRef.current = snapshotJson;
      return;
    }
    const previous = currentSnapshotRef.current;
    const previousJson = currentSnapshotJsonRef.current;
    if (previous && previousJson && previousJson !== snapshotJson) {
      historyRef.current.past = [...historyRef.current.past.slice(-39), previous];
      historyRef.current.future = [];
    }
    currentSnapshotRef.current = snapshot;
    currentSnapshotJsonRef.current = snapshotJson;
  }, [getSnapshotBundle]);

  useEffect(() => {
    if (applyingYCanvasSnapshotRef.current || skipNextYDocSyncRef.current) {
      skipNextYDocSyncRef.current = false;
      return;
    }
    const yCanvas = yCanvasRef.current;
    if (!yCanvas) return;
    const { snapshot } = getSnapshotBundle();
    syncingReactStateToYDocRef.current = true;
    try {
      applySnapshotToYDoc(yCanvas, snapshot, Y_CANVAS_LOCAL_ORIGIN);
    } finally {
      syncingReactStateToYDocRef.current = false;
    }
  }, [getSnapshotBundle]);

  useEffect(() => {
    const bundle = getSnapshotBundle();
    if (lastLocalSnapshotJsonRef.current !== bundle.snapshotJson) {
      localStorage.setItem(LOCAL_SNAPSHOT_KEY, bundle.snapshotJson);
      lastLocalSnapshotJsonRef.current = bundle.snapshotJson;
    }
    if (applyingRemoteSnapshotRef.current) {
      window.clearTimeout(collaborationBroadcastTimerRef.current);
      pendingBroadcastSnapshotJsonRef.current = null;
      cancelPendingSave(bundle.snapshotJson);
      return;
    }
    snapshotVersionRef.current = Date.now();
    const version = snapshotVersionRef.current;
    if (isDraggingNodeRef.current || lastBroadcastSnapshotJsonRef.current === bundle.snapshotJson) {
      window.clearTimeout(collaborationBroadcastTimerRef.current);
      pendingBroadcastSnapshotJsonRef.current = null;
    } else if (pendingBroadcastSnapshotJsonRef.current !== bundle.snapshotJson) {
      window.clearTimeout(collaborationBroadcastTimerRef.current);
      pendingBroadcastSnapshotJsonRef.current = bundle.snapshotJson;
      collaborationBroadcastTimerRef.current = window.setTimeout(() => {
        if (lastBroadcastSnapshotJsonRef.current === bundle.snapshotJson) return;
        collaborationClientRef.current?.sendSnapshot(bundle.snapshot, version);
        lastBroadcastSnapshotJsonRef.current = bundle.snapshotJson;
        if (pendingBroadcastSnapshotJsonRef.current === bundle.snapshotJson) {
          pendingBroadcastSnapshotJsonRef.current = null;
        }
      }, 180);
    }
    if (!canvas || !workflowNodes.length) {
      cancelPendingSave(bundle.snapshotJson);
      return;
    }
    if (lastSavedSnapshotJsonRef.current === bundle.snapshotJson) return;
    if (pendingSaveRef.current?.canvasId === canvas.id && pendingSaveRef.current.snapshotJson === bundle.snapshotJson) return;
    pendingSaveRef.current = {
      canvasId: canvas.id,
      bodyJson: getSnapshotSaveBodyJson(bundle),
      snapshotJson: bundle.snapshotJson,
    };
    window.clearTimeout(saveTimerRef.current);
    setSaveStatus("saving");
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = 0;
      const pending = pendingSaveRef.current;
      if (!pending) return;
      saveSnapshotJson(pending.canvasId, pending.bodyJson)
        .then(() => {
          if (pendingSaveRef.current?.canvasId !== pending.canvasId || pendingSaveRef.current.snapshotJson !== pending.snapshotJson) return;
          lastSavedSnapshotJsonRef.current = pending.snapshotJson;
          pendingSaveRef.current = null;
          setSaveStatus("saved");
        })
        .catch(() => {
          if (pendingSaveRef.current?.canvasId !== pending.canvasId || pendingSaveRef.current.snapshotJson !== pending.snapshotJson) return;
          pendingSaveRef.current = null;
          setSaveStatus("failed");
          setNotice("自动保存到后端失败，本地快照仍已保存");
        });
    }, 600);
  }, [cancelPendingSave, canvas, getSnapshotBundle, getSnapshotSaveBodyJson, workflowNodes.length]);

  const selectedNode = selectedNodeId ? workflowNodeById.get(selectedNodeId) || null : null;

  const addWorkflowNode = (type: string, position = { x: 180 + workflowNodes.length * 32, y: 120 + workflowNodes.length * 24 }) => {
    const next = makeWorkflowNode(type, position);
    const yCanvas = yCanvasRef.current;
    if (yCanvas) upsertYCanvasNode(yCanvas, next, Y_CANVAS_LOCAL_ORIGIN);
    setWorkflowNodes((current) => [...current, next]);
    setSelectedNodeId(next.id);
    setExpandedNodeId(next.id);
  };

  const commitWorkflowConnection = useCallback((connection: Connection, nodesForValidation = workflowNodes, edgesForValidation = workflowEdges) => {
    const normalizedConnection = {
      ...connection,
      sourceHandle: normalizePortId(String(connection.sourceHandle || "")),
      targetHandle: normalizePortId(String(connection.targetHandle || "")),
    };
    const validation = validateConnection(nodesForValidation, edgesForValidation, normalizedConnection);
    if (!validation.valid) {
      setNotice(validation.message || "连接不合法");
      return null;
    }

    const edgeId = createId("edge");
    const workflowEdge: WorkflowEdge = {
      id: edgeId,
      sourceNodeId: String(normalizedConnection.source || ""),
      sourcePortId: String(normalizedConnection.sourceHandle || ""),
      targetNodeId: String(normalizedConnection.target || ""),
      targetPortId: String(normalizedConnection.targetHandle || ""),
    };
    const yCanvas = yCanvasRef.current;
    if (yCanvas) upsertYCanvasEdge(yCanvas, workflowEdge, Y_CANVAS_LOCAL_ORIGIN);

    setRfEdges((current) =>
      addEdge(
        {
          ...connection,
          id: edgeId,
          sourceHandle: normalizedConnection.sourceHandle,
          targetHandle: normalizedConnection.targetHandle,
          animated: true,
        },
        current,
      ),
    );
    return workflowEdge;
  }, [setRfEdges, workflowEdges, workflowNodes]);

  const cancelConnectionReleaseFallback = useCallback(() => {
    window.clearTimeout(connectionReleaseFallbackTimerRef.current);
    connectionReleaseFallbackTimerRef.current = 0;
    connectionReleaseAbortRef.current?.abort();
    connectionReleaseAbortRef.current = null;
  }, []);

  const openConnectionPickerFromPoint = useCallback((dragStart: ConnectionDragStart, point: { x: number; y: number }) => {
    const canvasRect = containerRef.current?.getBoundingClientRect();
    const isInsideCanvas = Boolean(
      canvasRect
        && point.x >= canvasRect.left
        && point.x <= canvasRect.right
        && point.y >= canvasRect.top
        && point.y <= canvasRect.bottom,
    );
    if (!isInsideCanvas) return false;

    const candidates = getConnectionPickerCandidates(workflowNodesRef.current, workflowEdgesRef.current, dragStart);
    const flow = screenToFlowPosition(point);
    const pickerWidth = 292;
    const pickerHeight = Math.min(360, 72 + Math.max(1, candidates.length) * 54);
    const x = Math.min(Math.max(point.x + 10, 12), window.innerWidth - pickerWidth - 12);
    const y = Math.min(Math.max(point.y + 10, 68), window.innerHeight - pickerHeight - 44);
    suppressNextPaneClickUntilRef.current = Date.now() + 300;
    setContextMenu(null);
    setConnectionPicker({ x, y, flowX: flow.x, flowY: flow.y, dragStart, candidates });
    if (candidates.length === 0) setNotice("当前端口没有可补充的兼容节点");
    return true;
  }, [screenToFlowPosition]);

  const finishConnectionRelease = useCallback((dragStart: ConnectionDragStart, point: { x: number; y: number }) => {
    if (connectionReleaseHandledRef.current || connectionSucceededRef.current) return false;
    connectionReleaseHandledRef.current = true;
    connectionDragStartRef.current = null;
    cancelConnectionReleaseFallback();
    return openConnectionPickerFromPoint(dragStart, point);
  }, [cancelConnectionReleaseFallback, openConnectionPickerFromPoint]);

  const onConnect = (connection: Connection) => {
    connectionSucceededRef.current = true;
    connectionReleaseHandledRef.current = true;
    connectionDragStartRef.current = null;
    cancelConnectionReleaseFallback();
    setConnectionPicker(null);
    const committedEdge = commitWorkflowConnection(connection);
    if (!committedEdge) return;
    const targetNode = workflowNodeById.get(String(connection.target || ""));
    const sourceNode = workflowNodeById.get(String(connection.source || ""));
    const targetPatch = applyConnectionDefaults(sourceNode, targetNode);
    if (targetPatch && targetNode) patchNode(targetNode.id, targetPatch);
    setNotice("连接成功");
  };

  const onConnectStart = (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    connectionSucceededRef.current = false;
    connectionReleaseHandledRef.current = false;
    cancelConnectionReleaseFallback();
    setConnectionPicker(null);
    if (!params.nodeId || !params.handleId || (params.handleType !== "source" && params.handleType !== "target")) {
      connectionDragStartRef.current = null;
      return;
    }
    const dragStart: ConnectionDragStart = {
      nodeId: params.nodeId,
      handleId: normalizePortId(params.handleId),
      handleType: params.handleType,
    };
    connectionDragStartRef.current = dragStart;
    const controller = new AbortController();
    connectionReleaseAbortRef.current = controller;
    const onWindowRelease = (releaseEvent: PointerEvent | MouseEvent | TouchEvent) => {
      const activeDragStart = connectionDragStartRef.current;
      if (!activeDragStart || connectionSucceededRef.current) return;
      const point = getPointerClientPoint(releaseEvent as MouseEvent | TouchEvent);
      connectionReleaseFallbackTimerRef.current = window.setTimeout(() => {
        finishConnectionRelease(activeDragStart, point);
      }, 0);
    };
    window.addEventListener("pointerup", onWindowRelease, { capture: true, once: true, signal: controller.signal });
    window.addEventListener("mouseup", onWindowRelease, { capture: true, once: true, signal: controller.signal });
    window.addEventListener("touchend", onWindowRelease, { capture: true, once: true, signal: controller.signal });
  };

  const onConnectEnd = (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
    const dragStart = connectionDragStartRef.current;
    if (!dragStart || connectionSucceededRef.current || connectionState.toHandle) {
      connectionDragStartRef.current = null;
      cancelConnectionReleaseFallback();
      return;
    }
    finishConnectionRelease(dragStart, getPointerClientPoint(event));
  };
  const addNodeFromConnectionPicker = useCallback((candidate: ConnectionPickerCandidate) => {
    const picker = connectionPicker;
    if (!picker) return;
    const offsetX = candidate.direction === "downstream" ? 90 : -376;
    const nextNode = makeWorkflowNode(candidate.nodeType, {
      x: picker.flowX + offsetX,
      y: picker.flowY - 124,
    });
    const sourceNodeId = candidate.sourceNodeId === CONNECTION_PICKER_TEMP_NODE_ID ? nextNode.id : candidate.sourceNodeId;
    const targetNodeId = candidate.targetNodeId === CONNECTION_PICKER_TEMP_NODE_ID ? nextNode.id : candidate.targetNodeId;
    const connection: Connection = {
      source: sourceNodeId,
      sourceHandle: candidate.sourcePortId,
      target: targetNodeId,
      targetHandle: candidate.targetPortId,
    };
    const nodesForValidation = [...workflowNodesRef.current, nextNode];
    const edgesForValidation = workflowEdgesRef.current;
    const validation = validateConnection(nodesForValidation, edgesForValidation, connection);
    if (!validation.valid) {
      setNotice(validation.message || "连接不合法");
      setConnectionPicker(null);
      return;
    }

    const sourceNode = nodesForValidation.find((node) => node.id === sourceNodeId);
    const targetNode = nodesForValidation.find((node) => node.id === targetNodeId);
    const targetPatch = applyConnectionDefaults(sourceNode, targetNode);
    const committedNode = targetPatch && targetNode?.id === nextNode.id
      ? mergeWorkflowNodePatch(nextNode, targetPatch)
      : nextNode;
    const yCanvas = yCanvasRef.current;
    if (yCanvas) upsertYCanvasNode(yCanvas, committedNode, Y_CANVAS_LOCAL_ORIGIN);
    setWorkflowNodes((current) => [...current, committedNode]);
    if (targetPatch && targetNode && targetNode.id !== nextNode.id) patchNode(targetNode.id, targetPatch);

    const committedEdge = commitWorkflowConnection(connection, [...workflowNodesRef.current, committedNode], edgesForValidation);
    setConnectionPicker(null);
    if (!committedEdge) return;
    setSelectedNodeId(committedNode.id);
    setExpandedNodeId(committedNode.id);
    setSelectedEdgeId(null);
    setTraceConnection(null);
    setNotice(`已创建「${candidate.name}」并完成连接`);
  }, [commitWorkflowConnection, connectionPicker, patchNode]);

  const deleteSelected = useCallback(() => {
    if (selectedEdgeId) {
      deleteEdge(selectedEdgeId);
    } else if (selectionNodeIds.length > 0) {
      deleteNodes(selectionNodeIds);
    } else if (selectedNodeId) {
      deleteNodes([selectedNodeId]);
    }
  }, [selectedEdgeId, selectionNodeIds, selectedNodeId, deleteEdge, deleteNodes]);

  const duplicateNode = useCallback((nodeId: string) => {
    const source = workflowNodeById.get(nodeId);
    if (!source) return;
    const timestamp = new Date().toISOString();
    const data = { ...source.data };
    if (source.type.endsWith(".generate")) {
      delete data.resultUrl;
      delete data.url;
    }
    const duplicated: WorkflowNode = {
      ...source,
      id: createId("node"),
      position: { x: source.position.x + 36, y: source.position.y + 36 },
      data,
      runtime: { status: "idle", progress: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const duplicatedEdges = workflowEdges
      .filter((edge) => edge.targetNodeId === source.id)
      .map((edge) => ({
        ...edge,
        id: createId("edge"),
        targetNodeId: duplicated.id,
      }));
    const yCanvas = yCanvasRef.current;
    if (yCanvas) {
      upsertYCanvasNode(yCanvas, duplicated, Y_CANVAS_LOCAL_ORIGIN);
      if (duplicatedEdges.length > 0) upsertYCanvasEdges(yCanvas, duplicatedEdges, Y_CANVAS_LOCAL_ORIGIN);
    }
    setWorkflowNodes((current) => [...current, duplicated]);
    if (duplicatedEdges.length > 0) {
      setRfEdges((current) => [...current, ...toReactFlowEdges(duplicatedEdges)]);
    }
    setSelectedNodeId(duplicated.id);
    setExpandedNodeId(duplicated.id);
    setTraceConnection(null);
    setNotice(source.type.endsWith(".generate") ? "已派生生成节点，并保留上游连接" : "节点已复制");
  }, [setRfEdges, workflowEdges, workflowNodeById]);

  const duplicateSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    duplicateNode(selectedNodeId);
  }, [duplicateNode, selectedNodeId]);

  const collapseNode = useCallback((nodeId: string) => {
    if (expandedNodeIdRef.current === nodeId) setExpandedNodeId(null);
    setTraceConnection((current) => current?.nodeId === nodeId ? null : current);
  }, []);

  const inspectNodeInputs = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setExpandedNodeId(nodeId);
    setTraceConnection((current) =>
      current?.nodeId === nodeId && current.mode === "inputs" ? null : { nodeId, mode: "inputs" },
    );
    const incomingCount = workflowEdgesRef.current.filter((edge) => edge.targetNodeId === nodeId).length;
    setNotice(incomingCount > 0 ? `已高亮 ${incomingCount} 条上游连接` : "当前节点没有上游连接");
  }, []);

  const inspectNodeOutputs = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setExpandedNodeId(nodeId);
    setTraceConnection((current) =>
      current?.nodeId === nodeId && current.mode === "outputs" ? null : { nodeId, mode: "outputs" },
    );
    const outgoingCount = workflowEdgesRef.current.filter((edge) => edge.sourceNodeId === nodeId).length;
    setNotice(outgoingCount > 0 ? `已高亮 ${outgoingCount} 条下游连接` : "当前节点没有下游连接");
  }, []);

  useEffect(() => {
    if (isDraggingNodeRef.current) return;
    setRfNodes(toReactFlowNodes(
      workflowNodes,
      workflowEdges,
      patchNodeFromUi,
      runNode,
      deleteNode,
      duplicateNode,
      collapseNode,
      inspectNodeInputs,
      inspectNodeOutputs,
      assets,
      models,
      uploadNodeAsset,
      handleAddAssetAsNode,
      saveNodeResultAsAsset,
      copyNodeResultUrl,
      previewNodeResult,
      expandedNodeId,
      traceConnection?.nodeId || null,
      traceConnection?.mode || null,
    ));
  }, [workflowNodes, workflowEdges, patchNodeFromUi, runNode, deleteNode, duplicateNode, collapseNode, inspectNodeInputs, inspectNodeOutputs, assets, models, uploadNodeAsset, handleAddAssetAsNode, saveNodeResultAsAsset, copyNodeResultUrl, previewNodeResult, expandedNodeId, traceConnection, setRfNodes]);

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
    const bundle = getSnapshotBundle();
    if (lastLocalSnapshotJsonRef.current !== bundle.snapshotJson) {
      localStorage.setItem(LOCAL_SNAPSHOT_KEY, bundle.snapshotJson);
      lastLocalSnapshotJsonRef.current = bundle.snapshotJson;
    }
    if (!canvas) {
      setNotice("已保存到浏览器本地");
      setSaveStatus("saved");
      return;
    }
    const bodyJson = getSnapshotSaveBodyJson(bundle);
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = 0;
    pendingSaveRef.current = { canvasId: canvas.id, bodyJson, snapshotJson: bundle.snapshotJson };
    setSaveStatus("saving");
    await saveSnapshotJson(canvas.id, bodyJson);
    const savedSnapshotStillCurrent = pendingSaveRef.current?.canvasId === canvas.id && pendingSaveRef.current.snapshotJson === bundle.snapshotJson;
    lastSavedSnapshotJsonRef.current = bundle.snapshotJson;
    if (!savedSnapshotStillCurrent) return;
    pendingSaveRef.current = null;
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
    const nextProject = projectSummary ? { ...loaded.project, ...projectSummary } : loaded.project;
    setProject(nextProject);
    activeProjectIdRef.current = nextProject.id;
    setCanvases(loaded.canvases);
    const selectedCanvas = loaded.canvases.find((item) => item.id === preferredCanvasId) || loaded.canvases[0];
    if (selectedCanvas) await loadCanvasRecord(selectedCanvas.id);
    await loadProjectAssets(loaded.project.id);
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
      await saveSnapshot(canvas.id, restoredSnapshot, { backupOperation: "history-restore" });
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
        setConnectionPicker(null);
        setNodeLibraryOpen(false);
        setAssetLibraryOpen(false);
        setPreviewAsset(null);
        setPreviewResult(null);
        setSelectedNodeId(null);
        setExpandedNodeId(null);
        setSelectedEdgeId(null);
        setTraceConnection(null);
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
      setDraggingTemplate((current) => {
        if (!current) return current;
        const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 6;
        return { ...current, x: event.clientX, y: event.clientY, moved };
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!draggingTemplate.moved) {
        setDraggingTemplate(null);
        return;
      }
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
    const selectedNodes = getWorkflowNodesByIds(nodeIds);
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
  }, [getWorkflowNodesByIds, groups, selectionBounds]);

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
      const baselineBundle = getSnapshotBundle();
      dragHistoryBaselineRef.current = baselineBundle.snapshot;
      dragHistoryBaselineJsonRef.current = baselineBundle.snapshotJson;
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
  }, [commitDragHistory, getSnapshotBundle]);

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
                    startX: event.clientX,
                    startY: event.clientY,
                    x: event.clientX,
                    y: event.clientY,
                    moved: false,
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
              <span>{visibleAssetCountText} 个素材</span>
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
            {assetLibraryLoading && <div className="asset-empty">正在加载素材…</div>}
            {!assetLibraryLoading && filteredAssets.length === 0 && <div className="asset-empty">暂无素材，生成或上传后会出现在这里</div>}
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

      {connectionPicker && (
        <div className="connection-node-picker nodrag" style={{ left: connectionPicker.x, top: connectionPicker.y }}>
          <div className="connection-node-picker-head">
            <span>{connectionPicker.dragStart.handleType === "source" ? "选择下游节点" : "选择上游节点"}</span>
            <button type="button" title="关闭" onClick={() => setConnectionPicker(null)}>×</button>
          </div>
          <div className="connection-node-picker-list">
            {connectionPicker.candidates.length > 0 ? connectionPicker.candidates.map((candidate) => (
              <button
                key={`${candidate.direction}:${candidate.nodeType}:${candidate.sourcePortId}:${candidate.targetPortId}`}
                type="button"
                onClick={() => addNodeFromConnectionPicker(candidate)}
              >
                <span className="connection-node-picker-icon">{getNodeIcon(candidate.nodeType)}</span>
                <span>
                  <strong>{candidate.name}</strong>
                  <em>{formatConnectionCandidateMeta(candidate)}</em>
                </span>
              </button>
            )) : (
              <div className="connection-node-picker-empty">没有兼容节点</div>
            )}
          </div>
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
          setConnectionPicker(null);
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
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onNodeDragStart={() => {
            const baselineBundle = getSnapshotBundle();
            dragHistoryBaselineRef.current = baselineBundle.snapshot;
            dragHistoryBaselineJsonRef.current = baselineBundle.snapshotJson;
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
              const selectionNodeIdSet = new Set(selectionNodeIds);
              const selectedNodes = next.filter((item) => selectionNodeIdSet.has(item.id));
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
            setTraceConnection(null);
          }}
          onPaneClick={() => {
            setContextMenu(null);
            if (Date.now() < suppressNextPaneClickUntilRef.current) return;
            setConnectionPicker(null);
            setSelectedNodeId(null);
            setExpandedNodeId(null);
            setSelectedEdgeId(null);
            setTraceConnection(null);
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
          onlyRenderVisibleElements
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
          <span>节点 {workflowNodes.length} · 连线 {workflowEdges.length} · 素材 {visibleAssetCountText}</span>
        </span>
      </footer>
    </div>
  );
}
