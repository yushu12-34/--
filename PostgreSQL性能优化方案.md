# PostgreSQL 专用查询改造任务书

## 任务目标

把 API 的 HTTP 读取路径从“每个请求先 `readJson()` 加载整库快照，再在内存里筛选”改造成 PostgreSQL 模式下的专用 SQL 查询。

保持现有部署结构不变：

```text
前端 App -> API 服务 -> PostgreSQL
```

不要让前端直连 PostgreSQL。API 和 PostgreSQL 可以继续部署在不同主机，只要 `DATABASE_URL` 指向 PostgreSQL 服务器内网 IP 或域名即可。

## 背景结论

当前实时协同写入已经改为 PostgreSQL 单表增量写入，避免了 Yjs 每次更新触发整库重写。但 HTTP 读取仍有性能上限：

- `server.js` 在大部分请求入口会执行 `const db = await readJson()`。
- PostgreSQL 模式下 `readJson()` 会从多张表加载完整快照。
- 远程 PostgreSQL 部署时，整库快照会放大网络传输、JSON 解析、连接占用和缓存失效成本。
- 项目、画布、资产、任务、后台概览应改为按需查询。

## Agent 执行命令

按以下顺序执行，不要跳步。

### TASK 1: 读取现状并标记整库读取入口

执行：

```powershell
rg -n "readJson\\(|const db = await readJson|buildProjectList|buildAdminOverview|enrichAdminTaskList|listSystemEvents|listCanvasYjsHistory|getCanvasYjsHistorySnapshot" apps\api\src tests
```

要求：

- 找出所有 HTTP GET 路由中依赖整库 `db` 的位置。
- 区分 WebSocket/Yjs 恢复路径和 HTTP 普通读取路径。
- 不要删除 JSON 后端能力。

### TASK 2: 在 db 层暴露后端判断和 PostgreSQL store 只读方法

修改：

- `apps/api/src/db.js`
- `apps/api/src/services/postgresStore.js`

目标：

- 新增或暴露一个安全方法，用于判断当前是否实际使用 PostgreSQL。
- 新增 PostgreSQL 专用只读方法，供 `server.js` 调用。
- JSON 模式继续走现有 `readJson()`。

建议接口：

```js
export async function usePostgresBackend()
export async function listProjectsView(userId)
export async function getProjectView(projectId, userId)
export async function getCanvasView(canvasId)
export async function listCanvasMembersView(canvasId)
export async function listAssetsView(projectId)
export async function getTaskView(taskId)
export async function getAdminOverviewView()
export async function listAdminTasksView()
export async function getAdminTaskView(taskId)
export async function listSystemEventsView(filters)
export async function listYjsHistoryView(canvasId)
export async function getYjsHistorySnapshotView(canvasId, snapshotId)
```

命名可按项目风格微调，但必须清晰区分“PostgreSQL 专用查询”和“整库快照读取”。

### TASK 3: 实现项目列表专用查询

替换路由：

```text
GET /api/projects
```

当前逻辑：

- `readJson()`
- `buildProjectList(db)`
- 按 owner/member 过滤

PostgreSQL 查询要求：

- 从 `projects` 查询基础项目。
- 聚合 `canvases` 数量和最大 `updated_at`。
- 聚合 `assets` 数量和最大 `created_at`。
- 聚合 `yjs_updates` / `yjs_snapshots` 历史数量和最大 `created_at`。
- 支持 `x-user-id` 或 `userId` 查询参数过滤 owner/member。
- 返回结构与现有 `buildProjectList(db)` 兼容。

验收：

- 前端项目列表不需要改接口。
- 大项目下不加载 `canvases.snapshot`、`tasks.input/output`、Yjs `update_data`。

### TASK 4: 实现项目详情专用查询

替换路由：

```text
GET /api/projects/:id
```

PostgreSQL 查询要求：

- 只查询目标 `project`。
- 只查询该项目下当前用户可访问的 `canvases`。
- 返回 `{ project, canvases }`，结构与现有接口兼容。
- 允许 canvas 返回 `snapshot`，因为前端打开项目需要画布基础数据。
- 不加载其他项目、其他资产、所有任务、所有系统事件、所有 Yjs 历史。

验收：

- 切换项目、刷新项目页行为不变。
- 远程数据库下响应体大小明显小于整库快照。

### TASK 5: 实现单画布和画布成员专用查询

替换路由：

```text
GET /api/canvases/:id
GET /api/canvases/:id/members
```

PostgreSQL 查询要求：

- 单画布只查 `canvases where id = $1`。
- 成员只查 `canvas_members where canvas_id = $1`。
- 保留 owner 的 synthetic member 兼容逻辑。

验收：

- 多画布项目中打开单画布不会加载所有画布。
- 成员管理页面行为不变。

### TASK 6: 实现资产列表专用查询

替换路由：

```text
GET /api/assets?projectId=...
```

PostgreSQL 查询要求：

- 有 `projectId` 时只查该项目资产。
- 没有 `projectId` 时按当前兼容行为返回全部资产，但必须限制字段转换，不读取无关大对象。
- 使用 `rowToAsset()` 保持返回结构。

验收：

- 资产库刷新不触发整库读取。
- 资产按原排序返回。

### TASK 7: 实现任务读取和后台任务列表专用查询

替换路由：

```text
GET /api/ai/tasks/:id
GET /internal/tasks
GET /internal/tasks/:id
```

PostgreSQL 查询要求：

- 单任务只查目标任务，并按需要关联 `models`、`providers` 做展示字段。
- 后台任务列表查询 `tasks`，再批量加载相关 `models`、`providers`，避免 N+1。
- 保持 `enrichAdminTask()` / `enrichAdminTaskList()` 的输出兼容。
- 对后台列表增加合理 limit，默认建议 200，可通过查询参数调整但设置上限。

验收：

- 后台任务页不加载所有项目、画布、资产、Yjs 历史。
- 批量重试逻辑仍能工作；如果它需要全量 db，保留写路径原逻辑，不在本任务强拆。

### TASK 8: 实现后台概览和系统事件专用查询

替换路由：

```text
GET /internal/overview
GET /internal/system-events
```

PostgreSQL 查询要求：

- 概览通过 SQL 聚合统计 tasks、models、providers、system_events。
- 最近失败任务只取必要条数，并批量关联模型/供应商。
- 系统事件支持现有 `level`、`category`、`limit` 过滤。
- 保持返回结构兼容 `buildAdminOverview(db)` 和 `listSystemEvents(db, filters)`。

验收：

- 后台首页不再加载整库快照。
- 系统事件列表按原筛选条件返回。

### TASK 9: 实现 Yjs 历史专用查询

替换路由：

```text
GET /api/canvases/:id/yjs-history
GET /api/canvases/:id/yjs-history/:snapshotId
```

PostgreSQL 查询要求：

- 历史列表只查 `yjs_snapshots where canvas_id = $1`，不要读取 `update_data` 到响应。
- 详情只查目标 snapshot 的 `update_data`，用于生成历史快照详情。
- 复用现有 `rowToWorkflowSnapshot()`、`buildYDocFromPersistence()`、`snapshotFromYDoc()` 或等价逻辑。

验收：

- 历史列表不返回原始 update。
- 历史详情能恢复画布 snapshot。

### TASK 10: 改造 server.js 路由分流

修改：

- `apps/api/src/server.js`

要求：

- 不要在所有请求入口无条件执行 `const db = await readJson()`。
- 对已完成专用查询的 GET 路由，在 PostgreSQL 模式下直接调用专用查询。
- JSON 模式继续使用现有 `readJson()` 和内存逻辑。
- 写接口暂时保留现有逻辑，除非已有直接写方法。
- 注意内部鉴权：`/internal` 或 `/api/admin` 路由仍必须先校验权限。

建议结构：

```js
const pg = await usePostgresBackend();

if (pg && req.method === "GET" && pathname === "/api/projects") {
  const projects = await listProjectsView(requestUserId);
  send(res, 200, { projects });
  return;
}

const db = await readJson();
```

注意：

- 不能为了某个已专用化的 GET 路由提前调用 `readJson()`。
- 对仍未改造的路由再回退到 `readJson()`。

### TASK 11: 补测试

修改或新增：

- `tests/postgresStore.test.mjs`
- `tests/api.test.mjs`
- 如需要，新增专用查询单元测试文件。

测试要求：

- 测试 row 转换和聚合输出结构。
- 测试 JSON 模式行为不变。
- 如仓库没有真实 PostgreSQL 测试环境，用 mock client/pool 或纯函数测试 SQL 结果转换。
- 保持现有测试全部通过。

执行：

```powershell
node --check apps/api/src/server.js
node --check apps/api/src/db.js
node --check apps/api/src/services/postgresStore.js
node --check apps/api/src/services/yjsPersistenceService.js
npm test
```

### TASK 12: 性能验证

执行本地基准或新增轻量脚本：

```powershell
npm run postgres:smoke
npm run postgres:api-smoke
```

如果没有可用 PostgreSQL 环境，至少输出未执行原因，并确认单元测试覆盖。

服务器验证 SQL：

```sql
select state, wait_event_type, wait_event, count(*)
from pg_stat_activity
where datname = current_database()
group by state, wait_event_type, wait_event
order by count(*) desc;

select query, calls, mean_exec_time, rows
from pg_stat_statements
where query ilike '%projects%'
   or query ilike '%canvases%'
   or query ilike '%tasks%'
order by mean_exec_time desc
limit 20;
```

验收目标：

- 打开项目列表不再触发全表加载 `yjs_updates` / `yjs_snapshots`。
- 打开后台任务页不再加载项目、画布、资产、Yjs 历史。
- 普通 GET 请求 PostgreSQL 查询数量和响应体大小显著下降。

## 必须保持的兼容性

- 前端 API 路径不变。
- 返回 JSON 结构尽量不变。
- JSON 文件后端继续可用。
- PostgreSQL 和 API 可继续部署在不同主机。
- 不引入前端直连数据库。
- 不破坏现有 WebSocket 协同逻辑。
- 不破坏项目导入、导出、复制、删除等写路径。

## 禁止事项

- 禁止让前端读取 `DATABASE_URL`。
- 禁止把 PostgreSQL 密码写入前端环境变量。
- 禁止为了快速实现而删除 JSON 后端。
- 禁止在每个专用查询里做 N+1 查询。
- 禁止在 GET 路由开头无条件 `readJson()`。
- 禁止返回 Yjs 原始 `update_data` 给历史列表接口。

## 建议索引

确认以下索引存在：

```sql
create index if not exists yjs_updates_canvas_created_idx
  on yjs_updates(canvas_id, created_at, id);

create index if not exists yjs_snapshots_canvas_created_idx
  on yjs_snapshots(canvas_id, created_at desc, id desc);

create index if not exists canvases_project_updated_idx
  on canvases(project_id, updated_at desc);

create index if not exists assets_project_created_idx
  on assets(project_id, created_at desc);

create index if not exists tasks_canvas_updated_idx
  on tasks(canvas_id, updated_at desc);

create index if not exists system_events_created_idx
  on system_events(created_at desc);

create index if not exists project_members_user_project_idx
  on project_members(user_id, project_id);

create index if not exists canvas_members_user_canvas_idx
  on canvas_members(user_id, canvas_id);
```

## 建议提交说明

完成后总结：

```text
改造 HTTP PostgreSQL 读取路径：
- 项目/画布/资产/任务/后台/Yjs 历史 GET 路由使用专用 SQL 查询
- PostgreSQL 模式避免 readJson 整库快照读取
- JSON 后端保留原兼容路径
- 增加必要索引和测试
```

## 最终验收清单

- `npm test` 通过。
- `node --check` 通过。
- PostgreSQL 模式下，以下 GET 路由不再调用整库 `readJson()`：
  - `/api/projects`
  - `/api/projects/:id`
  - `/api/canvases/:id`
  - `/api/canvases/:id/members`
  - `/api/assets?projectId=...`
  - `/api/ai/tasks/:id`
  - `/internal/overview`
  - `/internal/tasks`
  - `/internal/tasks/:id`
  - `/internal/system-events`
  - `/api/canvases/:id/yjs-history`
  - `/api/canvases/:id/yjs-history/:snapshotId`
- JSON 模式下以上接口行为不变。
- API 和 PostgreSQL 分离部署说明保留，不要求同主机。
