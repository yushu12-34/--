import type { AssetRecord } from "../../types";

export interface ProjectAssetState {
  projectId: string | null;
  assets: AssetRecord[];
  loading: boolean;
}

export function shouldCommitAssetLoad({
  requestId,
  latestRequestId,
  requestedProjectId,
  activeProjectId,
}: {
  requestId: number;
  latestRequestId: number;
  requestedProjectId: string;
  activeProjectId: string | null;
}) {
  return requestId === latestRequestId && requestedProjectId === activeProjectId;
}

export function getVisibleAssets(activeProjectId: string | null | undefined, assetState: ProjectAssetState) {
  return activeProjectId && assetState.projectId === activeProjectId ? assetState.assets : [];
}

export function getVisibleAssetCount(
  activeProjectId: string | null | undefined,
  assetState: ProjectAssetState,
  fallbackCount = 0,
) {
  if (activeProjectId && assetState.projectId === activeProjectId && assetState.loading && assetState.assets.length === 0) {
    return fallbackCount;
  }
  return activeProjectId && assetState.projectId === activeProjectId
    ? assetState.assets.length
    : fallbackCount;
}
