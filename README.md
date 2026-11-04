# WebPulse · 网站脉搏

轻量、自托管的网站流量统计系统。当前已完成工程初始化和 M0 设计冻结，可运行前后端、检查数据库就绪状态并执行版本化迁移。**登录、站点管理、采集、报表和实时统计尚未实现。**

采用 Node.js 24、pnpm 10、Fastify 5、TypeScript 7.0.2 strict、React 19、Ant Design 6、TanStack Query 与 PostgreSQL 17。ECharts、路由和业务插件在对应模块实施时引入。实际版本以各 `package.json` 与 `pnpm-lock.yaml` 为准。

## 本地启动

准备 Node.js `24.18.0`（见 `.nvmrc`）、pnpm `10.20.0` 和 Docker Compose。以下命令在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
test -f .env || cp .env.example .env
# 新建 .env 时，填写非空的 DB_PASSWORD；本次初始化已生成本地随机密码。
docker compose -f compose.dev.yml up -d --wait db
pnpm db:migrate
pnpm dev
```

访问 <http://127.0.0.1:5173>。API 默认监听 `127.0.0.1:3000`，Vite 将 `/api` 转发给 API。修改根目录 `.env` 的 `PORT` 后，重启开发服务；前端代理会使用同一端口。`pnpm dev` 先构建公共包，随后同时启动 API 与前端；编辑公共契约后另行运行 `pnpm --filter @webpulse/shared build`。

根目录 `.env` 由后端按文件位置显式加载，与运行目录无关；已有进程环境变量优先。文件已被 Git 忽略，本次生成时权限为 `0600`。不要将密码放入 `VITE_` 变量。连接已有数据库时可通过 `DB_PASSWORD_FILE` 读取密码文件，不能同时设置 `DB_PASSWORD`。本地 Compose 使用 `.env` 中的 `DB_PASSWORD`；文件密码方式用于外部数据库连接。

Compose 只启动本项目的开发数据库，端口仅绑定 loopback，数据保存在 `webpulse-dev_pg_dev_data` 卷。它使用单一开发角色，**不是生产分权配置**。原生产参考仍在 `design/reference/`，其中 `database:prepare`、`admin:create`、TLS 与业务服务将在 M4 前补齐，不应直接当作当前可用部署流程。

## 健康与迁移

```bash
curl -fsS http://127.0.0.1:3000/api/v1/health/live
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

- `live`：进程存活返回 200，不依赖数据库。
- `ready`：数据库连通，且全部迁移名称和 SHA-256 校验和匹配时返回 200；未迁移、连接失败、迁移被修改或版本不匹配时返回 503。
- 启动 API 不会自动执行迁移。环境参数非法或缺少数据库密码时立即启动失败。
- `pnpm db:migrate` 使用单连接事务与 PostgreSQL advisory lock；整批失败回滚，重复执行无新增迁移。已应用 SQL 不应修改，后续增加 `002_*.sql`。
- 应用迁移位于 `apps/server/migrations/`；`001_init.sql` 保留参考结构的 16 张业务表，由迁移器接管事务，另外维护 `schema_migrations`。原评审问题仍须在业务实现前处理。

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
```

`typecheck` 和构建使用 TypeScript 7.0.2 的原生 `tsc`；`lint` 使用 Oxlint 1.91.0，任何警告或错误均阻止通过；`format:check` 继续使用 Prettier。项目不再依赖 ESLint、typescript-eslint 或 TS6 兼容包。

规则集中在 `.oxlintrc.json`，沿用原有推荐规则及目录排除。显式启用尚处实验阶段的 `no-undef` 和 `no-useless-assignment`，避免迁移时遗漏既有检查；TS/TSX 的 `no-undef` 仍交由编译器处理。`no-dupe-args`、`no-octal` 由 ESM 严格模式语法检查覆盖。浏览器目录使用 `browser` 环境，Node 环境和原有覆盖关系保留。当前未启用依赖类型信息的 lint 规则；类型校验仍由 `pnpm typecheck` 执行。

TypeScript 7 和 Oxlint 通过平台相关的可选依赖提供原生程序，安装时不要禁用 optional dependencies；不同操作系统/架构应使用锁文件重新安装依赖。编辑器的 TypeScript 服务与 Oxlint 扩展需分别配置，命令行升级不会自动更改编辑器设置。

`test` 检查配置、健康接口和已结束会话指标；`test:integration` 用内存 PGlite 检查迁移及 M0 查询设计探针，不需要 Docker。`test:postgres` 显式连接 `.env` 指定的开发库，在随机生成的独立 schema 中验证迁移并发、回滚、就绪检查及 M0 站点锁协议，结束后只清理该测试 schema；**仅在开发数据库执行**。

`test:e2e` 自动启动 Vite，使用模拟健康响应验证 1440px/390px 下的错误、重试、键盘和响应式行为，不代表生产端到端验证。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定已有 Chromium。浏览器、真实 PostgreSQL 和静态检查的实际结果见 [初始化验证记录](docs/初始化验证记录.md)。

构建产物分别位于 `apps/server/dist`、`apps/dashboard/dist`、`packages/shared/dist` 和 `packages/tracker/dist`。`tracker.js` 当前只有构建入口，不会发送数据，不可当作已实现的 SDK 安装。

停止本地数据库（保留数据）：

```bash
docker compose -f compose.dev.yml stop db
```

## 项目结构与下一阶段

| 路径               | 职责                                             |
| ------------------ | ------------------------------------------------ |
| `apps/server`      | API 工厂、运行入口、配置、数据库、迁移与运维 CLI |
| `apps/dashboard`   | React 入口、主题和连接状态页面                   |
| `packages/shared`  | 前后端公共 Schema、类型与基础指标定义            |
| `packages/tracker` | 无框架采集 SDK 的构建入口                        |
| `packages/config`  | 公共 TypeScript 配置                             |
| `tests`            | 单元、PGlite、真实 PostgreSQL 与浏览器验证       |
| `design`           | 原技术设计、评审报告与参考快照                   |
| `docs`             | 实施进度与当前验证证据                           |

M0 已冻结 R01–R07 的统计、并发及删除恢复契约，明确 R08–R14 的后续落点。下一阶段为 M1 采集链路（管理员/站点基础、同意、清洗、PV、互动、心跳和会话）。详见 [M0 设计冻结与验收](docs/M0设计冻结与验收.md)、[实施计划与进度](docs/实施计划与进度.md)及 [设计评审](design/WebPulse-技术文档评审与优化建议.md)。
