import assert from "node:assert/strict";
import test from "node:test";
import {
  getVisibleAssetCount,
  getVisibleAssets,
  shouldCommitAssetLoad,
} from "../apps/web/src/pages/canvas/assetRuntime.ts";

test("asset load commit guard rejects stale project responses", () => {
  assert.equal(shouldCommitAssetLoad({
    requestId: 1,
    latestRequestId: 2,
    requestedProjectId: "project:old",
    activeProjectId: "project:new",
  }), false);
  assert.equal(shouldCommitAssetLoad({
    requestId: 2,
    latestRequestId: 2,
    requestedProjectId: "project:new",
    activeProjectId: "project:new",
  }), true);
});

test("visible assets stay bound to the active project and use summary fallback count", () => {
  const state = {
    projectId: "project:old",
    assets: [
      {
        id: "asset:old",
        projectId: "project:old",
        type: "image",
        url: "https://example.test/old.png",
        mimeType: "image/png",
        size: 12,
        source: "upload",
        createdBy: "user:1",
        createdAt: "2026-06-12T00:00:00.000Z",
      },
    ],
    loading: false,
  };

  assert.deepEqual(getVisibleAssets("project:new", state), []);
  assert.equal(getVisibleAssetCount("project:new", state, 7), 7);
  assert.equal(getVisibleAssetCount("project:old", state, 7), 1);
  assert.equal(getVisibleAssetCount("project:old", { ...state, assets: [], loading: true }, 7), 7);
});
