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
