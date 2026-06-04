function joinUrl(baseUrl, requestPath) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(requestPath).replace(/^\/+/, "")}`;
}

function getByPath(source, pathExpression) {
  if (!pathExpression) return undefined;
  return String(pathExpression)
    .split(".")
    .reduce((value, key) => {
      if (value == null) return undefined;
      if (/^\d+$/.test(key)) return value[Number(key)];
      return value[key];
    }, source);
}

function withAuthHeaders(provider) {
  const headers = { "content-type": "application/json" };
  if (!provider.secretValue) return headers;
  if (provider.authType === "api-key") headers["x-api-key"] = provider.secretValue;
  if (provider.authType === "bearer") headers.authorization = `Bearer ${provider.secretValue}`;
  return headers;
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = payload.detail || payload.error || `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function buildImagePayload(model, input) {
  return {
    ...(model.defaultParams || {}),
    ...(input.params || {}),
    prompt: input.prompt,
  };
}

function normalizeImageUrl(baseUrl, url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || /^data:/i.test(url)) return url;
  return joinUrl(baseUrl, url);
}

export function createMockImageResult(input) {
  const prompt = String(input.prompt || "anime scene").slice(0, 120);
  const escaped = prompt
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ff8bd1"/>
          <stop offset="48%" stop-color="#7c5cff"/>
          <stop offset="100%" stop-color="#36d1dc"/>
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="72" fill="url(#bg)"/>
      <circle cx="800" cy="190" r="108" fill="rgba(255,255,255,.25)"/>
      <circle cx="230" cy="780" r="150" fill="rgba(255,255,255,.18)"/>
      <text x="80" y="130" fill="#fff" font-family="Arial, sans-serif" font-size="44" font-weight="700">AI Anime Mock</text>
      <foreignObject x="80" y="210" width="864" height="560">
        <div xmlns="http://www.w3.org/1999/xhtml" style="font: 42px Arial, sans-serif; color: white; line-height: 1.35; text-shadow: 0 3px 18px rgba(0,0,0,.25);">
          ${escaped}
        </div>
      </foreignObject>
      <text x="80" y="930" fill="rgba(255,255,255,.86)" font-family="Arial, sans-serif" font-size="28">Replace mock adapter with ComfyUI / SD WebUI later</text>
    </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function generateImageWithModel(provider, model, input) {
  if (!provider.enabled) throw new Error("模型供应商已禁用");
  if (!model.enabled) throw new Error("模型已禁用");
  if (!input.prompt) throw new Error("缺少提示词输入");

  const adapter = model.adapter || {};
  if (adapter.kind !== "z-image-turbo" && adapter.kind !== "z-image") {
    throw new Error(`不支持的模型适配器：${adapter.kind || "unknown"}`);
  }

  const timeoutMs = Number(adapter.timeoutMs || provider.timeoutSeconds * 1000 || 120000);
  const submitResult = await fetchJson(
    joinUrl(provider.baseUrl, adapter.submitPath || "/v1/images/generations"),
    {
      method: "POST",
      headers: withAuthHeaders(provider),
      body: JSON.stringify(buildImagePayload(model, input)),
    },
    Number(provider.timeoutSeconds || 30) * 1000,
  );
  const providerTaskId = submitResult.task_id;
  if (!providerTaskId) throw new Error("模型接口未返回 task_id");

  const startedAt = Date.now();
  const pollIntervalMs = Number(adapter.pollIntervalMs || 2000);
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const taskPath = String(adapter.taskPathTemplate || "/v1/tasks/{task_id}").replace("{task_id}", providerTaskId);
    const taskResult = await fetchJson(joinUrl(provider.baseUrl, taskPath), {
      method: "GET",
      headers: withAuthHeaders(provider),
    }, Number(provider.timeoutSeconds || 30) * 1000);

    if (taskResult.status === "finished") {
      const b64 = getByPath(taskResult, adapter.b64Path || "data.0.b64_json");
      const rawUrl = getByPath(taskResult, adapter.resultPath || "data.0.url");
      const imageUrl = b64
        ? `data:image/png;base64,${b64}`
        : normalizeImageUrl(provider.baseUrl, rawUrl);
      if (!imageUrl) throw new Error("模型任务完成但未返回图片");
      return {
        providerTaskId,
        url: imageUrl,
        raw: taskResult,
      };
    }
    if (taskResult.status === "failed") {
      throw new Error(taskResult.error || "模型任务失败");
    }
  }

  throw new Error(`模型任务超时：${providerTaskId}`);
}
