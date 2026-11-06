import { test, expect } from '@playwright/test';
import { meta, mockDashboard } from './dashboard-fixture.js';
import type { Visitors } from '../../apps/dashboard/src/api/types.js';

test('login handles failure, keyboard submission and logout without persisting credentials', async ({
  page,
}) => {
  const state = await mockDashboard(page, { authenticated: false });
  await page.goto(
    '/overview?site_id=site_dashboard_test&start_date=2026-11-01&end_date=2026-11-03',
  );
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByText('用户名或密码不正确，请重新输入。')).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.getByLabel('密码', { exact: true }).fill('test-password-only');
  await page.getByLabel('密码', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: '流量总览' })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('csrf');
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  expect(state.requests.find((r) => r.path.endsWith('/auth/logout'))?.headers['x-csrf-token']).toBe(
    'test-csrf-in-memory',
  );
  await expect(page).toHaveURL(/start_date=2026-11-01/);
});

test('overview renders seven metrics, full duration, accessible chart and error retry', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await mockDashboard(page);
  state.failOverview = true;
  await page.goto('/overview');
  await expect(page.getByText('查询失败', { exact: true })).toBeVisible();
  state.failOverview = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.metric-card')).toHaveCount(7);
  await expect(page.getByText('121分03秒', { exact: true })).toBeVisible();
  await expect(page.locator('.metric-card').filter({ hasText: '跳出率' })).toContainText(
    '-5.0 个百分点',
  );
  await page.getByText('查看趋势数据表', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table', { name: /趋势数据/ })).toBeVisible();
  await expect(page.getByText('聚合处理中，请稍后刷新。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('visitor chart distinguishes unavailable classification from a real zero', async ({
  page,
}) => {
  await mockDashboard(page);
  let visitors: Visitors = {
    uv: null,
    new_visitors: null,
    returning_visitors: null,
    new_share: null,
    returning_share: null,
  };
  await page.route('**/api/v1/stats/visitors?**', (route) =>
    route.fulfill({ json: { data: visitors, meta } }),
  );
  await page.goto('/visitors');
  await expect(page.getByRole('img', { name: /本期访客 —/ })).toBeVisible();
  await expect(page.locator('.visitor-donut circle')).toHaveCount(1);
  await expect(page.locator('.visitor-donut circle')).toHaveAttribute('stroke', '#e4e8ed');
  await expect(page.locator('.visitor-stat > strong').first()).toHaveText('—');
  visitors = { ...visitors, uv: 0, new_visitors: 0, returning_visitors: 0 };
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.getByRole('img', { name: /本期访客 0/ })).toBeVisible();
  await expect(page.locator('.visitor-stat > strong').first()).toHaveText('0');
  await expect(page.locator('.visitor-donut circle')).toHaveCount(1);
});
