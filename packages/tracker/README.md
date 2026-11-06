# WebPulse Tracker

M1 已实现无框架浏览器 SDK。构建 `pnpm --filter @webpulse/tracker build` 后由 API 的 `/tracker.js` 提供；先构建公共包，或在根目录运行 `pnpm build`。

## 接入

在站点 API 创建站点、设置精确 Origin 白名单及规则后，添加脚本：

```html
<script>
  // 只有网站自己的同意管理器已确认同意时才加入此命令。
  window.webpulseQueue = window.webpulseQueue || [];
  if (window.siteAnalyticsConsent === true) {
    window.webpulseQueue.push(['consent', true]);
  }
</script>
<script
  defer
  src="https://stats.example.com/tracker.js"
  data-site-id="替换为创建站点返回的site_id"
  data-consent="required"
></script>
```

也可以在 `webpulse:ready` 后调用 `window.webpulse.consent(true)`。ready 表示 API 已可调用；配置和身份初始化是异步过程。未同意前不请求配置/采集接口、不创建 ID、不读写分析存储。不建议直接使用 `data-consent="granted"`，除非页面已依据实际同意状态生成这个属性。

接口：

- `consent(true)`：检查 GPC/DNT/本地退出偏好，读取公开规则，然后建立本站身份与采集。
- `consent(false)`：取消配置/请求、移除监听、清队列和本站标识。已提交的历史不因此删除。
- `optOut()`：执行撤销并保存本站退出偏好；该偏好会阻止之后的 `consent(true)`。重新选择加入需要网站明确清除此偏好并重载 SDK，不能静默绕过。
- `trackPageView({path?})`：在已初始化且可见的页面显式记录一次访问；适合 `routing_mode=manual`。页面应用自行决定调用边界。
- `destroy()`：停止实例并移除监听，不删除已有标识。重复加载自动脚本复用 `window.webpulse`。

直接使用构建后的 `WebPulse.createTracker({siteId,endpoint,consent?,routingMode?})` 可创建显式实例；不要为同一站点重复实例化。manual 可使用 `await window.webpulse.consent(true)` 等待初始化后，再调用 `trackPageView`；预先放入 `webpulseQueue` 的命令按顺序执行。

自动模式等待同意与首次可见后发送初始 PV。SPA 默认 History 模式，忽略 query/hash；显式 hash 模式以 hash 路径导航，忽略其中 query。站点配置通过 `GET /api/v1/tracker-config/:site_id` 在同意后读取。manual 应先等待 `consent(true)` 的 Promise，再调用 `trackPageView`；未同意时调用不会采集，也不会保存原始 URL。

## 身份、隐私与发送边界

`webpulse:<site_id>:identity` 保存绝对 90 日 `{cid,created_at,expires_at}`；Web Locks 可用时串行首次创建。localStorage 不可用时仅保留内存 ID，不使用 IP/UA 指纹。多个 Origin 各自持有身份，不承诺跨域去重。`webpulse:<site_id>:opt-out` 只记录退出偏好。

SDK 与服务端共享清洗实现：剥离 query/fragment、默认脱敏邮箱/数字/UUID/长标识、排除认证回调等路径；referrer 只发送域名；UTM 默认关闭。未脱敏导航 identity 仅在同意后的内存参与判重，队列只保存清洗后的字段。

点击/按键须可信；滚动须关联最近 1 秒可信 wheel/touchmove。每页最多一次互动，PV 收到 204 后才发送。可见时每 15 秒心跳，发送累计可见毫秒数；服务端按短区间并集合并多标签估计，不把心跳视为互动。

事件最多 20 条/16KiB，2 秒冲刷；内存最多 100 条/2 分钟。429/503/网络失败最多重试 3 次，遵守 Retry-After 并复用 ID；互动单独发送，防止过期错误归到其他页。过期互动丢弃，resume 新 PV 不继承旧互动。fetch 显式使用 `referrerPolicy=no-referrer`；离开时仅在页面 Referrer Policy 明确不传路径时使用 Beacon，否则改用 keepalive fetch，防止 HTTP Referer 附带敏感地址。Beacon 的 true 仅代表浏览器接受排队，不等于服务器已确认；恢复后可用原 ID 获取确认。

CSP 需允许统计域 `script-src` 与 `connect-src`。默认机器人规则排除 Headless UA，浏览器自动化验收的独立测试站点显式关闭该规则。当前浏览器验收为本机 Chrome；未宣称 Firefox/WebKit、真实用户同意管理器或线上域名已经验收。

## 同意接入片段快速测试

仓库根目录运行以下脚本，默认使用 `http://127.0.0.1:5173/tracker.js` 和站点 `site_dfbc69789522255cc21d88d3a4ae07a3`。它使用独立浏览器上下文，检查未同意时无配置/采集请求及分析存储访问、同意后的 PV/可信点击/页面切换/心跳、URL 清洗，以及撤销后的身份清理和停止采集。耗时约 35–45 秒，失败时退出码为 1。

当前 `webpulseQueue` 只在 SDK 初始化时读取。若同意管理器的回调在 SDK 加载后执行，应直接调用 API；可以这样兼容加载前后两种情况：

```js
function onAnalyticsConsentChange(granted) {
  if (window.webpulse) return window.webpulse.consent(granted);
  window.webpulseQueue = window.webpulseQueue || [];
  window.webpulseQueue.push(['consent', granted]);
}
```

先验证本地构建和模拟接口，不需要服务或数据库：

```bash
cd /root/WebPulse
pnpm --filter @webpulse/shared build
pnpm --filter @webpulse/tracker build
node tests/sdk/consent-smoke.mjs --mock
```

真实测试前启动 `pnpm dev`，并在该站点的 Origin 白名单添加 `http://127.0.0.1:4179`。测试页由脚本提供，不占用 4179 端口；也可以通过 `--origin` 指定已获允许的页面 Origin，需与统计接口 Origin 不同。真实模式会产生 `/__webpulse_test__/` 测试访问，不会修改站点配置或删除既有数据。

```bash
node tests/sdk/consent-smoke.mjs --headed
# 自定义服务、站点和页面 Origin：
node tests/sdk/consent-smoke.mjs --headed \
  --endpoint http://127.0.0.1:5173 \
  --site-id site_dfbc69789522255cc21d88d3a4ae07a3 \
  --origin http://127.0.0.1:4179
```

无桌面的 Linux 服务器可以使用 `--xvfb`。脚本会自动分配虚拟显示，运行有界面的 Chromium，并在退出时清理 Xvfb，无需安装桌面、`xauth` 或关闭站点的机器人过滤。`--origin` 使用该测试站点已加入白名单的来源；脚本会直接提供测试页，无需访问或修改该域名的真实网站。

当 HTTPS 测试来源访问本机 HTTP 统计接口时，脚本仅在本次独立浏览器上下文中为该来源授予本地网络访问权限，避免等待浏览器权限弹窗。

```bash
cd /root/WebPulse
# 仅在未安装 Xvfb 时安装：apt-get update && apt-get install -y xvfb
node tests/sdk/consent-smoke.mjs --xvfb --origin https://www.tryxd.cn
```

`--headed` 使用已有桌面显示环境；`--xvfb` 使用临时虚拟显示。也可以在独立测试站点显式关闭机器人过滤后使用默认无头模式。脚本检测到无头浏览器会被过滤时会报错，避免把被过滤的 204 当成有效访问。若浏览器尚未安装，运行 `pnpm exec playwright install chromium`；也可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定现有浏览器。`--help` 可查看参数。

模拟模式只证明浏览器 SDK 行为；真实模式证明 HTTP 请求与响应，不直接查询数据库，也不保证后台报表已更新。

## 随机批量创建测试访问

使用同一个入口加上 `--random`，可随机生成多个访客、页面路径、直接/搜索/引荐来源、停留时间和点击。每位访客使用独立浏览器上下文，页面切换沿用该访客身份；依次访问并等待 PV、点击和离开时的心跳确认后再关闭。访客数就是本批计划新增访客数，每人的 PV 数在设定范围内随机选择。

```bash
cd /root/WebPulse
node tests/sdk/consent-smoke.mjs --xvfb --origin https://www.tryxd.cn \
  --random --visitors 30 --min-pages 1 --max-pages 6
```

可进一步调整每页停留、访客间隔和点击概率：

```bash
node tests/sdk/consent-smoke.mjs --xvfb --origin https://www.tryxd.cn \
  --random --visitors 10 --min-pages 1 --max-pages 5 \
  --min-stay-ms 2000 --max-stay-ms 8000 \
  --min-gap-ms 500 --max-gap-ms 1500 --click-rate 0.65
```

默认 10 位访客、每人 1–5 页、每页额外停留 2–6 秒、访客间隔 0.5–1.5 秒、每页点击概率 65%。实际耗时还包含 SDK 冲刷和接口确认，几十位访客通常需要数分钟。可用 `--mock --random` 先检查模拟接口；省略 `--random` 仍执行原有六项同意检查。

每批路径包含 `/__webpulse_test__/random/run-xxxxxxxx/` 前缀；脚本输出本批前缀和成功确认的访客、PV、点击、心跳汇总。失败时退出码为 1，已写入的访问保留。所有访问发生在当前时间，同机请求共用出口 IP，因此 IP 数通常不会按访客数增长。
