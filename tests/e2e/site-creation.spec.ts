import { test, expect } from '@playwright/test';
import { mockDashboard } from './dashboard-fixture.js';

test('creating the first site keeps a keyboard-accessible entry for subsequent sites', async ({
  page,
}) => {
  const state = await mockDashboard(page, { empty: true });
  await page.goto('/overview');
  const form = page.getByRole('form', { name: '创建站点', exact: true });
  await form.getByLabel('站点名称', { exact: true }).fill('第一个站点');
  await form.getByLabel('主 Origin', { exact: true }).fill('https://first.example.com');
  await form.getByRole('button', { name: '创建站点', exact: true }).click();
  await expect(page.getByRole('heading', { name: '站点设置', exact: true })).toBeVisible();
  const firstId = state.sites[0]!.site_id;
  const create = page.getByRole('banner').getByRole('button', { name: '新建站点', exact: true });
  await expect(create).toBeInViewport();
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(form).toBeVisible();
  await expect(form.getByLabel('站点名称', { exact: true })).toHaveValue('');
  await page.getByRole('main').getByRole('button', { name: '取消创建' }).click();
  await expect(form).toHaveCount(0);
  expect(state.sites).toHaveLength(1);
  await create.click();
  await expect(form).toBeVisible();
  await form.getByLabel('站点名称', { exact: true }).fill('第二个站点');
  await form.getByLabel('主 Origin', { exact: true }).fill('https://second.example.com');
  await form.getByRole('button', { name: '创建站点', exact: true }).click();
  await expect(page.getByRole('heading', { name: '站点设置', exact: true })).toBeVisible();
  expect(state.sites).toHaveLength(2);
  expect(state.sites[1]!.site_id).not.toBe(firstId);
  await expect(page).toHaveURL(new RegExp(`/sites/${state.sites[1]!.site_id}/settings`));
  await page.reload();
  await expect(create).toBeInViewport();
  await expect(page.getByLabel('站点名称', { exact: true })).toHaveValue('第二个站点');
  await page.getByRole('combobox', { name: '当前站点' }).click();
  await page.getByText('第一个站点', { exact: true }).last().click();
  await expect(page.getByLabel('站点名称', { exact: true })).toHaveValue('第一个站点');
  await expect(page).toHaveURL(new RegExp(`/sites/${firstId}/settings`));
  await page.getByRole('link', { name: '总览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '流量总览' })).toBeVisible();
  await create.click();
  await expect(form).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: '流量总览' })).toBeVisible();
  await page.goForward();
  await expect(form).toBeVisible();
  const requests = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/sites');
  expect(requests).toHaveLength(2);
  for (const request of requests)
    expect(request.headers['x-csrf-token']).toBe('test-csrf-in-memory');
});

test('the create entry fits the header at five widths and opens directly from the site list', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One viewport sweep is sufficient');
  await mockDashboard(page);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/sites');
    const create = page.getByRole('banner').getByRole('button', { name: '新建站点', exact: true });
    await expect(create).toBeInViewport();
    await create.click();
    await expect(page.getByRole('form', { name: '创建站点', exact: true })).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: '取消创建' }).click();
    await expect(page.getByRole('form', { name: '创建站点', exact: true })).toHaveCount(0);
    await create.click();
    await expect(page.getByRole('form', { name: '创建站点', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`site-creation-${width}.png`),
      fullPage: true,
    });
  }
});
