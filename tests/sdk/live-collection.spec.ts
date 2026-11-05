import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { fixture } from '../support/postgres.js';
import { defaultRules } from '../../packages/shared/src/index.js';

test('browser SDK sends real HTTP through API into isolated PostgreSQL', async ({ page }) => {
  const f = await fixture();
  let endpoint = '';
  const host = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      `<!doctype html><title>Live SDK test</title><button>Interact</button><script defer src="${endpoint}/tracker.js" data-site-id="${f.site}" data-consent="required"></script>`,
    );
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  const address = host.address();
  if (!address || typeof address === 'string') throw new Error('No host port');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await f.patch({
      primary_origin: origin,
      allowed_origins: [origin],
      rules: { ...defaultRules, exclude_bots: false },
    });
    endpoint = await f.app.listen({ host: '127.0.0.1', port: 0 });
    await page.goto(`${origin}/product/123?password=must-not-leak`);
    await page.waitForFunction(() => Boolean(window.webpulse));
    expect((await f.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(0);
    await page.evaluate(() => window.webpulse!.consent(true));
    await expect
      .poll(async () => (await f.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n)
      .toBe(1);
    await page.locator('button').click();
    await expect
      .poll(
        async () => (await f.pool.query('SELECT interactions FROM sessions')).rows[0].interactions,
      )
      .toBe(1);
    await page.evaluate(() => history.pushState({}, '', '/product/456'));
    await expect
      .poll(async () => (await f.pool.query('SELECT page_views FROM sessions')).rows[0].page_views)
      .toBe(2);
    await page.clock.install();
    await page.clock.fastForward(16000);
    await expect
      .poll(
        async () =>
          (await f.pool.query('SELECT max(total_visible_ms)::int AS ms FROM page_views')).rows[0]
            .ms,
      )
      .toBeGreaterThan(0);
    const stored = JSON.stringify(await f.snapshot());
    expect(stored).not.toContain('must-not-leak');
    expect(stored).not.toContain('/product/123');
    expect(stored).not.toContain('/product/456');
    await page.evaluate(() => window.webpulse!.consent(false));
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  } finally {
    await f.close();
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      host.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
