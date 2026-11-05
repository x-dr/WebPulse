import { test, expect } from '@playwright/test';
import { harness } from './harness.js';

test('no consent means no identifier, analytics storage access or config/collection request', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.getItem;
    (window as unknown as { reads: string[] }).reads = [];
    Storage.prototype.getItem = function (key) {
      (window as unknown as { reads: string[] }).reads.push(key);
      return original.call(this, key);
    };
  });
  const h = await harness(page);
  await page.waitForTimeout(2200);
  expect(h.all).toEqual(['/tracker.js']);
  expect(
    await page.evaluate(() => ({
      keys: Object.keys(localStorage),
      reads: (window as unknown as { reads: string[] }).reads,
    })),
  ).toEqual({ keys: [], reads: [] });
  expect(h.errors).toEqual([]);
});
test('consent gates first PV, cleans payload, and revocation clears queues, storage and listeners', async ({
  page,
}) => {
  const h = await harness(page);
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(1);
  const body = JSON.stringify(h.requests);
  expect(body).toContain('/product/:id');
  expect(body).not.toContain('do-not-send');
  expect(body).not.toContain('/product/123');
  await page.evaluate(() => {
    history.pushState({}, '', '/pending/456');
    window.sdk.consent(false);
  });
  const count = h.requests.length;
  await page.waitForTimeout(2200);
  expect(h.requests).toHaveLength(count);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(h.errors).toEqual([]);
});
test('history identity survives redaction, merges microtasks, ignores query/hash and counts A-B-A', async ({
  page,
}) => {
  const h = await harness(page);
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(1);
  await page.evaluate(() => {
    history.pushState({}, '', '/product/456');
    history.replaceState({}, '', '/product/789');
  });
  await expect.poll(() => h.pv().length).toBe(2);
  await page.evaluate(() => history.replaceState({}, '', '/product/789?different=1#hash'));
  await page.waitForTimeout(2200);
  expect(h.pv()).toHaveLength(2);
  await page.evaluate(() => history.pushState({}, '', '/product/123'));
  await expect.poll(() => h.pv().length).toBe(3);
  expect(new Set(h.pv().map((event) => event.event_id)).size).toBe(3);
  expect(h.pv().every((event) => event.page.path === '/product/:id')).toBe(true);
});
test('excluded pages are silent and returning to a permitted path records a new visit', async ({
  page,
}) => {
  const h = await harness(page);
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(1);
  await page.evaluate(() => history.pushState({}, '', '/reset-password/private-token'));
  await page.waitForTimeout(2100);
  expect(h.pv()).toHaveLength(1);
  await page.evaluate(() => history.pushState({}, '', '/product/123'));
  await expect.poll(() => h.pv().length).toBe(2);
  expect(JSON.stringify(h.requests)).not.toContain('private-token');
});
test('manual mode disables automatic PV and hash mode observes only the route', async ({
  page,
}) => {
  const h = await harness(page, { routing_mode: 'manual' });
  await h.grant();
  await page.waitForTimeout(2200);
  expect(h.pv()).toHaveLength(0);
  await page.evaluate(() => {
    history.pushState({}, '', '/ignored');
    window.sdk.trackPageView({ path: '/manual/123' });
  });
  await expect.poll(() => h.pv().length).toBe(1);
  expect(h.pv()[0]!.page.path).toBe('/manual/:id');
});
test('hash routing cleans hash query and redacts route identifiers', async ({ page }) => {
  const h = await harness(page, { routing_mode: 'hash' });
  await page.evaluate(() => history.replaceState({}, '', '/#/product/123?secret=x'));
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(1);
  await page.evaluate(() => {
    location.hash = '/product/456?secret=y';
  });
  await expect.poll(() => h.pv().length).toBe(2);
  expect(h.pv().every((event) => event.page.path === '/product/:id')).toBe(true);
});
test('rejects synthetic interactions and sends one trusted click after PV acknowledgement', async ({
  page,
}) => {
  const h = await harness(page);
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(1);
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent('click'));
    document.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(2100);
  expect(h.events().filter((event) => event.type === 'interaction')).toHaveLength(0);
  await page.locator('#click').click();
  await expect
    .poll(() => h.events().filter((event) => event.type === 'interaction').length)
    .toBe(1);
  await page.locator('#click').click();
  await page.waitForTimeout(2100);
  expect(h.events().filter((event) => event.type === 'interaction')).toHaveLength(1);
});
test('privacy signals and persistent opt-out block explicit consent', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }),
  );
  const h = await harness(page);
  await page.evaluate(() => window.sdk.consent(true));
  await page.waitForTimeout(2200);
  expect(h.all).toEqual(['/tracker.js']);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
test('storage failure uses memory identity and never fingerprints', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('disabled');
    };
    Storage.prototype.setItem = () => {
      throw new Error('disabled');
    };
  });
  const h = await harness(page);
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(1);
  expect(h.requests[0]!.body.cid).toMatch(/^[a-f0-9-]{36}$/);
  expect(h.errors).toEqual([]);
});
test('BFCache pageshow plus popstate creates only one recovery PV', async ({ page }) => {
  const h = await harness(page);
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect.poll(() => h.pv().length).toBe(2);
  await page.waitForTimeout(2100);
  expect(h.pv()).toHaveLength(2);
  expect(h.pv()[1]!.reason).toBe('bfcache');
});
test('session_expired discards old interaction and creates resume PV without rebinding', async ({
  page,
}) => {
  const h = await harness(page, {}, async (route, capture) => {
    if (capture.body.events?.some((event) => event.type === 'interaction')) {
      await route.fulfill({
        status: 409,
        json: { error: { code: 'session_expired' } },
        headers: { 'access-control-allow-origin': 'http://127.0.0.1:4179' },
      });
      return true;
    }
    return false;
  });
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(1);
  await page.locator('#click').click();
  await expect.poll(() => h.pv().length).toBe(2);
  const interactions = h.events().filter((event) => event.type === 'interaction');
  expect(interactions).toHaveLength(1);
  expect(interactions[0]!.page_view_id).toBe(h.pv()[0]!.page_view_id);
  expect(h.pv()[1]!.reason).toBe('resume');
});
test('retries transient failure using the same event ID and finite in-memory payload', async ({
  page,
}) => {
  let calls = 0;
  const h = await harness(page, {}, async (route, capture) => {
    if (capture.path.endsWith('/collect') && calls++ === 0) {
      await route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': 'http://127.0.0.1:4179', 'retry-after': '1' },
      });
      return true;
    }
    return false;
  });
  await h.grant();
  await expect.poll(() => h.pv().length).toBe(2);
  expect(h.pv()[0]!.event_id).toBe(h.pv()[1]!.event_id);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    'webpulse:site_browser_test:identity',
  ]);
});

test('hidden startup defers the first PV until visible and manual mode stays manual on visibility', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(document, 'visibilityState', {
      get: () => ((window as unknown as { hidden: boolean }).hidden ? 'hidden' : 'visible'),
      configurable: true,
    }),
  );
  const h = await harness(page, { routing_mode: 'manual' });
  await page.evaluate(() => {
    (window as unknown as { hidden: boolean }).hidden = true;
  });
  await h.grant();
  await page.waitForTimeout(2200);
  expect(h.pv()).toHaveLength(0);
  await page.evaluate(() => {
    (window as unknown as { hidden: boolean }).hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2200);
  expect(h.pv()).toHaveLength(0);
  await page.evaluate(() => window.sdk.trackPageView({ path: '/manual' }));
  await expect.poll(() => h.pv().length).toBe(1);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2200);
  expect(h.pv()).toHaveLength(1);
});
test('hidden automatic startup sends exactly one initial PV after becoming visible', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { hidden: boolean }).hidden = true;
    Object.defineProperty(document, 'visibilityState', {
      get: () => ((window as unknown as { hidden: boolean }).hidden ? 'hidden' : 'visible'),
    });
  });
  const h = await harness(page);
  await h.grant();
  await page.waitForTimeout(2200);
  expect(h.pv()).toHaveLength(0);
  await page.evaluate(() => {
    (window as unknown as { hidden: boolean }).hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => h.pv().length).toBe(1);
  expect(h.pv()[0]!.reason).toBe('initial');
});
test('persistent opt-out and DNT block all collection and keep the preference', async ({
  page,
}) => {
  const h = await harness(page);
  await page.evaluate(() => {
    window.sdk.optOut();
    window.sdk.consent(true);
  });
  await page.waitForTimeout(2200);
  expect(h.all).toEqual(['/tracker.js']);
  expect(
    await page.evaluate(() => localStorage.getItem('webpulse:site_browser_test:opt-out')),
  ).toBe('1');
  await page.evaluate(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'doNotTrack', { value: '1' });
    window.sdk.consent(true);
  });
  await page.waitForTimeout(2200);
  expect(h.all).toEqual(['/tracker.js']);
});
test('two tabs acquire one 90-day cid using Web Locks; expiry rotates without sliding lifetime', async ({
  context,
  page,
}) => {
  const h = await harness(page);
  const second = await context.newPage();
  try {
    const other = await harness(second);
    await Promise.all([h.grant(), other.grant()]);
    await expect.poll(() => h.pv().length).toBe(1);
    await expect.poll(() => other.pv().length).toBe(1);
    expect(h.requests[0]!.body.cid).toBe(other.requests[0]!.body.cid);
    const first = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('webpulse:site_browser_test:identity')!) as {
          cid: string;
          created_at: number;
          expires_at: number;
        },
    );
    expect(first.expires_at - first.created_at).toBe(90 * 86400_000);
    await page.evaluate(() => {
      window.sdk.destroy();
      const key = 'webpulse:site_browser_test:identity';
      const stored = JSON.parse(localStorage.getItem(key)!);
      stored.expires_at = Date.now() - 1;
      stored.created_at = stored.expires_at - 90 * 86400_000;
      localStorage.setItem(key, JSON.stringify(stored));
      window.sdk.consent(true);
    });
    await expect.poll(() => h.pv().length).toBe(2);
    expect(h.requests.at(-1)!.body.cid).not.toBe(first.cid);
  } finally {
    await second.close();
  }
});
test('withdrawal while config is in flight cannot recreate an identifier or send events', async ({
  page,
}) => {
  const h = await harness(page);
  await page.route('https://stats.test/api/v1/tracker-config/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route
      .fulfill({
        json: { data: { rules: { routing_mode: 'history' } } },
        headers: { 'access-control-allow-origin': 'http://127.0.0.1:4179' },
      })
      .catch(() => undefined);
  });
  await page.evaluate(() => {
    window.sdk.consent(true);
    window.sdk.consent(false);
  });
  await page.waitForTimeout(2400);
  expect(h.requests).toHaveLength(0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test('manual consent can be awaited and transport omits the HTTP Referer path', async ({
  page,
}) => {
  const refs: (string | undefined)[] = [];
  const h = await harness(page, { routing_mode: 'manual' }, async (route) => {
    refs.push(route.request().headers().referer);
    return false;
  });
  await page.evaluate(async () => {
    await window.sdk.consent(true);
    window.sdk.trackPageView({ path: '/manual' });
  });
  await expect.poll(() => h.pv().length).toBe(1);
  expect(refs).toEqual([undefined]);
});
