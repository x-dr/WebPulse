import { test, expect } from '@playwright/test';
import { dashboardFixture } from '../support/dashboard.js';

test('real SSE replaces snapshots, shares tabs, pauses visibility and restores after reconnect', async ({
  page,
  context,
}, info) => {
  const f = await dashboardFixture();
  test.setTimeout(45000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await context.addCookies([
      { name: 'wp_admin_dev', value: f.cookie.slice(f.cookie.indexOf('=') + 1), url: f.endpoint },
    ]);
    await page.goto(`${f.endpoint}/realtime?site_id=${f.site}&start_date=2000-01-01`);
    await expect(page.getByRole('heading', { name: '实时访问', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: '实时连接状态' })).toContainText('实时连接正常');
    expect(await page.getByLabel('开始日期').count()).toBe(0);
    const accepted = Date.now();
    await f.collect([f.pv('/live-page')]);
    await expect(page.getByText('/live-page', { exact: true })).toHaveCount(2, { timeout: 10000 });
    expect(Date.now() - accepted).toBeLessThan(10000);
    await expect(page.locator('.realtime-metrics strong').first()).toHaveText('1');
    if (info.project.name === 'desktop') {
      for (const width of [1440, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.screenshot({
          path: `docs/verification/ui-realtime-${width}.png`,
          fullPage: true,
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
    }
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('status', { name: '实时连接状态' })).toContainText('已暂停');
    await f.collect([f.pv('/after-pause')]);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByText('/after-pause', { exact: true })).toHaveCount(2);
    let handshakeFailed = false;
    await page.route('**/api/v1/realtime?**', async (route) => {
      if (!handshakeFailed) {
        handshakeFailed = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":{"code":"recovery_locked"}}',
        });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '重新连接' }).click();
    await expect(page.getByRole('status', { name: '实时连接状态' })).toContainText('实时连接正常', {
      timeout: 12000,
    });
    expect(handshakeFailed).toBe(true);
    await page.unroute('**/api/v1/realtime?**');
    await expect(page.locator('.realtime-metrics strong').first()).toHaveText('1');
    const peer = await context.newPage();
    await peer.goto(`${f.endpoint}/realtime?site_id=${f.site}`);
    await expect(peer.getByRole('status', { name: '实时连接状态' })).toContainText('实时连接正常', {
      timeout: 10000,
    });
    const locks = await page.evaluate(
      async () =>
        (await navigator.locks.query()).held?.filter((l) =>
          l.name?.startsWith('webpulse:realtime:'),
        ).length,
    );
    expect(locks).toBe(1);
    await peer.close();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await f.close();
  }
});
