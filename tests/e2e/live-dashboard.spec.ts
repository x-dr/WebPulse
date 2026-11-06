import { test, expect } from '@playwright/test';
import { dashboardFixture } from '../support/dashboard.js';
import { observe, seed } from '../support/reporting.js';

test('built dashboard logs in and reads/modifies real HTTP API and isolated PostgreSQL', async ({
  page,
}) => {
  const f = await dashboardFixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await observe(f, '2026-10-01T00:00:00Z');
    await seed(f, [
      {
        visitor: 'a',
        start: '2026-10-31T09:00Z',
        closed: '2026-10-31T10:00Z',
        pages: [{ at: '2026-10-31T09:00Z', path: '/old' }],
      },
      {
        visitor: 'a',
        start: '2026-11-01T09:00Z',
        closed: '2026-11-01T10:00Z',
        active: 7263000,
        pages: [
          { at: '2026-11-01T09:00Z', path: '/guide' },
          { at: '2026-11-01T09:05Z', path: '/guide/install' },
        ],
      },
      {
        visitor: 'b',
        start: '2026-11-01T11:00Z',
        closed: '2026-11-01T12:00Z',
        active: 3000,
        pages: [{ at: '2026-11-01T11:00Z', path: '/' }],
      },
    ]);
    await page.goto(
      `${f.endpoint}/overview?site_id=${f.site}&start_date=2026-11-01&end_date=2026-11-02`,
    );
    await page.getByLabel('用户名', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('test-password-only');
    await page.getByRole('button', { name: '登录工作台' }).click();
    await expect(page.locator('.metric-card')).toHaveCount(7);
    await expect(
      page.locator('.metric-card').filter({ hasText: '浏览量 PV' }).locator('strong'),
    ).toHaveText('3');
    await expect(
      page.locator('.metric-card').filter({ hasText: '访客 UV' }).locator('strong'),
    ).toHaveText('2');
    await expect(
      page.locator('.metric-card').filter({ hasText: '跳出率' }).locator('strong'),
    ).toHaveText('50.0%');
    await expect(page.getByText('60分33秒', { exact: true })).toBeVisible();
    await expect(page.getByText('占比 50.0%', { exact: true })).toHaveCount(2);
    await expect(page.locator('.trend-chart svg')).toBeVisible();
    await expect(page.getByText('服务返回的数据格式无效，请重试。')).toHaveCount(0);
    await page.getByRole('link', { name: '页面', exact: true }).click();
    await expect(page.getByText('/guide/install', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await expect(page.getByText('/guide/install', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '站点设置', exact: true }).click();
    await page.getByLabel('站点名称', { exact: true }).fill('HTTP 联调站点');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByText('配置已保存。')).toBeVisible();
    expect(
      (await f.pool.query('SELECT name FROM sites WHERE public_id=$1', [f.site])).rows[0].name,
    ).toBe('HTTP 联调站点');
    await page.getByRole('button', { name: '预览影响', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('页面明细');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '暂停采集', exact: true }).click();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('button', { name: '恢复采集', exact: true })).toBeVisible();
    expect(
      (await f.pool.query('SELECT enabled FROM sites WHERE public_id=$1', [f.site])).rows[0]
        .enabled,
    ).toBe(false);
    await page.getByRole('link', { name: '总览', exact: true }).click();
    await f.pool.query('DELETE FROM admin_sessions');
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    await expect(page).toHaveURL(/start_date=2026-11-01/);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});
