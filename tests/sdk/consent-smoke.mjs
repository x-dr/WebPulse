import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { openTrackerPage, startTrackerBrowser, waitFor } from './tracker-browser.mjs';
import { readTrafficOptions, runRandomVisits } from './random-visits.mjs';

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string', default: 'http://127.0.0.1:5173' },
    origin: { type: 'string', default: 'http://127.0.0.1:4179' },
    'site-id': { type: 'string', default: 'site_dfbc69789522255cc21d88d3a4ae07a3' },
    mock: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    xvfb: { type: 'boolean', default: false },
    random: { type: 'boolean', default: false },
    visitors: { type: 'string', default: '10' },
    'min-pages': { type: 'string', default: '1' },
    'max-pages': { type: 'string', default: '5' },
    'min-stay-ms': { type: 'string', default: '2000' },
    'max-stay-ms': { type: 'string', default: '6000' },
    'min-gap-ms': { type: 'string', default: '500' },
    'max-gap-ms': { type: 'string', default: '1500' },
    'click-rate': { type: 'string', default: '0.65' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`用法：node tests/sdk/consent-smoke.mjs [选项]
  --endpoint URL   tracker/API 地址，默认 http://127.0.0.1:5173
  --origin URL     测试页面 Origin，默认 http://127.0.0.1:4179，须在站点白名单中
  --site-id ID     默认使用示例中的 site_dfbc69789522255cc21d88d3a4ae07a3
  --headed        显示浏览器窗口，适用于启用了机器人过滤的真实站点
  --xvfb          在 Linux 虚拟显示中运行浏览器，无需桌面或 xauth（需安装 Xvfb）
  --mock          使用本地构建的 tracker 和模拟接口，不向真实站点发送数据
  --random        随机造数模式；省略时运行原有六项同意检查
  --visitors N    独立访客数，默认 10
  --min-pages N / --max-pages N      每位访客随机页数，默认 1–5
  --min-stay-ms N / --max-stay-ms N  每页随机停留毫秒数，默认 2000–6000
  --min-gap-ms N / --max-gap-ms N    访客间随机间隔毫秒数，默认 500–1500
  --click-rate N  每页点击概率，默认 0.65，范围 0–1

真实模式会向指定站点写入测试访问。测试页由脚本提供，无需另起页面服务。
HTTP 204 只验证接口确认，不代表已验证数据库入库或后台报表。`);
} else {
  let runtime;
  try {
    await run();
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    console.error('检查服务、Origin 白名单和浏览器；本机无服务时可先运行 --mock。');
    process.exitCode = 1;
  } finally {
    await runtime?.close();
  }

  async function run() {
    const endpoint = originOnly(values.endpoint);
    const origin = originOnly(values.origin);
    const siteId = values['site-id'];
    assert.match(siteId, /^[a-zA-Z0-9_-]{8,64}$/, 'site-id 格式不正确');
    assert.notEqual(origin, endpoint, '测试页与统计接口请使用不同 Origin，确保发送 Origin 头');
    console.log(
      `${values.mock ? '模拟模式' : '真实 HTTP 模式'}：${endpoint}，页面 Origin ${origin}`,
    );

    const traffic = values.random ? readTrafficOptions(values) : undefined;
    runtime = await startTrackerBrowser(values);
    const options = { endpoint, origin, siteId, mock: values.mock };
    if (traffic) return runRandomVisits(runtime, options, traffic);
    const secret = 'webpulse-test-secret';
    const session = await openTrackerPage(runtime, {
      ...options,
      initialPath: `/__webpulse_test__/start?token=${secret}#/__webpulse_test__/first`,
    });
    const { page, requests, errors, events: accepted } = session;
    await page.waitForTimeout(2200);
    assert.equal(requests.length, 1, '未同意时只能加载 tracker.js');
    assert.equal(requests[0].path, '/tracker.js');
    assert.equal(requests[0].status, 200, 'tracker.js 未成功加载');
    assert.equal(await page.evaluate(() => globalThis.webpulseStorageAccess.length), 0);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).length), 0);
    console.log('PASS 同意前无配置/采集请求，也不访问分析存储');

    const rules = await session.grant();
    const mode = rules.routing_mode;
    if (mode === 'manual') await page.evaluate(() => globalThis.webpulse.trackPageView());
    await waitFor(() => accepted('page_view').length, '同意后没有收到 PV 的 HTTP 204').toBe(1);
    assert.ok(
      await page.evaluate(
        (id) => Object.keys(localStorage).includes(`webpulse:${id}:identity`),
        siteId,
      ),
      '同意后未创建本站身份',
    );
    console.log('PASS 同意后加载配置、创建本站身份，PV 获得 HTTP 204');

    await page.locator('#interact').click();
    await waitFor(() => accepted('interaction').length, '点击互动未获确认').toBe(1);
    assert.equal(accepted('interaction')[0].page_view_id, accepted('page_view')[0].page_view_id);
    console.log('PASS 可信点击产生一次互动，并关联首个 PV');

    await page.evaluate((routing) => {
      if (routing === 'hash') globalThis.location.hash = '/__webpulse_test__/next';
      else globalThis.history.pushState({}, '', '/__webpulse_test__/next');
      if (routing === 'manual') globalThis.webpulse.trackPageView();
    }, mode);
    await waitFor(() => accepted('page_view').length, '页面切换未产生第二次 PV').toBe(2);
    assert.notEqual(accepted('page_view')[0].event_id, accepted('page_view')[1].event_id);
    assert.ok(!JSON.stringify(requests).includes(secret), '请求中包含了原始 query');
    assert.ok(accepted('page_view').every((event) => !/[?#]/.test(event.page.path)));
    console.log(`PASS ${mode} 模式页面切换产生新 PV，query/hash 未进入上报路径`);

    await waitFor(
      () =>
        requests.filter(
          (request) =>
            request.path === '/api/v1/heartbeat' &&
            request.status === 204 &&
            request.body.page_view_id === accepted('page_view')[1].page_view_id &&
            request.body.total_visible_ms > 0,
        ).length,
      '15 秒内的可见心跳未获确认',
    ).toBeGreaterThan(0);
    console.log('PASS 可见时长心跳获得 HTTP 204');

    await page.evaluate(() => globalThis.webpulse.consent(false));
    const stoppedAt = requests.length;
    await page.evaluate(() => {
      globalThis.history.pushState({}, '', '/__webpulse_test__/after-revoke');
      globalThis.location.hash = '/__webpulse_test__/after-revoke';
      globalThis.webpulse.trackPageView({ path: '/__webpulse_test__/after-revoke' });
    });
    await page.locator('#interact').click();
    await page.waitForTimeout(16_000);
    assert.equal(requests.length, stoppedAt, '撤销同意后仍然发起请求');
    assert.ok(
      await page.evaluate(
        (id) => !Object.keys(localStorage).includes(`webpulse:${id}:identity`),
        siteId,
      ),
      '撤销同意后本站身份仍然存在',
    );
    assert.equal(errors.length, 0, '测试页面发生脚本异常');
    assert.ok(
      requests.every((request) => !request.failed),
      '存在失败的网络请求',
    );
    assert.ok(
      requests.every((request) => request.status === 200 || request.status === 204),
      '存在未确认的请求',
    );
    assert.ok(
      requests.every(
        (request) =>
          !request.body || (request.body.site_id === siteId && request.body.consent === 'granted'),
      ),
      '上报中的站点 ID 或同意状态不正确',
    );
    console.log('PASS 撤销后清除本站身份；导航、点击及下一次心跳均不再采集');
    console.log(
      values.mock
        ? '完成：本地 SDK + 模拟接口通过，未写入真实站点。'
        : '完成：真实 HTTP 链路通过；数据库及后台报表请另行确认。',
    );
  }
}

function originOnly(input) {
  const url = new URL(input);
  assert.ok(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    '地址必须是纯 HTTP(S) Origin，例如 http://127.0.0.1:5173',
  );
  return url.origin;
}
