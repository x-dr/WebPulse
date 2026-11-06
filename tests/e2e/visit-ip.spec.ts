import { test, expect } from '@playwright/test';
import { dashboardFixture } from '../support/dashboard.js';

test('visitors and realtime show stored IPs over real HTTP on desktop and mobile', async ({
  page,
  context,
}, info) => {
  const f = await dashboardFixture();
  const ipv6 = '2001:db8:1234:5678:90ab:cdef:1234:5678';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    expect((await f.collect([f.pv('/legacy')])).statusCode).toBe(204);
    await f.pool.query('UPDATE events SET client_ip=NULL');
    expect(
      (
        await f.collect(
          Array.from({ length: 19 }, (_, i) => f.pv(`/visit-${String.fromCharCode(97 + i)}`)),
          { remoteAddress: '192.0.2.40' },
        )
      ).statusCode,
    ).toBe(204);
    expect((await f.collect([f.pv('/ipv6')], { remoteAddress: ipv6 })).statusCode).toBe(204);
    await context.addCookies([
      { name: 'wp_admin_dev', value: f.cookie.slice(f.cookie.indexOf('=') + 1), url: f.endpoint },
    ]);
    await page.goto(`${f.endpoint}/visitors?site_id=${f.site}`);
    const records = page.getByRole('region', { name: '访问记录', exact: true });
    await expect(records.getByRole('heading', { name: '访问记录', exact: true })).toBeVisible();
    await expect(records.getByRole('columnheader', { name: '真实 IP', exact: true })).toBeVisible();
    await expect(records.getByRole('cell', { name: ipv6, exact: true })).toBeVisible();
    await expect(records.getByText('共 21 条访问', { exact: true })).toBeVisible();
    expect(await records.locator('tbody tr').count()).toBe(20);
    const table = records.getByRole('region', { name: '访问记录表格', exact: true });
    await table.focus();
    await expect(table).toBeFocused();
    if (info.project.name === 'mobile') {
      await table.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
      expect(await table.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      await table.evaluate((node) => {
        node.scrollLeft = 0;
      });
    }
    expect(
      await records
        .locator('.visit-ip')
        .evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth)),
    ).toBe(true);
    await expect(page.locator('.trend-chart svg')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: `docs/verification/visit-ip-visitors-${info.project.name}.png`,
      fullPage: true,
    });
    await records.getByTitle('2', { exact: true }).click();
    await expect(records.getByRole('cell', { name: '未记录', exact: true })).toBeVisible();
    await expect(records.getByRole('rowheader', { name: '/legacy', exact: true })).toBeVisible();
    await records.getByTitle('1', { exact: true }).click();
    await expect(records.getByRole('cell', { name: ipv6, exact: true })).toBeVisible();
    await page.goto(`${f.endpoint}/realtime?site_id=${f.site}`);
    await expect(page.getByRole('status', { name: '实时连接状态' })).toContainText('实时连接正常');
    const recent = page.getByRole('table', { name: '最近页面浏览' });
    await expect(recent.getByRole('cell', { name: ipv6, exact: true })).toBeVisible();
    expect(
      await recent
        .locator('.visit-ip')
        .evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth)),
    ).toBe(true);
    await expect(page.locator('.trend-chart svg')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `docs/verification/visit-ip-realtime-${info.project.name}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await f.close();
  }
});
