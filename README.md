# WebPulse · 网站脉搏

轻量、自托管的网站流量统计系统。已实现 M0–M4，并交付 M5 本机安全加固与常规回归；压测按用户要求停止，VPS 验收另行执行。数据库加固镜像已在本机通过 HIGH/CRITICAL 扫描，修复后的完整线上发布仍待验证。生产删除必须取得独立加密清单的持久化确认；HTTP 服务只持删除公钥，独立维护进程持私钥。后台支持登录、总览、实时、来源、页面、访客及站点设置。详细证据与边界见 [M5 验收](docs/M5加固与验收.md)。

采用 Node.js 24、pnpm 10、Fastify 5、TypeScript 7.0.2 strict、React 19、Ant Design 6、TanStack Query 与 PostgreSQL 17。ECharts 6 按需懒加载；报表筛选与页面路由共享 URL。实际版本以各 `package.json` 与 `pnpm-lock.yaml` 为准。

使用 `ghcr.io/x-dr/webpulse-db:latest`、`ghcr.io/x-dr/webpulse-web:latest` 和 `ghcr.io/x-dr/webpulse-api:latest` 部署，见 [Docker 镜像部署文档](docs/Docker部署.md)，包含首次初始化、HTTPS、管理员创建、升级和数据保留步骤。

宿主机已有 Nginx 和 acme.sh 时，见 [Nginx 与 acme.sh 部署](docs/Nginx与acme.sh部署.md)，复用现有证书签发方式，并配置续期同步、回环端口及真实 IP 转发。

## 本地启动

准备 Node.js `24.18.0`（见 `.nvmrc`）、pnpm `10.20.0` 和 Docker Compose。以下命令在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
test -f .env || cp .env.example .env
# 新建 .env 时，填写非空的 DB_PASSWORD；本次初始化已生成本地随机密码。
docker compose -f compose.dev.yml up -d --wait db
pnpm db:migrate
# 按下方 M1 配置段创建三份独立密钥并补齐 .env，再启动。
# 从旧版 .env 升级时也需要检查这三项，数据库配置完整并不足以启动 API。
pnpm dev
```

访问 <http://127.0.0.1:5173>。API 默认监听 `127.0.0.1:3000`，Vite 将 `/api` 与 `/tracker.js` 转发给 API，使设置页生成的同源接入代码可用于本地开发。修改根目录 `.env` 的 `PORT` 后，重启开发服务；前端代理会使用同一端口。`pnpm dev` 先构建公共包与 SDK，随后同时启动 API 与前端；编辑公共契约或 SDK 后另行重建相关包。

根目录 `.env` 由后端按文件位置显式加载，与运行目录无关；已有进程环境变量优先。文件已被 Git 忽略，本次生成时权限为 `0600`。不要将密码放入 `VITE_` 变量。连接已有数据库时可通过 `DB_PASSWORD_FILE` 读取密码文件，不能同时设置 `DB_PASSWORD`。本地 Compose 使用 `.env` 中的 `DB_PASSWORD`；文件密码方式用于外部数据库连接。

`compose.dev.yml` 只启动开发数据库，端口仅绑定 loopback，数据保存在 `webpulse-dev_pg_dev_data` 卷，使用单一开发角色。生产使用根目录 `compose.yml`、`.env.production.example` 和 `docker/`，包含显式 `database:prepare`、独立维护角色、TLS 与静态托管；完整步骤见 [M4 部署与恢复](docs/M4实时与部署.md)。`design/reference/` 保留原始设计快照。

## GitHub Actions 镜像构建

[Build Docker images](.github/workflows/docker.yml) 仅手动触发，普通 push、PR 或创建 tag 不会自动发布。在 GitHub 的 **Actions → Build Docker images → Run workflow** 选择源码分支，填写 `version`（如 `0.1.0`、`v0.1.0` 或 `0.1.0-rc.1`），即可构建并推送 `linux/amd64`、`linux/arm64` 的 API/Web/DB 镜像到 GHCR。使用仓库自带的 `GITHUB_TOKEN`，无需配置 Docker Hub 凭据；仓库或组织须允许工作流写入 Packages。

镜像名自动使用小写的 GitHub 仓库路径：例如 `Owner/WebPulse` 会发布 `ghcr.io/owner/webpulse-api:0.1.0`、`ghcr.io/owner/webpulse-web:0.1.0` 和 `ghcr.io/owner/webpulse-db:0.1.0`。每个镜像还包含 `sha-<完整提交 SHA>` 标签；勾选 `latest` 才会额外更新该标签，预发布版本不能勾选。构建完成后，任务摘要提供镜像 digest 和拉取命令；生产优先按 digest 固定镜像。

发布前会调用 [Acceptance and security](.github/workflows/acceptance.yml)，执行常规回归、依赖审计及全部三个镜像的双架构扫描；数据库镜像另验证初始化和进程降权，任一步失败就阻止发布。原 Bookworm 数据库在 [线上运行](https://github.com/x-dr/WebPulse/actions/runs/42245329276) 中因 75 条 HIGH、4 条 CRITICAL 被阻断。现已基于固定摘要的 PostgreSQL 17.11 Alpine 3.24 构建 DB 镜像，以 `su-exec` 替换带旧 Go 运行时的 `gosu`，保持严格扫描规则；本机 amd64 结果及线上验证边界见 [修复记录](docs/verification/database-image-fix.json)。工作流未包含压测。

首次部署须把 `.env.production` 的 `WEBPULSE_API_IMAGE`、`WEBPULSE_WEB_IMAGE`、`WEBPULSE_DB_IMAGE` 设置为本次三个产物，再按 [部署文档](docs/M4实时与部署.md#github-actions-构建与拉取) 拉取并部署。DB 镜像用于新建数据库；已有 Bookworm 数据不能直接挂载到 Alpine，须先备份并逻辑导出到新数据库后验证。本机 `compose.dev.yml` 继续保留原 Bookworm 和开发数据卷。

工作流文件须先进入默认分支，GitHub 才会显示手动运行入口。首次发布后检查三个 Package 的可见性和仓库访问权限；公开拉取须将 Package 设为 Public，私有镜像须先在目标主机登录 GHCR。添加工作流本身不代表镜像已在线发布或通过 ARM64 运行验收。

## 健康与迁移

```bash
curl -fsS http://127.0.0.1:3000/api/v1/health/live
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

- `live`：进程存活返回 200，不依赖数据库。
- `ready`：数据库连通、迁移名称/校验和匹配、恢复闸门允许开放时返回 200；未迁移、连接失败、版本不匹配或恢复未验证时返回 503。
- 启动 API 不会自动执行迁移。环境参数非法或缺少数据库密码时立即启动失败。
- 启动日志会提示缺失或非法的配置名（例如 `Missing or invalid VISITOR_HMAC_KEY`），不输出配置值。前端代理出现 `ECONNREFUSED 127.0.0.1:3000` 时先检查后端启动日志；缺少 HMAC 配置按下方步骤创建首次密钥或接回原有密钥，随后重启 `pnpm dev`。根目录 `.env` 修改不会触发 Node 自动重启。
- `pnpm db:migrate` 使用单连接事务与 PostgreSQL advisory lock；整批失败回滚，重复执行无新增迁移。已应用 SQL 不应修改，后续增加新编号 SQL；M1 新增 `002_collection.sql`，M2 新增 `003_reporting.sql`，M4 新增 `004_deployment.sql`。
- 应用迁移位于 `apps/server/migrations/`；`001_init.sql` 保留参考结构的 16 张业务表，由迁移器接管事务，另外维护 `schema_migrations`。002 补齐引用索引、规则快照、活动顺序、身份 epoch 与采集事实字段；003 补齐覆盖/缺口、汇总版本、冻结扫描和独立删除任务。

## 验证命令

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:postgres
pnpm build
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
pnpm test:sdk
```

`typecheck` 和构建使用 TypeScript 7.0.2 的原生 `tsc`；`lint` 使用 Oxlint 1.91.0，任何警告或错误均阻止通过；`format:check` 继续使用 Prettier。项目不再依赖 ESLint、typescript-eslint 或 TS6 兼容包。

规则集中在 `.oxlintrc.json`，沿用原有推荐规则及目录排除。显式启用尚处实验阶段的 `no-undef` 和 `no-useless-assignment`，避免迁移时遗漏既有检查；TS/TSX 的 `no-undef` 仍交由编译器处理。`no-dupe-args`、`no-octal` 由 ESM 严格模式语法检查覆盖。浏览器目录使用 `browser` 环境，Node 环境和原有覆盖关系保留。当前未启用依赖类型信息的 lint 规则；类型校验仍由 `pnpm typecheck` 执行。

TypeScript 7 和 Oxlint 通过平台相关的可选依赖提供原生程序，安装时不要禁用 optional dependencies；不同操作系统/架构应使用锁文件重新安装依赖。编辑器的 TypeScript 服务与 Oxlint 扩展需分别配置，命令行升级不会自动更改编辑器设置。

`test` 检查配置、健康、指标、清洗、HMAC、资源限额、DST 和加密边界；`test:integration` 用内存 PGlite 检查迁移、既有 M1 升级及 M0 设计探针，不需要 Docker。`test:postgres` 显式连接 `.env` 指定的开发库，在随机独立 schema 中验证采集/并发、统计/聚合、冻结/清理、删除/重建和索引计划，结束后只清理该测试 schema；**仅在开发数据库执行**。

`test:e2e` 自动启动 Vite，验证模拟后台 API 下的登录、筛选、错误/重试、设置保护和 1440/1024/768/390px 响应式；另外从构建产物启动真实本机 HTTP + 随机独立 PostgreSQL schema，验证完整后台联调。执行前先 `pnpm build`；也只应连接开发数据库。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定已有 Chromium。浏览器、真实 PostgreSQL 和静态检查的实际结果见 [初始化验证记录](docs/初始化验证记录.md)。

构建产物分别位于 `apps/server/dist`、`apps/dashboard/dist`、`packages/shared/dist` 和 `packages/tracker/dist`。`tracker.js` 已可接入，详见 [SDK 接入与隐私说明](packages/tracker/README.md)。`pnpm test:sdk` 使用 Chromium、Firefox、WebKit，包含模拟传输的隐私/导航场景和真实本地 HTTP + 独立 PostgreSQL schema 的完整链路；也只应连接开发数据库。

停止本地数据库（保留数据）：

```bash
docker compose -f compose.dev.yml stop db
```

## 项目结构与下一阶段

| 路径               | 职责                                       |
| ------------------ | ------------------------------------------ |
| `apps/server`      | API、认证、采集、报表、维护、迁移与 CLI    |
| `apps/dashboard`   | 米色后台、登录、报表、站点设置与图表       |
| `packages/shared`  | 公共 Schema、类型、隐私清洗与指标定义      |
| `packages/tracker` | 无框架采集 SDK、身份、生命周期与传输       |
| `packages/config`  | 公共 TypeScript 配置                       |
| `tests`            | 单元、PGlite、真实 PostgreSQL 与浏览器验证 |
| `design`           | 原技术设计、评审报告与参考快照             |
| `docs`             | 实施进度与当前验证证据                     |

M1 的并发/隐私证据见 [M1 采集链路与验收](docs/M1采集链路与验收.md)；统计接口、重算冻结、清理预览、删除闸门与运维命令见 [M2 查询聚合与验收](docs/M2查询聚合与验收.md)。后台页面见 [M3 米色后台与验收](docs/M3米色后台与验收.md)；SSE、生产分权、独立清单及备份恢复见 [M4 实时与部署](docs/M4实时与部署.md)。**M5 本机加固与回归已交付，完整生产验收未放行**，详见 [M5 验收](docs/M5加固与验收.md)及 [实施计划与进度](docs/实施计划与进度.md)。

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

开发环境默认 `trustProxy=false`，使用 socket 地址生成站点化 IP HMAC。生产 Compose 只信任固定 Nginx 地址，由 Nginx 覆盖 forwarded 头。保留策略通过独立预览/确认接口变更，清理不越过实际连续冻结水位；扩大窗口不会恢复已清理数据。本地可选 `DELETION_ENCRYPTION_KEY_FILE`，缺少独立 journal 时仍停在确认阶段；生产使用分离的 RSA 公私钥、HTTPS journal 和独立 worker。恢复须完成全清单重放与隐私校验，不能直接开放旧备份。M4 验收只操作测试卷/随机 schema，未迁移默认开发 schema 或删除既有站点数据。

## 真实 IP 访问记录

执行 `pnpm db:migrate` 应用 `005_visit_ip.sql` 并重启 API/后台后，新接纳的访问事件会将规范化的 IPv4/IPv6 写入 `events.client_ip`。后台「访客分析 → 访问记录」按站点及日期分页查看；「实时访问 → 最近页面」展示最近 15 分钟内的 20 条访问及 IP。历史 HMAC 无法还原原始 IP，旧记录显示“未记录”。独立 IP 指标仍使用原有 HMAC 去重。

原始 IP 随事件明细保留（默认 30 日，可配置 7–30 日），随站点/访客删除任务清除，也会包含在数据库备份中。SDK 仍要求同意并遵守 GPC/DNT；采集接口不接受客户端提交 IP 字段。访问日志继续使用现有最小字段。

有反向代理时，将 API 的 `TRUSTED_PROXY_CIDRS` 设置为实际代理的固定 IP/CIDR，并确保最外层受信任入口覆写转发头。默认仅使用 socket 地址，不信任任意 `X-Forwarded-For` 或 `X-Real-IP`；若代理未配置可信链，保存的会是代理地址。生产 Compose 的 Nginx 直连公网配置已覆盖转发头；CDN/额外代理需要按实际链路配置。
