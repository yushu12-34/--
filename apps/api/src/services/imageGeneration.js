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

function getTemplateValue(source, pathExpression) {
  if (pathExpression === "task_id") return source.task_id ?? source.taskId ?? source.providerTaskId;
  return getByPath(source, pathExpression);
}

function renderTemplateString(template, context) {
  const exactMatch = String(template).match(/^\{\{\s*([\w.-]+)\s*\}\}$|^\{([\w.-]+)\}$/);
  if (exactMatch) {
    const value = getTemplateValue(context, exactMatch[1] || exactMatch[2]);
    return value === undefined ? "" : value;
  }
  return String(template).replace(/\{\{\s*([\w.-]+)\s*\}\}|\{([\w.-]+)\}/g, (_match, doubleKey, singleKey) => {
    const value = getTemplateValue(context, doubleKey || singleKey);
    return value === undefined || value === null ? "" : String(value);
  });
}

export function renderAdapterTemplate(template, context) {
  if (typeof template === "string") return renderTemplateString(template, context);
  if (Array.isArray(template)) return template.map((item) => renderAdapterTemplate(item, context));
  if (template && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, renderAdapterTemplate(value, context)]),
    );
  }
  return template;
}

function withAuthHeaders(provider) {
  const headers = { "content-type": "application/json" };
  if (!provider.secretValue) return headers;
  if (provider.authType === "api-key") headers["x-api-key"] = provider.secretValue;
  if (provider.authType === "bearer") headers.authorization = `Bearer ${provider.secretValue}`;
  if (provider.authType === "basic") headers.authorization = `Basic ${Buffer.from(provider.secretValue).toString("base64")}`;
  return headers;
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`模型接口超时：${timeoutMs}ms`);
      throw new Error(`模型接口连接失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("模型接口返回非 JSON 响应");
    }
    if (!response.ok) {
      const message = payload.detail || payload.error || `${response.status} ${response.statusText}`;
      if (response.status === 401 || response.status === 403) {
        throw new Error(`模型接口鉴权失败：HTTP ${response.status} ${message}`);
      }
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

function normalizeHttpMethod(method, fallback = "POST") {
  const normalized = String(method || fallback).toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized) ? normalized : fallback;
}

function normalizeStatusValues(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => String(item).toLowerCase()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  }
  return fallback;
}

function parseTemplate(template) {
  if (typeof template !== "string") return template;
  const trimmed = template.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return template;
  try {
    return JSON.parse(trimmed);
  } catch {
    return template;
  }
}

function serializeBody(payload) {
  if (payload === undefined || payload === null) return undefined;
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function buildAdapterContext(model, input, extra = {}) {
  const params = {
    ...(model.defaultParams || {}),
    ...(input.params || {}),
  };
  return {
    input,
    model,
    params,
    prompt: input.prompt,
    images: Array.isArray(input.images) ? input.images : [],
    ...extra,
  };
}

function buildCustomRequestPayload(adapter, model, input, extraContext = {}) {
  const template = adapter.requestTemplate ?? adapter.bodyTemplate ?? adapter.submitTemplate;
  if (template === undefined || template === "") return buildImagePayload(model, input);
  return renderAdapterTemplate(parseTemplate(template), buildAdapterContext(model, input, extraContext));
}

function buildCustomPollingPayload(adapter, model, input, extraContext = {}) {
  const template = adapter.pollingTemplate ?? adapter.pollBodyTemplate ?? adapter.pollTemplate;
  if (template === undefined || template === "") return undefined;
  return renderAdapterTemplate(parseTemplate(template), buildAdapterContext(model, input, extraContext));
}

function buildSdWebuiPayload(model, input) {
  const params = {
    sampler_name: "DPM++ 2M Karras",
    steps: 28,
    cfg_scale: 7,
    width: 1024,
    height: 1024,
    ...(model.defaultParams || {}),
    ...(input.params || {}),
    prompt: input.prompt,
  };
  const referenceImages = Array.isArray(input.images) ? input.images : [];
  const initImages = referenceImages
    .map((url) => String(url).replace(/^data:image\/\w+;base64,/, ""))
    .filter((url) => url && !/^https?:\/\//i.test(url));
  if (initImages.length) {
    params.init_images = initImages;
    params.denoising_strength = Number(params.denoising_strength || 0.55);
  }
  return params;
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

export async function generateImageWithModel(provider, model, input, onProgress) {
  if (!provider.enabled) throw new Error("模型供应商已禁用");
  if (!model.enabled) throw new Error("模型已禁用");
  if (!input.prompt) throw new Error("缺少提示词输入");

  const adapter = model.adapter || {};
  if (adapter.kind === "sd-webui") return generateWithSdWebui(provider, model, input, onProgress);
  if (adapter.kind === "custom-http") return generateWithCustomHttp(provider, model, input, onProgress);
  if (adapter.kind === "z-image-turbo" || adapter.kind === "z-image") return generateWithZImage(provider, model, input, onProgress);
  throw new Error(`不支持的模型适配器：${adapter.kind || "unknown"}`);
}

async function generateWithZImage(provider, model, input, onProgress) {
  const adapter = model.adapter || {};
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

    if (onProgress) {
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(90, 30 + Math.floor((elapsed / timeoutMs) * 60));
      await onProgress(progress);
    }

    if (taskResult.status === "finished") {
      const b64 = getByPath(taskResult, adapter.b64Path || "data.0.b64_json");
      const rawUrl = getByPath(taskResult, adapter.resultPath || "data.0.url");
      const imageUrl = b64
        ? `data:image/png;base64,${b64}`
        : normalizeImageUrl(provider.baseUrl, rawUrl);
      if (!imageUrl) throw new Error("模型任务完成但未返回图片");
      return { providerTaskId, url: imageUrl, raw: taskResult };
    }
    if (taskResult.status === "failed") throw new Error(taskResult.error || "模型任务失败");
  }

  throw new Error(`模型任务超时：${providerTaskId}`);
}

async function generateWithCustomHttp(provider, model, input, onProgress) {
  const adapter = model.adapter || {};
  const submitMethod = normalizeHttpMethod(adapter.submitMethod || adapter.method, "POST");
  const submitContext = buildAdapterContext(model, input);
  const submitPath = renderTemplateString(adapter.submitPath || adapter.path || "/", submitContext);
  const submitPayload = buildCustomRequestPayload(adapter, model, input);
  if (onProgress) await onProgress(25);
  const submitResult = await fetchJson(
    joinUrl(provider.baseUrl, submitPath),
    {
      method: submitMethod,
      headers: withAuthHeaders(provider),
      ...(submitMethod === "GET" ? {} : { body: serializeBody(submitPayload) }),
    },
    Number(provider.timeoutSeconds || 30) * 1000,
  );
  if (onProgress) await onProgress(35);

  const taskPathTemplate = adapter.taskPathTemplate || adapter.pollPathTemplate || adapter.pollingPathTemplate;
  if (!taskPathTemplate) return resolveCustomImageResult(provider, adapter, submitResult);

  const providerTaskId = getByPath(submitResult, adapter.taskIdPath || "task_id");
  if (!providerTaskId) throw new Error(`字段映射错误：提交响应未能通过 ${adapter.taskIdPath || "task_id"} 读取任务 ID`);

  const timeoutMs = Number(adapter.timeoutMs || provider.timeoutSeconds * 1000 || 120000);
  const pollIntervalMs = Number(adapter.pollIntervalMs || 2000);
  const pollMethod = normalizeHttpMethod(adapter.pollMethod, "GET");
  const statusPath = adapter.statusPath || "status";
  const successStatuses = normalizeStatusValues(
    adapter.successStatusValues || adapter.successStatus || adapter.successStatusValue,
    ["finished", "succeeded", "success", "completed", "done"],
  );
  const failureStatuses = normalizeStatusValues(
    adapter.failureStatusValues || adapter.failureStatus || adapter.failureStatusValue,
    ["failed", "failure", "error", "cancelled"],
  );
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const pollContext = buildAdapterContext(model, input, {
      providerTaskId,
      taskId: providerTaskId,
      task_id: providerTaskId,
      submitResult,
    });
    const taskPath = renderTemplateString(taskPathTemplate, pollContext);
    const pollPayload = buildCustomPollingPayload(adapter, model, input, pollContext);
    const taskResult = await fetchJson(joinUrl(provider.baseUrl, taskPath), {
      method: pollMethod,
      headers: withAuthHeaders(provider),
      ...(pollMethod === "GET" ? {} : { body: serializeBody(pollPayload) }),
    }, Number(provider.timeoutSeconds || 30) * 1000);

    if (onProgress) {
      const elapsed = Date.now() - startedAt;
      const progress = Math.min(90, 35 + Math.floor((elapsed / timeoutMs) * 55));
      await onProgress(progress);
    }

    const status = String(getByPath(taskResult, statusPath) || "").toLowerCase();
    if (successStatuses.includes(status)) return resolveCustomImageResult(provider, adapter, taskResult, providerTaskId);
    if (failureStatuses.includes(status)) throw new Error(`模型任务失败：${readMappedError(taskResult, adapter)}`);
  }

  throw new Error(`模型任务超时：${providerTaskId}`);
}

function readMappedError(result, adapter) {
  const mapped = getByPath(result, adapter.errorPath || "error") ?? getByPath(result, "message");
  if (!mapped) return "模型接口未返回错误摘要";
  if (typeof mapped === "string") return mapped;
  if (typeof mapped === "object" && mapped.message) return String(mapped.message);
  return JSON.stringify(mapped);
}

function resolveCustomImageResult(provider, adapter, result, providerTaskId) {
  const b64Path = adapter.b64Path || adapter.base64Path || "data.0.b64_json";
  const resultPath = adapter.resultPath || adapter.imageUrlPath || "data.0.url";
  const b64 = getByPath(result, b64Path);
  const rawUrl = getByPath(result, resultPath);
  const imageUrl = b64
    ? `data:image/png;base64,${b64}`
    : normalizeImageUrl(provider.baseUrl, rawUrl);
  if (!imageUrl) {
    throw new Error(`字段映射错误：未能通过 ${resultPath} 或 ${b64Path} 读取图片结果`);
  }
  return { providerTaskId, url: imageUrl, raw: result };
}

async function generateWithSdWebui(provider, model, input, onProgress) {
  const adapter = model.adapter || {};
  const payload = buildSdWebuiPayload(model, input);
  const hasInitImages = Array.isArray(payload.init_images) && payload.init_images.length > 0;
  const requestPath = hasInitImages
    ? adapter.img2imgPath || "/sdapi/v1/img2img"
    : adapter.txt2imgPath || adapter.submitPath || "/sdapi/v1/txt2img";
  if (onProgress) await onProgress(35);
  const result = await fetchJson(joinUrl(provider.baseUrl, requestPath), {
    method: "POST",
    headers: withAuthHeaders(provider),
    body: JSON.stringify(payload),
  }, Number(adapter.timeoutMs || provider.timeoutSeconds * 1000 || 120000));
  if (onProgress) await onProgress(90);
  const firstImage = Array.isArray(result.images) ? result.images[0] : undefined;
  if (!firstImage) throw new Error("SD WebUI 未返回图片");
  return {
    providerTaskId: result.info ? "sd-webui-sync" : undefined,
    url: `data:image/png;base64,${firstImage}`,
    raw: result,
  };
}
