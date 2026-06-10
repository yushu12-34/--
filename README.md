# 无限画布 AI 动漫创作工具

基于 `开发计划.md` 的 MVP 工程骨架，当前已推进到 **阶段 6D-3：项目列表页与历史体验打磨**：

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

## 本地环境说明

需要安装：

- Node.js 20+
- npm

依赖会安装在项目内：

- `apps/api/node_modules`
- `apps/web/node_modules`

本地数据默认保存在：

- `data/db.json`

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
画布设计.txt
```

## 阶段 7A 方向（进行中）

阶段 7A 已开始把客户创作端和开发者模型配置后台分离：

- `apps/web` 只面向客户，保留画布、项目、素材、协作、历史、公开模型选择和公开参数。
- 开发者模型配置后台已迁出到 `apps/admin`，管理供应商、密钥、适配器、内部执行参数、客户公开参数、测试连接和任务诊断。
- 客户前端只调用 `/api/*` 公开接口；开发者后台调用 `/internal/*` 内部接口。
- 客户端不得接收 `baseUrl`、密钥、adapter、请求模板、轮询模板和字段映射等内部配置。
- 客户端命中 `/admin` 路径时只显示不可用入口，不渲染开发者后台或画布。

## 当前边界

当前图片生成已支持 Z-Image / Z-Image Turbo / SD WebUI 适配器，并具备 Redis/BullMQ 队列和 MinIO 存储的可选接入；当 Redis 不可用时会回退到本进程本地队列，当 MinIO 未配置时会保留远程 URL 或内联数据。

仍需注意的边界：

- 后端数据仍使用 `data/db.json` 本地 JSON 存储，尚未迁移到 PostgreSQL。
- 协作当前已接入 Yjs update / state-vector / awareness 兼容桥，但仍保留旧 snapshot 协议作为兼容兜底。
- 开发者模型配置后台已从客户创作端迁出到 `apps/admin`，内部接口优先使用本机访问限制；配置 `INTERNAL_ADMIN_TOKEN` 后需要后台请求携带 token。
- 模型配置现在区分内部 `defaultParams` / `paramSchema` 与客户公开 `defaultPublicParams` / `publicParamSchema`。
- 音频/视频节点和素材输入已具备，真实音频/视频生成适配器仍待开发。
- 供应商密钥当前为开发环境本地 JSON 存储，接口会脱敏返回，但尚未加密落库。
