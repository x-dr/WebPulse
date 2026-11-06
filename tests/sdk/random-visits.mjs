import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { openTrackerPage, waitFor } from './tracker-browser.mjs';

const pages = [
  'home',
  'pricing',
  'features',
  'docs/start',
  'docs/api',
  'blog/news',
  'about',
  'contact',
];
const sources = [
  '',
  '',
  'https://www.google.com/',
  'https://www.bing.com/',
  'https://github.com/',
  'https://example.org/',
];

export function readTrafficOptions(values) {
  const integer = (key, max) => {
    assert.match(values[key], /^\d+$/, `--${key} 必须是整数`);
    const value = Number(values[key]);
    assert.ok(
      Number.isSafeInteger(value) && value >= 1 && value <= max,
      `--${key} 范围是 1–${max}`,
    );
    return value;
  };
  const options = {
    visitors: integer('visitors', 1000),
    minPages: integer('min-pages', 100),
    maxPages: integer('max-pages', 100),
    minStay: integer('min-stay-ms', 60_000),
    maxStay: integer('max-stay-ms', 60_000),
    minGap: integer('min-gap-ms', 60_000),
    maxGap: integer('max-gap-ms', 60_000),
    clickRate: Number(values['click-rate']),
  };
  assert.ok(options.minPages <= options.maxPages, 'min-pages 不能大于 max-pages');
  assert.ok(options.minStay <= options.maxStay, 'min-stay-ms 不能大于 max-stay-ms');
  assert.ok(options.minGap <= options.maxGap, 'min-gap-ms 不能大于 max-gap-ms');
  assert.ok(
    /^\d+(?:\.\d+)?$/.test(values['click-rate']) &&
      options.clickRate >= 0 &&
      options.clickRate <= 1,
    'click-rate 范围是 0–1',
  );
  assert.ok(options.visitors * options.maxPages <= 10_000, '每批最多计划 10000 次 PV');
  return options;
}

export async function runRandomVisits(runtime, options, traffic) {
  const started = Date.now();
  const prefix = `/__webpulse_test__/random/run-${randomBytes(4).toString('hex')}`;
  const identities = new Set();
  const totals = { visitors: 0, pageViews: 0, interactions: 0, heartbeats: 0 };
  console.log(
    `随机造数：${traffic.visitors} 位访客，每人 ${traffic.minPages}–${traffic.maxPages} 页，点击概率 ${traffic.clickRate}`,
  );
  console.log(`本批路径前缀：${prefix}`);
  for (let visitor = 1; visitor <= traffic.visitors; visitor++) {
    const count = between(traffic.minPages, traffic.maxPages);
    const referrer = pick(sources);
    const routes = [];
    for (let index = 0; index < count; index++) {
      const candidates = pages.filter((path) => `${prefix}/${path}` !== routes.at(-1));
      routes.push(`${prefix}/${pick(candidates)}`);
    }
    const session = await openTrackerPage(runtime, {
      ...options,
      referrer,
      initialPath: `${routes[0]}#${routes[0]}`,
    });
    const { page, context, requests, events } = session;
    try {
      const rules = await session.grant();
      const interactionIds = new Set();
      for (let index = 0; index < routes.length; index++) {
        if (index > 0 || rules.routing_mode === 'manual') {
          await page.evaluate(
            ({ mode, path }) => {
              if (mode === 'hash') globalThis.location.hash = path;
              else globalThis.history.pushState({}, '', path);
              if (mode === 'manual') globalThis.webpulse.trackPageView({ path });
            },
            { mode: rules.routing_mode, path: routes[index] },
          );
        }
        await waitFor(
          () => events('page_view').length,
          `访客 ${visitor} 的第 ${index + 1} 页未获确认`,
        ).toBe(index + 1);
        const current = events('page_view')[index];
        assert.equal(current.page.path, routes[index], '随机路径被站点规则排除或改变');
        if (randomInt(1_000_000) / 1_000_000 < traffic.clickRate) {
          await page.locator('#interact').click();
          interactionIds.add(current.page_view_id);
        }
        await page.waitForTimeout(between(traffic.minStay, traffic.maxStay));
        if (interactionIds.has(current.page_view_id)) {
          await waitFor(
            () =>
              events('interaction').filter((event) => event.page_view_id === current.page_view_id)
                .length,
            '随机点击未获确认',
          ).toBe(1);
        }
      }
      // Switching tabs triggers a real visibility change; await the final heartbeat before closing.
      const lastPageId = events('page_view').at(-1).page_view_id;
      const away = await context.newPage();
      await away.bringToFront();
      await waitFor(
        () =>
          requests.filter(
            (request) =>
              request.path === '/api/v1/heartbeat' &&
              request.status === 204 &&
              request.body.page_view_id === lastPageId,
          ).length,
        '访客离开时的心跳未获确认',
      ).toBeGreaterThan(0);
      await page.evaluate(() => globalThis.webpulse.destroy());
      assert.equal(session.errors.length, 0, '随机访问出现页面脚本异常');
      const posts = requests.filter((request) => request.body && request.status === 204);
      assert.ok(
        posts.every(
          (request) =>
            request.body.site_id === options.siteId && request.body.consent === 'granted',
        ),
        '上报的站点或同意状态不正确',
      );
      const visitorIds = new Set(posts.map((request) => request.body.cid));
      assert.equal(visitorIds.size, 1, '同一访客的身份发生变化');
      identities.add([...visitorIds][0]);
      assert.equal(identities.size, visitor, '不同访客没有独立身份');
      assert.equal(events('interaction').length, interactionIds.size, '互动计数不一致');
      totals.visitors++;
      totals.pageViews += events('page_view').length;
      totals.interactions += events('interaction').length;
      totals.heartbeats += posts.filter((request) => request.path === '/api/v1/heartbeat').length;
      console.log(
        `PASS 访客 ${visitor}/${traffic.visitors}：${count} PV，${interactionIds.size} 次点击，来源 ${referrer || '直接访问'}`,
      );
    } finally {
      await context.close();
    }
    if (visitor < traffic.visitors)
      await new Promise((resolve) => setTimeout(resolve, between(traffic.minGap, traffic.maxGap)));
  }
  const summary = {
    ...totals,
    pathPrefix: prefix,
    durationSeconds: Math.round((Date.now() - started) / 1000),
    mock: options.mock,
  };
  console.log(
    `完成：${options.mock ? '模拟接口' : '真实 HTTP'}已确认 ${totals.visitors} 位访客、${totals.pageViews} PV、${totals.interactions} 次点击、${totals.heartbeats} 次心跳`,
  );
  console.log(`批次汇总：${JSON.stringify(summary)}`);
  console.log(
    options.mock
      ? '模拟模式未写入真实站点。'
      : '通过 SDK 写入；同机请求共用出口 IP，IP 数不会等于访客数。数据库与报表可按批次路径核对。',
  );
  return summary;
}

function between(min, max) {
  return randomInt(min, max + 1);
}
function pick(values) {
  return values[randomInt(values.length)];
}
