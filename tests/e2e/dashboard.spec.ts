import { test, expect } from '@playwright/test';
import { mockDashboard } from './dashboard-fixture.js';

test('navigation shares dates, source details and stable pagination; pages search and exit use API', async ({
  page,
}) => {
  const state = await mockDashboard(page);
  await page.goto('/sources?site_id=site_dashboard_test&start_date=2026-11-01&end_date=2026-11-03');
  await page.getByRole('button', { name: 'github.com', exact: true }).first().click();
  await expect(page).toHaveURL(/referrer_host=github.com/);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await page.getByTitle('2', { exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole('link', { name: '页面', exact: true }).click();
  await expect(page).toHaveURL(/start_date=2026-11-01/);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索路径' }).fill('/guide');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect
    .poll(() =>
      state.requests.some(
        (r) => r.path.includes('mode=exit') && r.path.includes('search=%2Fguide'),
      ),
    )
    .toBe(true);
  await page.getByRole('link', { name: '访客', exact: true }).click();
  await expect(page.getByRole('heading', { name: '访客分析' })).toBeVisible();
  await expect(page.getByText('占比 48.4%', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('textbox', { name: '搜索路径' })).toHaveValue('/guide');
});

test('date selector uses exclusive API end; site switching prevents stale values; expiry preserves scope', async ({
  page,
}) => {
  const state = await mockDashboard(page);
  await page.goto('/overview');
  await page.getByLabel('开始日期', { exact: true }).fill('2026-11-01');
  await page.getByLabel('结束日期（含）', { exact: true }).fill('2026-11-02');
  await page.getByRole('button', { name: '应用日期' }).click();
  await expect(page).toHaveURL(/end_date=2026-11-03/);
  await page.getByRole('combobox', { name: '当前站点' }).click();
  await page.getByText('第二个站点', { exact: true }).last().click();
  await expect(
    page.locator('.metric-card').filter({ hasText: '浏览量 PV' }).locator('strong'),
  ).toHaveText('7');
  state.expired = true;
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await expect(page).toHaveURL(/site_id=site_second_test/);
  await page.getByLabel('用户名', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('test-password-only');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('heading', { name: '流量总览' })).toBeVisible();
  await expect(page).toHaveURL(/start_date=2026-11-01/);
});

test('null and malformed responses are not converted to zero', async ({ page }) => {
  const state = await mockDashboard(page);
  state.unavailable = true;
  await page.goto('/overview');
  await expect(
    page.locator('.metric-card').filter({ hasText: '访客 UV' }).locator('strong'),
  ).toHaveText('—');
  await expect(page.getByText('排行暂不可用', { exact: true })).toHaveCount(3);
  state.malformed = true;
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.getByText('服务返回的数据格式无效，请重试。')).toBeVisible();
});

test('site creation, settings and pause are guarded and use CSRF', async ({ page }) => {
  const state = await mockDashboard(page, { empty: true });
  await page.goto('/sites');
  await page.getByLabel('站点名称', { exact: true }).fill('我的站点');
  await page.getByLabel('主 Origin', { exact: true }).fill('https://docs.example.com');
  await page.getByRole('button', { name: '创建站点', exact: true }).click();
  await expect(page.getByRole('heading', { name: '站点设置', exact: true })).toBeVisible();
  await page.getByLabel('站点名称', { exact: true }).fill('新的站点名');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByText('配置已保存。')).toBeVisible();
  await page.getByRole('button', { name: '暂停采集', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(state.requests.filter((r) => r.method === 'PATCH').length).toBe(1);
  await page.getByRole('button', { name: '暂停采集', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复采集', exact: true })).toBeVisible();
  for (const req of state.requests.filter((r) => ['POST', 'PATCH'].includes(r.method)))
    expect(req.headers['x-csrf-token']).toBe('test-csrf-in-memory');
});

test('retention requires preview and name; deletion cancels, retries with one key and displays job', async ({
  page,
}) => {
  const state = await mockDashboard(page);
  await page.goto('/sites/site_dashboard_test/settings');
  await page.getByRole('button', { name: '预览影响' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('button', { name: '确认更新保留策略' })).toBeDisabled();
  await modal.getByRole('textbox').fill('WebPulse 文档站');
  await modal.getByRole('button', { name: '确认更新保留策略' }).click();
  await expect(page.getByText('保留策略已更新。')).toBeVisible();
  await page.getByRole('button', { name: '删除站点', exact: true }).click();
  await expect(modal.getByRole('button', { name: '确认删除' })).toBeDisabled();
  await modal.getByRole('button', { name: '取消' }).click();
  expect(state.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  state.failDelete = true;
  await page.getByRole('button', { name: '删除站点', exact: true }).click();
  await modal.getByRole('textbox').fill('WebPulse 文档站');
  await modal.getByRole('button', { name: '确认删除' }).click();
  await expect(modal.getByText('服务暂时不可用，请稍后重试。')).toBeVisible();
  state.failDelete = false;
  await modal.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('heading', { name: '删除任务', exact: true })).toBeVisible();
  await expect(
    page.getByText('正在等待独立删除清单确认。部署管理员接入后才能继续删除。'),
  ).toBeVisible();
  const keys = state.requests
    .filter((r) => r.method === 'DELETE')
    .map((r) => r.headers['idempotency-key']);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test('responsive acceptance screenshots and keyboard focus at five widths', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One viewport sweep is sufficient');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockDashboard(page);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/overview?start_date=2026-11-01&end_date=2026-11-03');
    await expect(page.locator('.metric-card')).toHaveCount(7);
    await expect(page.locator('.trend-chart svg')).toBeVisible();
    await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(245, 247, 250)');
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(245, 247, 250)');
    await expect(page.getByRole('navigation', { name: '主要导航' }).getByRole('link')).toHaveCount(
      6,
    );
    await expect(page.getByRole('link', { name: '总览', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('img', { name: /本期访客 2,549/ })).toBeVisible();
    if (width === 1440) {
      const originalURL = page.url();
      const sidebar = page.locator('.sidebar');
      await expect(sidebar).toHaveCSS('width', '224px');
      await page.getByRole('button', { name: '收起侧边栏' }).focus();
      await page.keyboard.press('Enter');
      await expect(sidebar).toHaveCSS('width', '80px');
      await expect(page.getByRole('button', { name: '展开侧边栏' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await page.getByRole('button', { name: '展开侧边栏' }).click();
      await expect(sidebar).toHaveCSS('width', '224px');
      expect(page.url()).toBe(originalURL);
      await page.getByRole('heading', { name: '流量总览' }).click();
    }
    if (width === 390) {
      const navigation = await page.locator('.sidebar').boundingBox();
      expect(navigation?.y).toBeGreaterThanOrEqual(900);
      expect(navigation!.y + navigation!.height).toBe(1000);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `docs/verification/ui-overview-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: '站点设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '站点设置', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `docs/verification/ui-settings-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: '删除站点', exact: true }).click();
  await page.keyboard.press('Tab');
  expect(
    await page.getByRole('dialog').evaluate((dialog) => dialog.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(errors).toEqual([]);
});
