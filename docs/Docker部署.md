# Docker 镜像部署

本文使用以下三个镜像，复用仓库根目录的 [compose.yml](../compose.yml)，不在服务器上构建镜像。

| 镜像                               | 用途                                              |
| ---------------------------------- | ------------------------------------------------- |
| `ghcr.io/x-dr/webpulse-db:latest`  | PostgreSQL 数据库                                 |
| `ghcr.io/x-dr/webpulse-web:latest` | 后台静态页面、Nginx、HTTPS 和 API 反向代理        |
| `ghcr.io/x-dr/webpulse-api:latest` | API，以及复用同一镜像的 worker、ops、journal 进程 |

以下主流程适用于**全新安装**：在一台 Linux 服务器上部署 WebPulse，并启用持久化的本机删除清单服务。清单和数据库保存在不同目录，但仍有整机故障风险；需要异机清单时见文末。已有实例请从「升级」开始，保留原数据库、配置和匹配密钥。

## 1. 准备服务器

- 安装 Docker Engine、Docker Compose 插件、Git 和 OpenSSL。首次部署不需要宿主机安装 Node.js 或 pnpm。
- 内存建议至少 2 GiB；数据库和清单目录所在磁盘需要有足够空间。
- 准备域名，例如 `stats.example.com`，将 DNS 指向服务器，放行 TCP 80、443。
- 为该域名签发受浏览器信任的 HTTPS 证书，准备 `fullchain.pem` 和 `privkey.pem`。Web 镜像不会自动申请证书，HTTP 入口会跳转到 HTTPS。
- 本文命令使用 Bash，以 root 或具有相应文件权限和 Docker 权限的管理员执行。示例安装目录为 `/opt/webpulse`。

```bash
docker version
docker compose version
git clone https://github.com/x-dr/WebPulse.git /opt/webpulse
cd /opt/webpulse
```

已有代码目录时直接进入该目录，使用与镜像版本匹配的部署文件。部署需要仓库中的 `compose.yml`、`.env.production.example` 和 `ops/initialize.mjs`；无需执行 `pnpm install`。

## 2. 拉取镜像

```bash
cd /opt/webpulse
docker pull ghcr.io/x-dr/webpulse-db:latest
docker pull ghcr.io/x-dr/webpulse-web:latest
docker pull ghcr.io/x-dr/webpulse-api:latest
```

若镜像尚未发布或当前主机不在镜像支持的平台中，先处理拉取错误。若返回未授权，确认 Package 可见性；私有镜像需先使用具有 `read:packages` 权限的 GitHub 令牌登录 GHCR。密码通过隐藏输入传给标准输入：

```bash
read -r -p 'GitHub 用户名: ' WEBPULSE_GHCR_USER
read -r -s -p 'GitHub 访问令牌: ' WEBPULSE_GHCR_TOKEN
printf '\n'
printf '%s' "$WEBPULSE_GHCR_TOKEN" |
  docker login ghcr.io --username "$WEBPULSE_GHCR_USER" --password-stdin
unset WEBPULSE_GHCR_TOKEN WEBPULSE_GHCR_USER
```

登录后重新拉取。公开镜像无需登录。

## 3. 初始化密钥与目录

只对全新安装执行。初始化工具通过已拉取的 API 镜像运行，将生成三份数据库密码、三份独立 HMAC 密钥、删除密钥对和清单凭据，不向终端输出密钥。

```bash
cd /opt/webpulse
install -d -m 700 secrets
install -d -m 700 -o 1000 -g 1000 tls tls/journal journal-data

docker run --rm --network none --user 0:0 --entrypoint node \
  --mount type=bind,src="$PWD/ops",dst=/ops,readonly \
  --mount type=bind,src="$PWD/secrets",dst=/secrets \
  ghcr.io/x-dr/webpulse-api:latest /ops/initialize.mjs /secrets
```

脚本只创建不存在的文件；以 root 运行时，新密钥设为 UID/GID `1000:1000`、权限 `0400`，供非 root 容器读取。已有安装丢失密钥时应恢复匹配备份，不要重新生成密钥替代旧材料。

**宿主机已有 Nginx + acme.sh 和通配符证书时**，按 [Nginx 与 acme.sh 部署](Nginx与acme.sh部署.md) 复用已安装的证书，并在原续期流程中接入同步脚本；无需重新签发。配套文档还包含回环端口与真实 IP 转发；完成后继续本节的 journal 证书步骤。该方案保留现有宿主机 Nginx 的公网 80/443。

由 Web 容器直接提供公网 HTTPS 时，安装网站证书，将下面两个源路径替换为实际签发文件：

```bash
cd /opt/webpulse
install -m 400 -o 1000 -g 1000 /实际证书目录/fullchain.pem tls/fullchain.pem
install -m 400 -o 1000 -g 1000 /实际证书目录/privkey.pem tls/privkey.pem
```

为仅在 Compose 私网使用的本机 journal 创建独立证书。证书名称必须包含服务名 `journal`，worker 通过该名称校验证书；这份证书不用于浏览器访问后台。

```bash
cd /opt/webpulse
test ! -e tls/journal/privkey.pem &&
  test ! -e tls/journal/fullchain.pem &&
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
    -subj '/CN=journal' -addext 'subjectAltName=DNS:journal' \
    -keyout tls/journal/privkey.pem -out tls/journal/fullchain.pem

chown 1000:1000 tls/journal/fullchain.pem tls/journal/privkey.pem
chmod 400 tls/journal/fullchain.pem tls/journal/privkey.pem
```

存在证书时上面的生成命令不会覆盖它。保留 `secrets/` 和 `journal-data/`；密钥、证书及备份不应提交到 Git。

## 4. 配置 Compose 环境

首次复制配置文件，已有文件时保留：

```bash
cd /opt/webpulse
test -f .env.production || install -m 600 .env.production.example .env.production
```

编辑 `.env.production`，将内容设置为下列配置，并替换实际域名：

```dotenv
WEBPULSE_DOMAIN=stats.example.com
ADMIN_ORIGIN=https://stats.example.com
DB_NAME=webpulse

WEBPULSE_DB_IMAGE=ghcr.io/x-dr/webpulse-db:latest
WEBPULSE_WEB_IMAGE=ghcr.io/x-dr/webpulse-web:latest
WEBPULSE_API_IMAGE=ghcr.io/x-dr/webpulse-api:latest

SECRET_DIR=./secrets
TLS_DIR=./tls
DELETION_JOURNAL_URL=https://journal:8443
JOURNAL_CA_FILE=./tls/journal/fullchain.pem
JOURNAL_DATA_DIR=./journal-data
JOURNAL_TLS_DIR=./tls/journal

WEB_BIND_IP=0.0.0.0
HTTP_PORT=80
HTTPS_PORT=443
PRIVATE_SUBNET=172.30.88.0/24
WEB_PRIVATE_IP=172.30.88.10
API_PRIVATE_IP=172.30.88.20
DB_PRIVATE_IP=172.30.88.30
```

`WEBPULSE_DOMAIN` 只填主机名；`ADMIN_ORIGIN` 必须与浏览器访问的 HTTPS Origin 一致，不带路径。默认私网段若与宿主机、VPN 或其他 Docker 网络冲突，需同时修改网段及三个固定地址。

上面配置用于 Web 容器直接提供公网 HTTPS，将网站端口映射为宿主机 `80 → 8080`、`443 → 8443`；数据库、API 和本机 journal 不发布宿主机端口。生产配置要求 HTTPS，不能直接通过服务器 IP 和 HTTP 完成登录。宿主机 Nginx 方案改用 `WEB_BIND_IP=127.0.0.1`、`HTTP_PORT=18080`、`HTTPS_PORT=18443`，其余设置见 [配套文档](Nginx与acme.sh部署.md)。镜像内的 8080 入口只负责 HTTPS 跳转。

检查配置，不输出环境展开内容：

```bash
cd /opt/webpulse
docker compose --env-file .env.production -f compose.yml \
  --profile local-journal config --quiet
```

## 5. 初始化数据库和清单

下列命令按顺序执行，任一步失败先排查，不继续开放服务。`up` 使用 `--no-build --pull never`；`run` 使用 `--no-deps --pull never`，其目标 ops/journal 本身没有构建配置，只使用前面已拉取的镜像。

```bash
cd /opt/webpulse

# 启动数据库，等待健康检查通过。
docker compose --env-file .env.production -f compose.yml \
  up -d --no-build --pull never --wait db

# 显式执行迁移，并准备 API/worker 的独立数据库角色。
docker compose --env-file .env.production -f compose.yml \
  run --rm -T --no-deps --pull never ops node dist/cli.js database:prepare

# 首次建立持久化清单；不要在既有清单丢失时创建空清单替代历史。
docker compose --env-file .env.production -f compose.yml --profile local-journal \
  run --rm -T --no-deps --pull never journal node dist/cli.js journal:init

docker compose --env-file .env.production -f compose.yml --profile local-journal \
  up -d --no-build --pull never journal
```

API 启动不会自动迁移。`database:prepare` 同时处理迁移与授权，不能仅用启动 API 替代。journal 也需要先显式初始化，再启动服务。

## 6. 创建管理员并启动

没有默认管理员账号。下面创建用户名 `admin`，密码通过隐藏输入传入，不放在命令参数中；密码长度为 12–256 字节。重复创建同名账号会失败，不会重置旧密码。

```bash
cd /opt/webpulse
read -r -s -p '管理员密码（至少 12 字符）: ' WEBPULSE_NEW_ADMIN_PASSWORD
printf '\n'
printf '%s' "$WEBPULSE_NEW_ADMIN_PASSWORD" |
  docker compose --env-file .env.production -f compose.yml \
    run --rm -T --no-deps --pull never ops node dist/cli.js admin:create admin
unset WEBPULSE_NEW_ADMIN_PASSWORD
```

确认提示 `Administrator created.` 后启动：

```bash
cd /opt/webpulse
docker compose --env-file .env.production -f compose.yml \
  up -d --no-build --pull never --wait api worker web

docker compose --env-file .env.production -f compose.yml --profile local-journal ps
```

打开 `https://stats.example.com`，使用刚创建的账号登录，创建站点，并按设置页生成的接入代码部署 SDK。SDK 要求明确同意，且遵守 GPC/DNT；安装后未立即产生数据时，先检查接入与同意状态。

## 7. 部署检查与排错

```bash
cd /opt/webpulse

# 在 API 容器内部验证就绪状态。
docker compose --env-file .env.production -f compose.yml exec -T api \
  node -e 'fetch("http://127.0.0.1:3000/api/v1/health/ready").then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))'

# 查看各进程日志，包括复用 API 镜像的 worker 和 journal。
docker compose --env-file .env.production -f compose.yml --profile local-journal \
  logs --tail=100 db api worker web journal

# 从可解析域名的客户端检查网站证书、后台和 SDK。
curl -fsS -o /dev/null https://stats.example.com/
curl -fsS -o /dev/null https://stats.example.com/tracker.js
```

就绪检查应返回 `200`。Web 会屏蔽公网 `/api/v1/health/`，通过域名访问该健康路径得到 404 是预期行为。

| 现象                          | 检查项                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `pull` 返回未授权或找不到镜像 | 镜像是否发布、Package 可见性、GHCR 登录与平台支持                                             |
| API 启动失败或就绪检查 503    | `database:prepare` 是否成功，数据库凭据及密钥是否匹配，是否存在尚未验证的恢复闸门             |
| Web 启动失败                  | 域名格式、证书文件名、UID 1000 是否能读取证书和私钥                                           |
| 登录或写操作失败              | 使用 HTTPS；浏览器 Origin 与 `ADMIN_ORIGIN` 一致；检查 cookie 和系统时间                      |
| 删除任务停在清单确认阶段      | journal 是否已初始化并运行，证书是否过期，CA/服务名是否匹配，清单目录是否可写，token 是否一致 |
| 访问记录显示代理 IP           | 检查真实代理链；默认配置只信任固定 Web 容器，额外 CDN/代理需明确配置并验证                    |

worker 和 journal 未配置 Docker 健康探针；`ps` 显示 Running 只证明进程在运行。还应检查日志、站点采集和报表行为，按需验证维护任务。不要通过关闭证书校验、重新生成密钥或清空清单来绕过错误。

## 8. 升级与数据保留

`latest` 会随发布变化。升级前记录三个当前镜像的 digest，保留 `.env.production`、匹配密钥和完整清单，并完成数据库加密备份及恢复演练。三个镜像应来自同一批发布；长期运行可将配置改为工作流摘要中的固定 digest。备份工具需要宿主机 Node.js 24，具体命令见 [备份与确认销毁](M4实时与部署.md#备份与确认销毁)，恢复见 [隔离恢复](M4实时与部署.md#隔离恢复)。

以下步骤仅适用于已使用当前 PostgreSQL 17 Alpine 数据库布局的实例。已有 Bookworm 数据目录或 PostgreSQL 大版本变化时，应先逻辑导出，在新卷恢复并验证，不能直接把原卷挂到新镜像。

完成备份后，在维护窗口执行：

```bash
cd /opt/webpulse
docker compose --env-file .env.production -f compose.yml pull api web db

docker compose --env-file .env.production -f compose.yml --profile local-journal \
  stop web api worker journal

docker compose --env-file .env.production -f compose.yml \
  up -d --no-build --pull never --wait db

docker compose --env-file .env.production -f compose.yml --profile local-journal \
  up -d --no-build --pull never journal

docker compose --env-file .env.production -f compose.yml \
  run --rm -T --no-deps --pull never ops node dist/cli.js database:prepare

docker compose --env-file .env.production -f compose.yml \
  up -d --no-build --pull never --wait api worker web

docker compose --env-file .env.production -f compose.yml --profile local-journal ps
```

升级不再运行密钥生成、`journal:init` 或管理员创建。迁移失败时保持入口关闭；已执行迁移后，不应仅换回旧镜像尝试回滚，应按匹配备份进行隔离恢复和验证。

宿主机 Nginx + acme.sh 方案在原续期流程中调用 [证书同步脚本](Nginx与acme.sh部署.md#复用现有通配符证书)，同步共享证书并重载 Web 容器。手动安装网站证书时，续期后将新文件安装到 `tls/`，保持 UID 1000 可读，然后重新加载容器 Nginx：

```bash
cd /opt/webpulse
docker compose --env-file .env.production -f compose.yml exec web \
  nginx -c /tmp/nginx.conf -s reload
```

本机 journal 证书到期前也需续期，更新相应 CA 文件，并重建 journal、worker；后续 ops 容器会读取新的 CA。重建时继续使用同一清单目录和密钥。

暂停全部进程并保留数据：

```bash
cd /opt/webpulse
docker compose --env-file .env.production -f compose.yml --profile local-journal stop
```

数据库保存在命名卷 `webpulse_pg_data`，删除清单在 `journal-data/`，匹配密钥在 `secrets/`。若修改 Compose 项目名，卷名前缀也会改变。不要执行 `down -v` 或删除这些目录作为升级、重启或排错手段。

## 9. 使用异机删除清单

需要隔离整机故障时，将 journal 放到另一台主机或独立存储故障域。该服务复用 `ghcr.io/x-dr/webpulse-api:latest`，使用仓库的 [compose.journal.yml](../compose.journal.yml)。

- 清单主机只接收匹配的 `journal_token.txt` 和 `journal_signing_key.txt`，不复制数据库密码、身份 HMAC 或删除私钥；通过安全通道传递文件。
- 为清单的真实域名配置证书、可写持久化目录和 UID 1000 文件权限；首次部署先执行 `journal:init`，再启动服务。已有清单必须迁移完整历史。
- 清单主机配置 `WEBPULSE_API_IMAGE`、`SECRET_DIR`、`JOURNAL_DATA_DIR`、`JOURNAL_TLS_DIR` 和 `JOURNAL_BIND_IP`，使用 `compose.journal.yml` 操作。它发布 TCP 8443，防火墙仅放行应用主机。
- 应用主机将 `DELETION_JOURNAL_URL` 改为实际 HTTPS 地址，`JOURNAL_CA_FILE` 改为对应可信 CA PEM；使用公共 CA 时也要提供实际 CA 文件。停止本机 journal，并在后续命令中省略 `--profile local-journal`，保留原清单以便核对。
- 应用主机的 worker 和运维进程需能够访问该地址；独立 journal 与应用使用匹配版本、token 和签名材料。

独立服务的初始化与启动命令、备份恢复要求见 [独立删除清单](M4实时与部署.md#独立删除清单)。

本文按当前仓库配置编写。文档校验不代表三个 GHCR 镜像已拉取验证，也不代表目标 VPS、实际证书或公网链路已完成验收。
