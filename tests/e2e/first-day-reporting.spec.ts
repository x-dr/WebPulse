import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { dashboardFixture } from '../support/dashboard.js';

test('a newly created site shows collected first-day metrics and a valid trend over real HTTP', async ({
  page,
}, testInfo) => {
  const f = await dashboardFixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await f.pool.query("UPDATE sites SET timezone='Asia/Shanghai'");
    expect((await f.collect([f.pv('/first'), f.pv('/second')])).statusCode).toBe(204);
    expect((await f.collect([f.pv('/first')], {}, randomUUID())).statusCode).toBe(204);
    await f.pool.query(
      "UPDATE sessions SET status='closed',ended_at=last_activity_at,closed_at=clock_timestamp(),close_reason='timeout',active_ms=CASE WHEN page_views=2 THEN 30000 ELSE 0 END",
    );
    await page.goto(`${f.endpoint}/overview?site_id=${f.site}`);
    await page.getByLabel('用户名', { exact: true }).fill('admin');
    await page.getByLabel('密码', { exact: true }).fill('test-password-only');
    await page.getByRole('button', { name: '登录工作台' }).click();
    for (const [label, value] of [
      ['浏览量 PV', '3'],
      ['访客 UV', '2'],
      ['独立 IP', '1'],
      ['会话', '2'],
      ['跳出率', '50.0%'],
      ['平均访问时长', '0分15秒'],
    ] as const) {
      await expect(
        page
          .locator('.metric-card')
          .filter({ has: page.getByText(label, { exact: true }) })
          .locator('strong'),
      ).toHaveText(value);
    }
    await expect(page.getByText(/首日从站点接入时刻/)).toBeVisible();
    await expect(page.locator('.trend-chart svg')).toBeVisible();
    await expect(page.getByRole('img', { name: /本期访客 2，/ })).toBeVisible();
    await expect(page.getByText('服务返回的数据格式无效，请重试。')).toHaveCount(0);
    await expect(page.getByText('该日期早于站点接入时间，请缩小日期范围。')).toHaveCount(0);
    await page.getByText('查看趋势数据表', { exact: true }).click();
    await expect(page.getByRole('cell', { name: '部分时间桶', exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    await page.getByRole('heading', { name: '流量总览' }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `docs/verification/first-day-reporting-${testInfo.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});
