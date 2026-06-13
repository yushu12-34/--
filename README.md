# 无限画布 AI 动漫创作工具

基于 `开发计划.md` 的 MVP 工程骨架，当前已推进到 **阶段 7C-1P：内测数据与恢复演练**：

- 无限画布节点编辑：文本、图片、音频、视频输入节点，以及图片/音频/视频生成节点。
- 连接规则校验：端口方向、媒体类型、单输入限制、自连接和循环依赖拦截。
- 图片生成闭环：文本节点连接图片生成节点后，可发起异步 AI 任务并回写图片结果。
- 工作流运行：框选多个节点后自动生成组合背景，可在组合内按 DAG 顺序运行生成节点。
- 节点缓存：生成节点会记录输入签名，输入未变化时可命中缓存，输入变化后提示结果可能过期。
- 素材库：支持筛选、预览、重命名、删除、复制 URL，以及拖拽素材到画布。
- 协作 MVP：支持在线用户、光标、编辑状态、断线重连和画布快照同步。
- 项目管理：支持项目抽屉列表、新建、切换、重命名、复制、删除、JSON 导入/导出和摘要统计。
- 历史版本：支持 Yjs 快照列表、详情摘要、恢复前后差异提示、空快照保护和恢复失败提示。
- 本地与后端持久化：画布快照优先保存到 API，API 不可用时回退到浏览器本地存储。
- 数据备份：项目导入和历史恢复前自动备份 `data/db.json`，备份失败时阻断危险写入，并提供隔离恢复演练脚本。
- 性能优化：大画布加载、选择、拖拽、保存、渲染和生产包体已完成多轮基准优化。
- 预发检查：提供 `npm run preflight`，串联本地探活、画布基准、测试、构建、安全预检、发布候选冒烟验收和恢复演练。
- 运行日志：开发者管理端提供“运行日志”页，可查看 API 启动、安全拦截、任务失败、模型配置、供应商测试和备份异常等事件。
- 本地依赖环境：在项目文件夹内安装依赖并启动，方便开发调试。

## 快速启动

首次准备本地环境：

```powershell
cd E:\画板
npm run setup
```

启动全部服务：

```powershell
npm run dev
```

如果你想以前台热启动方式开发前端，建议开两个终端：

终端 1 启动后端：

```powershell
cd E:\画板
npm run dev:api
```

终端 2 启动前端热更新：

```powershell
cd E:\画板
npm run dev:web
```

前端使用 Vite，修改 `apps/web/src` 下的文件会自动热更新浏览器页面。

启动后访问：

- 创作端：`http://localhost:5180`
- 开发者管理端：`http://localhost:5190`
- API 健康检查：`http://localhost:8787/api/health`

停止服务：

```powershell
npm run stop
```

发布前或内测前建议运行一键预检：

```powershell
npm run preflight
```

完整启动、预检、端口边界、备份和故障处理见 [发布前运维说明.md](./发布前运维说明.md)。

## 本地环境说明

需要安装：

- Node.js 20+
- npm

依赖会安装在项目内：

- `apps/api/node_modules`
- `apps/web/node_modules`

本地数据默认保存在：

- `data/db.json`

7C-1U 已新增 PostgreSQL 可选后端。默认仍使用本地 JSON；客户端后端程序需要连接服务器 PostgreSQL 时，在 `.env` 中设置：

```env
DATA_BACKEND=postgres
DATABASE_URL=postgresql://anime_canvas_app:真实密码@服务器局域网IP:5432/anime_canvas
USER_FINGERPRINT_SECRET=至少32字节随机密钥
```

迁移前可先运行：

```powershell
npm run postgres:dry-run
```

正式迁移前可以用严格模式阻断坏引用：

```powershell
$env:POSTGRES_DRY_RUN_STRICT="true"; npm run postgres:dry-run
```

验证本机后端到服务器 PostgreSQL 的局域网连通性：

```powershell
$env:DATABASE_URL="postgresql://anime_canvas_app:真实密码@服务器局域网IP:5432/anime_canvas"; npm run postgres:smoke
```

正式迁移采用双保险命令：默认演练不写库，只有带 `--apply --confirm replace-postgres` 才会替换 PostgreSQL，并在写入前备份当前 PostgreSQL 快照：

```powershell
npm run postgres:migrate
npm run postgres:migrate -- --apply --confirm replace-postgres
```

API 切到 PostgreSQL 后可做接口 smoke：

```powershell
npm run postgres:api-smoke
```

端口和模型服务地址可改 `.env`：

- `API_PORT=8787`
- `WEB_PORT=5180`
- `Z_IMAGE_BASE_URL=http://localhost:8192`

## 目录结构

```text
apps/
  api/      轻量 Node API，负责用户、项目、画布快照、素材、AI 任务、队列回退与协作广播
  web/      React + TypeScript + Vite + React Flow 客户创作端
  admin/    React + TypeScript + Vite 开发者模型配置后台
scripts/   本地环境安装、启动、停止脚本
开发计划.md
发布前运维说明.md
画布设计.txt
```

## 分端与上线准备

阶段 7A 已完成客户创作端和开发者模型配置后台分离，阶段 7B 已完成模型参数和任务诊断增强，阶段 7C 正在补齐内测稳定性、性能、预检和上线准备：

- `apps/web` 只面向客户，保留画布、项目、素材、协作、历史、公开模型选择和公开参数。
- 开发者模型配置后台已迁出到 `apps/admin`，管理供应商、密钥、适配器、内部执行参数、客户公开参数、测试连接、任务诊断和运行日志。
- 客户前端只调用 `/api/*` 公开接口；开发者后台调用 `/internal/*` 内部接口。
- 客户端不得接收 `baseUrl`、密钥、adapter、请求模板、轮询模板和字段映射等内部配置。
- 客户端命中 `/admin` 路径时只显示不可用入口，不渲染开发者后台或画布。
- 发布前运维流程见 `发布前运维说明.md`，建议内测前先执行 `npm run preflight`。

## 当前边界

当前图片生成已支持 Z-Image / Z-Image Turbo / SD WebUI 适配器，并具备 Redis/BullMQ 队列和 MinIO 存储的可选接入；本地开发默认使用本进程本地队列，需要 BullMQ 时显式设置 `TASK_QUEUE_MODE=bullmq` 和 Redis 连接，当 MinIO 未配置时会保留远程 URL 或内联数据。

仍需注意的边界：

- 后端数据默认仍使用 `data/db.json` 本地 JSON 存储；7C-1U 已接入 PostgreSQL 可选存储适配层，设置 `DATA_BACKEND=postgres` 后由后端通过局域网连接服务器 PostgreSQL。JSON 正式导入 PostgreSQL、用户指纹请求链路和跨用户权限隔离将在后续 7C-1V/1W 完成。
- 协作当前已接入 Yjs update / state-vector / awareness 兼容桥，但仍保留旧 snapshot 协议作为兼容兜底。
- 开发者模型配置后台已从客户创作端迁出到 `apps/admin`，内部接口优先使用本机访问限制；配置 `INTERNAL_ADMIN_TOKEN` 后需要后台请求携带 token。
- 模型配置现在区分内部 `defaultParams` / `paramSchema` 与客户公开 `defaultPublicParams` / `publicParamSchema`。
- 音频/视频节点和素材输入已具备，真实音频/视频生成适配器仍待开发。
- 供应商密钥当前为开发环境本地 JSON 存储，接口会脱敏返回，但尚未加密落库。
- 运行日志当前保存在当前数据后端的 `systemEvents` / `system_events` 中，最多保留最近 500 条，尚未接入外部日志平台。
