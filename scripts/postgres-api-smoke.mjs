const API_BASE_URL = (process.env.API_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const INTERNAL_ADMIN_TOKEN = process.env.INTERNAL_ADMIN_TOKEN || "";

async function requestJson(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.internal && INTERNAL_ADMIN_TOKEN) headers.authorization = `Bearer ${INTERNAL_ADMIN_TOKEN}`;
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(`Cannot reach ${API_BASE_URL}${path}. Start the API with DATA_BACKEND=postgres first. ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} did not return JSON: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

try {
  const health = await requestJson("/api/health");
  if (health.ok !== true) throw new Error("/api/health did not return ok=true");

  const models = await requestJson("/api/models");
  if (!Array.isArray(models.models)) throw new Error("/api/models did not return models array");

  const projects = await requestJson("/api/projects");
  const projectList = asArray(projects.projects);
  let firstProjectDetail = null;
  let firstCanvasDetail = null;
  let assets = [];

  if (projectList.length > 0) {
    const projectId = encodeURIComponent(projectList[0].id);
    firstProjectDetail = await requestJson(`/api/projects/${projectId}`);
    const canvases = asArray(firstProjectDetail.canvases);
    assets = asArray((await requestJson(`/api/assets?projectId=${projectId}`)).assets);
    if (canvases.length > 0) {
      firstCanvasDetail = await requestJson(`/api/canvases/${encodeURIComponent(canvases[0].id)}`);
    }
  }

  let overview = null;
  try {
    overview = await requestJson("/internal/overview", { internal: true });
  } catch (error) {
    overview = { skipped: error instanceof Error ? error.message : String(error) };
  }

  console.log("PostgreSQL API smoke OK");
  console.log(`health: ${health.service || "ok"}`);
  console.log(`models: ${asArray(models.models).length}`);
  console.log(`projects: ${projectList.length}`);
  console.log(`first project canvases: ${firstProjectDetail ? asArray(firstProjectDetail.canvases).length : 0}`);
  console.log(`first project assets: ${assets.length}`);
  console.log(`first canvas loaded: ${firstCanvasDetail?.canvas ? "yes" : "no"}`);
  if (overview?.overview) {
    console.log(`admin overview tasks: ${overview.overview.tasks?.total ?? 0}`);
  } else {
    console.log(`admin overview skipped: ${overview.skipped}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
