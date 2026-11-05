import { readFile } from 'node:fs/promises';
import { expect, type Page, type Route } from '@playwright/test';
import {
  defaultRules,
  type CollectionRules,
  type CollectionEvent,
} from '../../packages/shared/src/index.js';
import type { Tracker } from '../../packages/tracker/src/tracker.js';
export type Captured = {
  path: string;
  body: {
    site_id: string;
    cid: string;
    events?: CollectionEvent[];
    page_view_id?: string;
    total_visible_ms?: number;
  };
};
declare global {
  interface Window {
    sdk: Tracker;
    webpulse?: Tracker;
  }
}
export async function harness(
  page: Page,
  rules: Partial<CollectionRules> = {},
  handle?: (route: Route, capture: Captured) => Promise<boolean>,
) {
  const requests: Captured[] = [];
  const all: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = await readFile('packages/tracker/dist/tracker.js', 'utf8');
  await page.route('http://127.0.0.1:4179/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>SDK test</title><button id="click">Click</button><div style="height:4000px">scroll</div>',
    }),
  );
  await page.route('https://stats.test/**', async (route) => {
    const url = new URL(route.request().url());
    all.push(url.pathname);
    if (url.pathname === '/tracker.js') {
      await route.fulfill({ contentType: 'application/javascript', body: bundle });
      return;
    }
    if (url.pathname.includes('tracker-config')) {
      await route.fulfill({
        json: { data: { rules: { ...defaultRules, ...rules }, rule_version: 1 } },
        headers: { 'access-control-allow-origin': 'http://127.0.0.1:4179' },
      });
      return;
    }
    const capture = {
      path: url.pathname,
      body: route.request().postDataJSON() as Captured['body'],
    };
    requests.push(capture);
    if (handle && (await handle(route, capture))) return;
    await route.fulfill({
      status: 204,
      headers: { 'access-control-allow-origin': 'http://127.0.0.1:4179' },
    });
  });
  await page.goto('http://127.0.0.1:4179/product/123?secret=do-not-send#private');
  await page.addScriptTag({ url: 'https://stats.test/tracker.js' });
  await page.evaluate(() => {
    const api = (window as unknown as { WebPulse: { createTracker(options: object): Tracker } })
      .WebPulse;
    window.sdk = api.createTracker({ siteId: 'site_browser_test', endpoint: 'https://stats.test' });
  });
  const grant = async () => {
    await page.evaluate(() => window.sdk.consent(true));
    await expect
      .poll(() => all.filter((path) => path.includes('tracker-config')).length)
      .toBeGreaterThan(0);
  };
  const events = () => requests.flatMap((item) => item.body.events ?? []);
  const pv = () => events().filter((item) => item.type === 'page_view');
  return { requests, all, errors, grant, events, pv };
}
