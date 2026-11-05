# WebPulse · 网站脉搏

轻量、自托管的网站流量统计系统。当前已完成工程初始化、M0 设计冻结和 **M1 采集链路**：管理员认证与站点 API、隐私清洗、PV/互动/心跳、会话关闭和浏览器 SDK 已实现。**报表聚合、删除执行器、后台业务页面和 SSE 尚未实现。** 前端仍为初始化预览页，M1 可通过 API/SDK 使用。

采用 Node.js 24、pnpm 10、Fastify 5、TypeScript 7.0.2 strict、React 19、Ant Design 6、TanStack Query 与 PostgreSQL 17。ECharts、路由和业务插件在对应模块实施时引入。实际版本以各 `package.json` 与 `pnpm-lock.yaml` 为准。

## 本地启动

准备 Node.js `24.18.0`（见 `.nvmrc`）、pnpm `10.20.0` 和 Docker Compose。以下命令在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
test -f .env || cp .env.example .env
# 新建 .env 时，填写非空的 DB_PASSWORD；本次初始化已生成本地随机密码。
docker compose -f compose.dev.yml up -d --wait db
pnpm db:migrate
# 按下方 M1 配置段创建三份独立密钥并补齐 .env，再启动。
pnpm dev
```

访问 <http://127.0.0.1:5173>。API 默认监听 `127.0.0.1:3000`，Vite 将 `/api` 转发给 API。修改根目录 `.env` 的 `PORT` 后，重启开发服务；前端代理会使用同一端口。`pnpm dev` 先构建公共包与 SDK，随后同时启动 API 与前端；编辑公共契约或 SDK 后另行重建相关包。

根目录 `.env` 由后端按文件位置显式加载，与运行目录无关；已有进程环境变量优先。文件已被 Git 忽略，本次生成时权限为 `0600`。不要将密码放入 `VITE_` 变量。连接已有数据库时可通过 `DB_PASSWORD_FILE` 读取密码文件，不能同时设置 `DB_PASSWORD`。本地 Compose 使用 `.env` 中的 `DB_PASSWORD`；文件密码方式用于外部数据库连接。

Compose 只启动本项目的开发数据库，端口仅绑定 loopback，数据保存在 `webpulse-dev_pg_dev_data` 卷。它使用单一开发角色，**不是生产分权配置**。原生产参考仍在 `design/reference/`，其中 `database:prepare`、TLS 与生产服务将在 M4 前补齐；当前管理员命令为 `pnpm admin:create`（见下文），参考镜像的执行方式尚未交付，不应直接当作当前可用部署流程。

## 健康与迁移

```bash
curl -fsS http://127.0.0.1:3000/api/v1/health/live
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

- `live`：进程存活返回 200，不依赖数据库。
- `ready`：数据库连通，且全部迁移名称和 SHA-256 校验和匹配时返回 200；未迁移、连接失败、迁移被修改或版本不匹配时返回 503。
- 启动 API 不会自动执行迁移。环境参数非法或缺少数据库密码时立即启动失败。
- `pnpm db:migrate` 使用单连接事务与 PostgreSQL advisory lock；整批失败回滚，重复执行无新增迁移。已应用 SQL 不应修改，后续增加新编号 SQL；M1 已新增 `002_collection.sql`。
- 应用迁移位于 `apps/server/migrations/`；`001_init.sql` 保留参考结构的 16 张业务表，由迁移器接管事务，另外维护 `schema_migrations`。002 补齐引用索引、规则快照、活动顺序、身份 epoch 与采集事实字段。

## 验证命令

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:postgres
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:sdk
```

`typecheck` 和构建使用 TypeScript 7.0.2 的原生 `tsc`；`lint` 使用 Oxlint 1.91.0，任何警告或错误均阻止通过；`format:check` 继续使用 Prettier。项目不再依赖 ESLint、typescript-eslint 或 TS6 兼容包。

规则集中在 `.oxlintrc.json`，沿用原有推荐规则及目录排除。显式启用尚处实验阶段的 `no-undef` 和 `no-useless-assignment`，避免迁移时遗漏既有检查；TS/TSX 的 `no-undef` 仍交由编译器处理。`no-dupe-args`、`no-octal` 由 ESM 严格模式语法检查覆盖。浏览器目录使用 `browser` 环境，Node 环境和原有覆盖关系保留。当前未启用依赖类型信息的 lint 规则；类型校验仍由 `pnpm typecheck` 执行。

TypeScript 7 和 Oxlint 通过平台相关的可选依赖提供原生程序，安装时不要禁用 optional dependencies；不同操作系统/架构应使用锁文件重新安装依赖。编辑器的 TypeScript 服务与 Oxlint 扩展需分别配置，命令行升级不会自动更改编辑器设置。

`test` 检查配置、健康、指标、清洗、HMAC 和资源限额；`test:integration` 用内存 PGlite 检查迁移及 M0 查询设计探针，不需要 Docker。`test:postgres` 显式连接 `.env` 指定的开发库，在随机生成的独立 schema 中验证迁移、认证、采集、会话、暂停排空、公平性、取消回滚及索引计划，结束后只清理该测试 schema；**仅在开发数据库执行**。

`test:e2e` 自动启动 Vite，使用模拟健康响应验证 1440px/390px 下的错误、重试、键盘和响应式行为，不代表生产端到端验证。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定已有 Chromium。浏览器、真实 PostgreSQL 和静态检查的实际结果见 [初始化验证记录](docs/初始化验证记录.md)。

构建产物分别位于 `apps/server/dist`、`apps/dashboard/dist`、`packages/shared/dist` 和 `packages/tracker/dist`。`tracker.js` 已可接入，详见 [SDK 接入与隐私说明](packages/tracker/README.md)。`pnpm test:sdk` 使用 Chromium，包含模拟传输的隐私/导航场景和真实本地 HTTP + 独立 PostgreSQL schema 的完整链路；也只应连接开发数据库。

停止本地数据库（保留数据）：

```bash
docker compose -f compose.dev.yml stop db
```

## 项目结构与下一阶段

| 路径               | 职责                                       |
| ------------------ | ------------------------------------------ |
| `apps/server`      | API、认证、站点、采集、会话、迁移与 CLI    |
| `apps/dashboard`   | React 入口、主题和连接状态页面             |
| `packages/shared`  | 公共 Schema、类型、隐私清洗与指标定义      |
| `packages/tracker` | 无框架采集 SDK、身份、生命周期与传输       |
| `packages/config`  | 公共 TypeScript 配置                       |
| `tests`            | 单元、PGlite、真实 PostgreSQL 与浏览器验证 |
| `design`           | 原技术设计、评审报告与参考快照             |
| `docs`             | 实施进度与当前验证证据                     |

M1 的代码、并发/隐私证据及边界见 [M1 采集链路与验收](docs/M1采集链路与验收.md)。下一阶段为 **M2 查询与聚合**，继续处理精确去重、同期比较、重算、冻结、清理和删除对账；详见 [实施计划与进度](docs/实施计划与进度.md)。

## M1 本地配置与管理员

API 启动要求三份独立、稳定的 32 字节 HMAC 密钥。首次创建（仅写不存在的文件，不覆盖旧密钥）：

```bash
cd /root/WebPulse
node --input-type=module <<'JS'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('secrets', { recursive: true, mode: 0o700 });
for (const name of ['visitor_hmac_key', 'ip_hmac_key', 'csrf_hmac_key']) {
  const path = `secrets/${name}.txt`;
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
}
JS
```

将以下设置补入现有 `.env`，保留数据库配置和已有密钥：

```dotenv
ADMIN_ORIGIN=http://127.0.0.1:5173
VISITOR_HMAC_KEY_FILE=secrets/visitor_hmac_key.txt
IP_HMAC_KEY_FILE=secrets/ip_hmac_key.txt
CSRF_HMAC_KEY_FILE=secrets/csrf_hmac_key.txt
```

密钥相对路径从仓库根解析；可改为绝对路径。生产 `ADMIN_ORIGIN` 必须 HTTPS，cookie 使用 `__Host-wp_admin`、Secure、HttpOnly、SameSite=Lax；本地 HTTP 使用 `wp_admin_dev`。不提供默认账号。建管理员前先迁移；密码通过隐藏输入传入 stdin，不放命令参数：

```bash
cd /root/WebPulse
pnpm db:migrate
read -r -s -p '管理员密码（至少 12 字符）: ' WEBPULSE_NEW_ADMIN_PASSWORD
printf '\n'
printf '%s' "$WEBPULSE_NEW_ADMIN_PASSWORD" | pnpm admin:create admin
unset WEBPULSE_NEW_ADMIN_PASSWORD
pnpm dev
```

也可设置 `ADMIN_PASSWORD_FILE` 指向受限密码文件。重名账号创建失败，不重置已有密码。密钥缺失/重复/格式无效时启动失败；不要生成临时密钥代替已有密钥，否则身份会改变。

M1 管理 API 使用 `/api/v1/auth/login`、`GET /auth/session`、`POST /auth/logout`、`GET/POST /sites`、`GET/PATCH /sites/:site_id`。写请求必须带精确 `Origin`、管理 cookie 和登录返回的 `X-CSRF-Token`。站点创建字段、PATCH 白名单及采集请求示例见 [M1 文档](docs/M1采集链路与验收.md)和 [设计契约](design/WebPulse-项目技术文档.md#113-登录与站点)。

服务端保持 `trustProxy=false`，只使用 socket 地址生成站点化 IP HMAC。M4 配置可信代理前，不应把本开发入口经任意代理投入生产并宣称 IP 指标准确。M1 没有清理历史数据或运行删除任务；保留设置记录策略，实际执行在 M2。
