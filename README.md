# 无限画布 AI 动漫创作工具

基于 `开发计划.md` 的 MVP 工程骨架，当前实现第一优先级闭环：

- 无限画布节点编辑：文本、图片、音频、视频输入节点，以及图片/音频/视频生成节点。
- 连接规则校验：端口方向、媒体类型、单输入限制、自连接和循环依赖拦截。
- 图片生成闭环：文本节点连接图片生成节点后，可发起模拟 AI 任务并回写图片结果。
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
- 管理端：`http://localhost:5180/admin`
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
  api/      轻量 Node API，负责项目、画布快照、素材、模拟 AI 任务
  web/      React + TypeScript + Vite + React Flow 创作端与管理端
scripts/   本地环境安装、启动、停止脚本
开发计划.md
画布设计.txt
```

## 当前边界

当前 AI 生成使用模拟任务返回 SVG 图片，便于先跑通节点与任务链路。后续可在 `apps/api/src/server.js` 中替换 `createMockImageResult` 为真实模型适配器，并接入 Redis/BullMQ、PostgreSQL、MinIO 与 Yjs WebSocket 服务。
