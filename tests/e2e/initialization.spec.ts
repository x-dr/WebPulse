import { test, expect } from '@playwright/test';

test('renders connection failures, supports retry and fits the viewport', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let ready = false;
  await page.route('**/api/v1/health/*', async (route) => {
    const check = route.request().url().endsWith('/live') ? 'live' : 'ready';
    const ok = check === 'live' || ready;
    await route.fulfill({
      status: ok ? 200 : 503,
      json: { status: ok ? 'ok' : 'unavailable', service: 'webpulse', check },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('连接正常', { exact: true })).toBeVisible();
  await expect(page.getByText('尚未就绪', { exact: true })).toBeVisible();
  ready = true;
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByText('已就绪', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '重新检查' }).focus();
  await expect(page.getByRole('button', { name: '重新检查' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('已就绪', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('does not report malformed successful responses as healthy', async ({ page }) => {
  await page.route('**/api/v1/health/*', (route) => route.fulfill({ json: { status: 'ok' } }));
  await page.goto('/');
  await expect(page.getByText('连接中断', { exact: true })).toBeVisible();
  await expect(page.getByText('尚未就绪', { exact: true })).toBeVisible();
});
