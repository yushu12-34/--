import assert from "node:assert/strict";
import test from "node:test";
import { getConnectionPickerCandidates } from "../apps/web/src/pages/canvas/connectionPicker.ts";

function node(id, type) {
  return {
    id,
    type,
    title: type,
    position: { x: 0, y: 0 },
    data: {},
    runtime: { status: "idle", progress: 0 },
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
  };
}

function candidateTypes(candidates) {
  return candidates.map((candidate) => candidate.nodeType);
}

test("image output can create downstream image or video nodes but not audio nodes", () => {
  const nodes = [node("image1", "image.input")];
  const candidates = getConnectionPickerCandidates(nodes, [], {
    nodeId: "image1",
    handleId: "out",
    handleType: "source",
  });

  assert.deepEqual(candidateTypes(candidates), ["image.generate", "video.generate"]);
  assert.equal(candidates.every((candidate) => candidate.direction === "downstream"), true);
});

test("text output can create all generation nodes that accept prompts", () => {
  const nodes = [node("text1", "text.input")];
  const candidates = getConnectionPickerCandidates(nodes, [], {
    nodeId: "text1",
    handleId: "out",
    handleType: "source",
  });

  assert.deepEqual(candidateTypes(candidates), ["image.generate", "audio.generate", "video.generate"]);
});

test("dragging from a generation input suggests only compatible upstream outputs", () => {
  const nodes = [node("imageGen", "image.generate")];
  const candidates = getConnectionPickerCandidates(nodes, [], {
    nodeId: "imageGen",
    handleId: "in",
    handleType: "target",
  });

  assert.deepEqual(candidateTypes(candidates), ["text.input", "image.input"]);
  assert.equal(candidates.every((candidate) => candidate.direction === "upstream"), true);
});

test("dragging from a video input supports text image audio and video upstream nodes", () => {
  const nodes = [node("videoGen", "video.generate")];
  const candidates = getConnectionPickerCandidates(nodes, [], {
    nodeId: "videoGen",
    handleId: "in",
    handleType: "target",
  });

  assert.deepEqual(candidateTypes(candidates), ["text.input", "image.input", "audio.input", "video.input"]);
});

test("invalid or mismatched drag starts produce no candidates", () => {
  const nodes = [node("text1", "text.input")];

  assert.deepEqual(getConnectionPickerCandidates(nodes, [], {
    nodeId: "missing",
    handleId: "out",
    handleType: "source",
  }), []);
  assert.deepEqual(getConnectionPickerCandidates(nodes, [], {
    nodeId: "text1",
    handleId: "out",
    handleType: "target",
  }), []);
});
