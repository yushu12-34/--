# PostgreSQL 部署计划

## 1. 目标

将当前后端主数据从 `data/db.json` 迁移到服务器上的 PostgreSQL，解决 JSON 单文件多次损坏、写入并发弱、恢复困难的问题。

本计划面向一台已有服务器，目标是先开放一个开发使用端口完成内测，再逐步进入稳定部署。

核心要求：

- PostgreSQL 作为主数据库，不再依赖 `db.json` 作为生产主存储。
- 数据按用户隔离，项目、画布、素材、任务、历史记录都必须能归属到明确用户。
- 支持用户指纹，但不保存明文指纹、明文 IP、完整 User-Agent 等敏感原始值。
- 数据库端口不直接暴露到公网。
- 部署后具备备份、恢复、迁移、审计和回滚方案。

## 2. 推荐部署拓扑

推荐第一阶段采用单服务器部署：

```text
浏览器 / 内测用户
        |
        | HTTPS 或 SSH 隧道访问一个开发端口
        v
Nginx / Caddy / 直接 Node API
        |
        | localhost / 内网
        v
Node API 服务
        |
        | 127.0.0.1:5432 或 Docker 内网
        v
PostgreSQL
```

端口建议：

- 对外只开放一个开发入口端口，例如 `18080` 或反向代理后的 `443`。
- PostgreSQL `5432` 仅监听 `127.0.0.1` 或 Docker 内网，不对公网开放。
- Web/Admin/API 可以先继续使用本项目现有端口，但正式给用户访问时建议只通过一个反向代理入口。
- 临时开发访问推荐 SSH 隧道：

```powershell
ssh -L 8787:127.0.0.1:8787 user@your-server
```

这样本机访问 `http://localhost:8787`，服务器数据库和服务端口都不需要公网暴露。

## 3. PostgreSQL 安装方式

### 方案 A：Docker Compose，推荐

优点是可复制、可回滚、数据目录清晰。

建议目录：

```text
/opt/anime-canvas/
  docker-compose.yml
  .env
  postgres/
    data/
    backups/
```

示例 `docker-compose.yml`：

```yaml
services:
  postgres:
    image: postgres:16
    container_name: anime-canvas-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: anime_canvas
      POSTGRES_USER: anime_canvas_app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      TZ: Asia/Shanghai
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - ./postgres/data:/var/lib/postgresql/data
      - ./postgres/backups:/backups
    command:
      - "postgres"
      - "-c"
      - "wal_level=replica"
      - "-c"
      - "max_connections=100"
      - "-c"
      - "shared_buffers=256MB"
      - "-c"
      - "timezone=Asia/Shanghai"
```

`.env` 中只放服务器本地密钥，不提交到 Git：

```env
POSTGRES_PASSWORD=替换为强密码
```

### 方案 B：服务器原生安装

适合已有系统级 PostgreSQL 运维经验的服务器。

要求：

- `listen_addresses = 'localhost'` 或仅内网 IP。
- `pg_hba.conf` 只允许本机或应用服务器 IP 连接。
- 应用账号不是超级用户。
- 数据目录纳入服务器备份策略。

## 4. 应用环境变量规划

新增或预留：

```env
DATA_BACKEND=postgres
DATABASE_URL=postgresql://anime_canvas_app:强密码@127.0.0.1:5432/anime_canvas
USER_FINGERPRINT_SECRET=替换为至少32字节随机密钥
TRUST_PROXY=true
API_PORT=8787
WEB_PORT=5180
ADMIN_PORT=5190
INTERNAL_ADMIN_TOKEN=替换为强随机token
```

说明：

- `DATA_BACKEND=postgres`：切换数据层到 PostgreSQL。
- `DATABASE_URL`：后端唯一数据库连接入口。
- `USER_FINGERPRINT_SECRET`：用于 HMAC 用户指纹，不能提交仓库，不能前端可见。
- `TRUST_PROXY=true`：如果前面有 Nginx/Caddy，用于识别代理后的真实请求信息。

## 5. 用户指纹设计

用户指纹的目标是辅助区分不同用户/设备，不能作为唯一身份认证手段。

推荐方案：

1. 首次打开客户端时生成 `clientInstallId`，保存到浏览器 localStorage 或安全 cookie。
2. 前端请求时带上该 ID。
3. 后端结合稳定但低敏信息生成哈希：

```text
fingerprint_hash = HMAC_SHA256(
  USER_FINGERPRINT_SECRET,
  clientInstallId + ":" + normalizedUserAgent + ":" + optionalAccountId
)
```

隐私要求：

- 不保存明文 `clientInstallId`。
- 不保存完整明文 IP。
- 不保存完整明文 User-Agent。
- 可以保存 `user_agent_hash`、`ip_prefix_hash`、`fingerprint_hash`。
- 指纹密钥轮换时使用 `fingerprint_version` 标记。

数据隔离原则：

- 业务数据隔离以 `owner_user_id` / `project_members` 为准。
- 指纹用于识别设备、风控、排查、弱登录场景，不替代用户权限。
- 所有查询必须带当前用户上下文。

## 6. 核心表结构规划

第一阶段可以保留部分 JSON 字段，先保证可靠存储，再逐步细化。

```sql
create table users (
  id text primary key,
  display_name text not null,
  fingerprint_hash text,
  fingerprint_version integer not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_seen_at timestamptz
);

create unique index users_fingerprint_hash_idx
  on users (fingerprint_hash)
  where fingerprint_hash is not null;

create table user_devices (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  fingerprint_hash text not null,
  user_agent_hash text,
  ip_prefix_hash text,
  created_at timestamptz not null,
  last_seen_at timestamptz not null
);

create table projects (
  id text primary key,
  owner_user_id text not null references users(id),
  name text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table project_members (
  project_id text not null references projects(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null,
  primary key (project_id, user_id)
);

create table canvases (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  owner_user_id text not null references users(id),
  name text not null,
  snapshot jsonb not null default '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table assets (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  owner_user_id text not null references users(id),
  type text not null check (type in ('image', 'audio', 'video')),
  title text not null,
  url text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table tasks (
  id text primary key,
  project_id text references projects(id) on delete set null,
  canvas_id text references canvases(id) on delete set null,
  node_id text,
  user_id text references users(id) on delete set null,
  type text not null,
  model_id text,
  status text not null,
  progress integer not null default 0,
  input jsonb not null default '{}',
  output jsonb,
  error text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table providers (
  id text primary key,
  body jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table models (
  id text primary key,
  provider_id text references providers(id) on delete set null,
  body jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table system_events (
  id text primary key,
  user_id text references users(id) on delete set null,
  level text not null,
  category text not null,
  source text not null,
  message text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null
);

create table yjs_updates (
  id text primary key,
  canvas_id text not null references canvases(id) on delete cascade,
  user_id text references users(id) on delete set null,
  update_data bytea not null,
  created_at timestamptz not null
);

create table yjs_snapshots (
  id text primary key,
  canvas_id text not null references canvases(id) on delete cascade,
  snapshot jsonb not null,
  update_data bytea,
  created_at timestamptz not null
);
```

关键索引：

```sql
create index projects_owner_user_id_idx on projects(owner_user_id);
create index project_members_user_id_idx on project_members(user_id);
create index canvases_project_id_idx on canvases(project_id);
create index assets_project_id_idx on assets(project_id);
create index tasks_project_id_status_idx on tasks(project_id, status);
create index system_events_created_at_idx on system_events(created_at desc);
create index yjs_updates_canvas_id_created_at_idx on yjs_updates(canvas_id, created_at);
```

## 7. 权限隔离策略

应用层必须做到：

- 获取项目列表：只返回当前用户拥有或加入的项目。
- 获取画布：必须校验当前用户是否属于该画布所在项目。
- 素材、任务、历史记录：必须通过 `project_id` / `canvas_id` 反查权限。
- Admin 内部接口：必须继续使用 `INTERNAL_ADMIN_TOKEN` 或更高等级认证。

数据库层建议开启 RLS，作为第二道防线：

```sql
alter table projects enable row level security;
alter table canvases enable row level security;
alter table assets enable row level security;
alter table tasks enable row level security;
```

应用每次请求开始事务时设置：

```sql
select set_config('app.current_user_id', $1, true);
```

示例策略：

```sql
create policy project_member_select on projects
for select using (
  exists (
    select 1 from project_members pm
    where pm.project_id = projects.id
      and pm.user_id = current_setting('app.current_user_id', true)
  )
);
```

第一阶段可以先做应用层强校验，第二阶段补 RLS。

## 8. 从 `db.json` 迁移到 PostgreSQL

迁移前：

1. 停止 API 写入。
2. 备份 `data/db.json`、`data/db.json.tmp`、`data/backups/`。
3. 校验 JSON 可解析。
4. 创建 PostgreSQL 数据库和表。
5. 做 dry-run 导入，只输出数量对账，不写入。

导入规则：

- `users`：按现有用户导入；没有指纹的用户标记 `fingerprint_hash = null`。
- `projects`：写入 `owner_user_id`，旧数据统一归属默认用户或按现有 ownerId 映射。
- `project_members`：每个项目至少创建 owner 成员。
- `canvases`：保留 `snapshot` JSONB。
- `assets`：按项目写入，补 `owner_user_id`。
- `tasks`：按项目、画布、节点写入，补 `user_id`。
- `providers/models`：先整体存 JSONB，避免模型配置迁移丢字段。
- `yjs_updates`：从 base64 转为 `bytea`。
- `yjs_snapshots`：保留 snapshot JSONB，必要时保留 update bytea。

迁移验收：

```text
projects 数量一致
canvases 数量一致
assets 数量一致
tasks 数量一致
每个 canvas snapshot.nodes / snapshot.edges 数量一致
每个项目 assetCount 与接口返回一致
Admin 任务列表可读取历史任务
客户画布刷新后不丢节点、不丢素材
```

回滚：

- 保留 `db.json` 只读备份。
- `DATA_BACKEND=json` 可临时回到旧数据层。
- PostgreSQL 导入失败时删除新库重建，不覆盖旧 JSON。

## 9. 备份与恢复

最低要求：

- 每日一次 `pg_dump`。
- 保留最近 7 天每日备份、最近 4 周每周备份。
- 备份文件压缩并带时间戳。
- 每月至少做一次恢复演练。

示例：

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --file="/opt/anime-canvas/postgres/backups/anime_canvas_$(date +%Y%m%d_%H%M%S).dump"
```

恢复示例：

```bash
createdb anime_canvas_restore
pg_restore \
  --dbname=anime_canvas_restore \
  --clean \
  --if-exists \
  /opt/anime-canvas/postgres/backups/backup.dump
```

恢复验收：

- API 可启动。
- 项目列表数量正确。
- 主画布节点/连线数量正确。
- 素材库数量正确。
- 任务历史可查询。

## 10. 安全要求

服务器侧：

- 防火墙禁止公网访问 `5432`。
- 应用端口只允许内测 IP、VPN、SSH 隧道或反向代理认证访问。
- PostgreSQL 应用账号不使用超级用户。
- `.env` 权限限制为应用运行用户可读。
- 备份目录不放在 Web 静态目录。
- 定期轮换 `POSTGRES_PASSWORD`、`INTERNAL_ADMIN_TOKEN`、`USER_FINGERPRINT_SECRET`。

应用侧：

- 日志中不打印 `DATABASE_URL`、token、密钥、原始指纹、原始 IP。
- 指纹只存 HMAC 后的哈希。
- 所有项目/画布/素材/任务接口都必须经过用户上下文校验。
- Admin 接口继续和客户创作端隔离。

## 11. 分阶段实施计划

### 7C-1T：PostgreSQL 部署与数据隔离设计

- 完成本计划文档。
- 明确服务器端口策略。
- 明确用户指纹和用户数据隔离原则。
- 输出数据库表结构初稿。

### 7C-1U：PostgreSQL 存储适配层

- 新增数据库连接模块。
- 新增迁移脚本目录。
- 实现 users/projects/canvases/assets/tasks 的 PostgreSQL CRUD。
- 保留 JSON 存储作为 fallback。

### 7C-1V：JSON 到 PostgreSQL 迁移脚本

- 实现 dry-run 对账。
- 实现正式导入。
- 实现导入后接口 smoke test。
- 实现失败回滚说明。

### 7C-1W：用户指纹与权限隔离

- 前端生成 `clientInstallId`。
- 后端生成 `fingerprint_hash`。
- 所有业务查询接入当前用户上下文。
- 增加跨用户访问拒绝测试。

### 7C-1X：服务器部署验收

- 服务器部署 PostgreSQL。
- 部署 API/Web/Admin。
- 配置单开发入口端口。
- 配置备份任务。
- 完成恢复演练。

## 12. 验收清单

- PostgreSQL `5432` 不公网暴露。
- API 可以通过指定开发端口访问。
- 新用户访问会生成独立用户记录和指纹哈希。
- 不同用户只能看到自己的项目，或被授权加入的项目。
- 刷新页面后项目、画布、素材、任务状态一致。
- 中断 API 进程后重启，数据不损坏。
- 并发保存画布不会产生半截数据。
- 每日备份文件正常生成。
- 备份可以恢复到临时库并通过接口读取。
- `npm run check` 通过。

