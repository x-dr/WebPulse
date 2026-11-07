# 宿主机 Nginx 与 acme.sh 部署

适用于宿主机已有 Nginx、acme.sh 和已签发通配符证书的情况。直接复用已有证书及续期流程。本文按 Linux、root 管理的 Nginx/systemd 服务、安装目录 `/opt/webpulse`、示例域名 `stats.example.com` 编写；将域名和已有证书路径替换为实际值。

访问链路为：浏览器 → 宿主机 Nginx 的 HTTPS 443 → `https://127.0.0.1:18443` → Web 容器 → API。现有 Web 镜像的 HTTP 8080 入口只负责 HTTPS 跳转，所以回源使用 HTTPS。

先按 [Docker 部署](Docker部署.md) 完成镜像拉取、密钥和目录初始化。网站证书使用下面的流程替代手动复制；本机 journal 的独立证书仍按原文创建。

## 复用现有通配符证书

这里按“通用证书”指 `*.example.com` 通配符证书处理；它可以用于 `stats.example.com`。实际证书也可能包含多个域名，以证书的 SAN 为准。`*.example.com` 本身不覆盖 `example.com` 或 `stats.sub.example.com`，匹配规则见 [RFC 9525](https://www.rfc-editor.org/rfc/rfc9525.html#section-6.3)。

直接使用宿主机 Nginx 当前 `ssl_certificate` 和 `ssl_certificate_key` 指向的完整证书链及私钥，不重新签发，也不为 WebPulse 另建一份 acme.sh 证书记录。下面假设现有路径为 `/etc/nginx/ssl/example.com/fullchain.pem` 和 `/etc/nginx/ssl/example.com/privkey.pem`，请替换为实际路径；使用已经安装好的稳定文件，不直接挂载 acme.sh 内部工作目录。

先在应用目录创建同步脚本。现有 Web 镜像内部也使用 TLS，需要把同一份证书复制给 UID 1000 的 Web 容器。脚本只写入应用自己的 `tls/`，保留共享源证书的权限，并重载已运行的 Web 容器。

```bash
cd /opt/webpulse
cat > ops/sync-site-tls.sh <<'SH'
#!/bin/sh
set -eu
cd /opt/webpulse
install -d -m 700 -o 1000 -g 1000 tls
install -m 400 -o 1000 -g 1000 \
  /etc/nginx/ssl/example.com/fullchain.pem tls/fullchain.pem
install -m 400 -o 1000 -g 1000 \
  /etc/nginx/ssl/example.com/privkey.pem tls/privkey.pem

# 首次安装时可能尚未配置 Compose 或启动 Web。
if [ -f .env.production ]; then
  WEBPULSE_WEB_CONTAINER_ID=$(docker compose --env-file .env.production -f compose.yml \
    ps --status running -q web)
  if [ -n "$WEBPULSE_WEB_CONTAINER_ID" ]; then
    docker compose --env-file .env.production -f compose.yml exec -T web \
      nginx -c /tmp/nginx.conf -s reload
  fi
fi
SH
chmod 700 ops/sync-site-tls.sh
/bin/sh ops/sync-site-tls.sh
```

这一步完成首次同步。后续在这张共享证书**已有的续期成功脚本**中，保留原有安装、宿主机 Nginx 重载及其他站点操作，在末尾追加：

```bash
/bin/sh /opt/webpulse/ops/sync-site-tls.sh
```

如果原来直接使用 `--reloadcmd 'nginx -t && systemctl reload nginx'`，合并后的内容可为 `nginx -t && systemctl reload nginx && /bin/sh /opt/webpulse/ops/sync-site-tls.sh`。按现有共享证书记录和实际回调方式接入，不用针对 `stats.example.com` 的新安装命令覆盖共享证书的安装路径或原有回调。acme.sh 的安装与重载机制见 [官方说明](https://github.com/acmesh-official/acme.sh#3-install-the-certificate-to-apachenginx)。

续期回调需要具备读取源私钥、写入应用目录和执行 Docker 的权限。网站通配符证书仅用于网站入口与 Web 回源；本机 `journal` 服务名不在它的覆盖范围内，继续使用主文档中的独立 journal 证书。

## 调整容器端口与真实 IP

在 `.env.production` 中保留实际 HTTPS Origin，并把 Web 宿主机端口改为回环地址：

```dotenv
WEBPULSE_DOMAIN=stats.example.com
ADMIN_ORIGIN=https://stats.example.com
WEB_BIND_IP=127.0.0.1
HTTP_PORT=18080
HTTPS_PORT=18443
```

这样宿主机 Nginx 继续使用公网 80/443，容器端口仅供本机访问。不要把公网 Nginx 的 upstream 指向 HTTP 18080，否则会不断跳转回 HTTPS。

还需要让容器内 Nginx 识别最外层传入的真实 IP。现有模板会使用 `$remote_addr` 覆写转发头，直接再加一层代理会把访客记为 Docker 网关。以下操作仅修改部署主机上的配置，不需要重建镜像。

复制当前模板，并在 `http` 块内插入对宿主机网关的精确信任：

```bash
cd /opt/webpulse
test ! -e docker/nginx.host-proxy.conf.template &&
  sed '/^http {$/a\
  set_real_ip_from 172.30.88.1;\
  real_ip_header X-Forwarded-For;\
  real_ip_recursive off;
' docker/nginx.conf.template > docker/nginx.host-proxy.conf.template
chmod 644 docker/nginx.host-proxy.conf.template
```

在部署主机的 `compose.yml` 中，给 **web 服务**的 `volumes` 增加模板挂载，保留原有 TLS 挂载：

```yaml
volumes:
  - '${TLS_DIR:-./tls}:/etc/nginx/tls:ro'
  - './docker/nginx.host-proxy.conf.template:/etc/nginx/webpulse.conf.template:ro'
```

将同一文件底部 **networks.private** 的 IPAM 配置改为显式网关：

```yaml
networks:
  private:
    ipam:
      config:
        - subnet: '${PRIVATE_SUBNET:-172.30.88.0/24}'
          gateway: 172.30.88.1
```

以上地址对应主文档的默认网段。自定义网段时同步调整网关、模板里的 `set_real_ip_from` 和三个容器地址。已有运行网络先用 `docker network inspect webpulse_private` 核对网关，沿用实际值；不要为改网关删除数据库卷。API 继续只信任 Web 容器的固定地址。

模板只信任这个网关，宿主机入口在下一节覆写客户端传入的转发头。不要把信任范围放宽到全部地址。更多语义见 [Nginx Real IP 模块](https://nginx.org/en/docs/http/ngx_http_realip_module.html)。

完成后继续 [Docker 部署](Docker部署.md) 的配置检查、数据库/journal 初始化和管理员创建，再启动 api、worker、web。已有 Web 容器需要重建以应用端口和挂载；证书续期本身只需要重载。

```bash
cd /opt/webpulse
docker compose --env-file .env.production -f compose.yml \
  --profile local-journal config --quiet
```

## 配置宿主机 Nginx

只修改 WebPulse 域名对应的站点配置，保留其他站点。下面示例使用 `/etc/nginx/conf.d/webpulse.conf`，系统需在 `http` 块中包含该目录；若使用 `sites-enabled`，放到实际启用的位置。

示例假设 Debian/Ubuntu 的 CA 文件位于 `/etc/ssl/certs/ca-certificates.crt`。其他发行版使用实际系统 CA 文件。现有通配符证书继续按原方式验证和续期，本示例不新增 ACME 验证目录。

```nginx
server {
    listen 80;
    server_name stats.example.com;

    location / {
        return 308 https://stats.example.com$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name stats.example.com;
    ssl_certificate /etc/nginx/ssl/example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 16k;

    location / {
        proxy_pass https://127.0.0.1:18443;
        proxy_http_version 1.1;
        proxy_set_header Host stats.example.com;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Forwarded "";
        proxy_set_header Connection "";

        proxy_ssl_server_name on;
        proxy_ssl_name stats.example.com;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        proxy_ssl_verify on;
        proxy_ssl_verify_depth 3;

        # 实时 SSE 保持流式传输。
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 75s;
        gzip off;
    }
}
```

TLS 回源需要发送正确 SNI，并按域名验证证书；以上配置保留了这两项校验。参数依据见 [Nginx HTTPS 代理配置](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ssl_name)。

在启动 Web 容器并确认内部证书可用后，检查宿主机配置并重载：

```bash
nginx -t && systemctl reload nginx
```

如果已有 CDN 或其他代理位于宿主机 Nginx 之前，需要先在宿主机按实际代理地址恢复真实 IP；这里默认宿主机 Nginx 直接面对客户端。

## 验证与后续维护

```bash
cd /opt/webpulse

# 验证回源证书的域名与信任链，不跳过证书校验。
curl --resolve stats.example.com:18443:127.0.0.1 \
  -fsS -o /dev/null https://stats.example.com:18443/

# 检查容器配置，并确认真实 IP 模块已编译。
docker compose --env-file .env.production -f compose.yml exec -T web \
  nginx -c /tmp/nginx.conf -t
docker compose --env-file .env.production -f compose.yml exec -T web nginx -V

# 从外部客户端检查最终入口。
curl -fsS -o /dev/null https://stats.example.com/
curl -fsS -o /dev/null https://stats.example.com/tracker.js
```

`nginx -V` 应包含 `--with-http_realip_module`。从外部客户端产生一次经同意的 SDK 访问，再在后台访问记录中对比实际出口 IP；仅查看宿主机 Nginx 日志不足以证明 API 收到正确 IP。实时页还需检查 SSE 能持续接收更新。

续期后可运行同步脚本并重新检查公网证书；不要用 `--force` 反复申请来测试脚本。网站证书与本机 journal 证书是两套材料，后者仍按主文档维护。

升级前备份部署主机上修改过的 `compose.yml`、派生模板和同步脚本，保留与镜像匹配的源模板；更新部署文件时重新核对差异。数据库、匹配业务密钥和清单的备份恢复要求仍按主文档执行。

本文只提供部署配置与操作步骤，不代表已在目标服务器签发证书、重载 Nginx 或验证公网与真实 IP 链路。
