import type { NodeDefinition } from "./types";

export const nodeDefinitions: NodeDefinition[] = [
  {
    type: "text.input",
    name: "文本节点",
    category: "input",
    description: "输入动漫提示词文本，输出文本数据。",
    inputs: [],
    outputs: [{ id: "out", name: "输出", direction: "output", mediaType: "text" }],
    defaultData: { prompt: "一位银发少女站在霓虹雨夜街头，动漫风，高细节" },
    configurable: true,
  },
  {
    type: "image.input",
    name: "图片节点",
    category: "input",
    description: "上传或选择图片素材，输出图片数据。",
    inputs: [],
    outputs: [{ id: "out", name: "输出", direction: "output", mediaType: "image" }],
    defaultData: { url: "", name: "" },
    configurable: true,
  },
  {
    type: "audio.input",
    name: "音频节点",
    category: "input",
    description: "上传或选择音频素材，输出音频数据。",
    inputs: [],
    outputs: [{ id: "out", name: "输出", direction: "output", mediaType: "audio" }],
    defaultData: { url: "", name: "" },
    configurable: true,
  },
  {
    type: "video.input",
    name: "视频节点",
    category: "input",
    description: "上传或选择视频素材，输出视频数据。",
    inputs: [],
    outputs: [{ id: "out", name: "输出", direction: "output", mediaType: "video" }],
    defaultData: { url: "", name: "" },
    configurable: true,
  },
  {
    type: "image.generate",
    name: "图片生成",
    category: "generate",
    description: "接受文本和图片输入，生成图片并输出。",
    inputs: [
      { id: "in", name: "输入", direction: "input", mediaType: "text", accepts: ["text", "image"], required: true, multiple: true },
    ],
    outputs: [{ id: "out", name: "输出", direction: "output", mediaType: "image" }],
    defaultData: {
      modelId: "z-image-turbo",
      resultUrl: "",
      refImages: [] as Array<{ url: string; name: string }>,
      prompt: "",
      params: {
        size: "1k",
        aspect_ratio: "1:1",
        n: 1,
        response_format: "url",
        num_inference_steps: 9,
      },
    },
    configurable: true,
  },
  {
    type: "audio.generate",
    name: "音频生成",
    category: "generate",
    description: "接受文本输入，生成音频并输出。",
    inputs: [
      { id: "in", name: "输入", direction: "input", mediaType: "text", accepts: ["text"], required: true, multiple: true },
    ],
    outputs: [{ id: "out", name: "输出", direction: "output", mediaType: "audio" }],
    defaultData: { voice: "default_female", resultUrl: "" },
    configurable: true,
  },
  {
    type: "video.generate",
    name: "视频生成",
    category: "generate",
    description: "接受多模态输入，生成视频并输出。",
    inputs: [
      { id: "in", name: "输入", direction: "input", mediaType: "text", accepts: ["text", "image", "video", "audio"], required: true, multiple: true },
    ],
    outputs: [{ id: "out", name: "输出", direction: "output", mediaType: "video" }],
    defaultData: { duration: 5, fps: 24, resultUrl: "" },
    configurable: true,
  },
];

export function getNodeDefinition(type: string) {
  return nodeDefinitions.find((definition) => definition.type === type);
}
