import { describe, it, expect } from 'vitest';
import {
  cleanPath,
  cleanUtm,
  defaultRules,
  referrerHost,
  normalizeOrigin,
} from '../../packages/shared/src/index.js';
import { canonicalIp, identityKey } from '../../apps/server/src/modules/identity/keys.js';
import { FairGate, RateLimits } from '../../apps/server/src/http/budget.js';
import { readSecurityConfig } from '../../apps/server/src/config/security.js';

describe('collection privacy and bounds', () => {
  it.each([
    ['/product/123?token=secret#private', '/product/:id'],
    ['/User/me%40example.com/', '/User/:id/'],
    ['/e%CC%81', '/%C3%A9'],
    ['/abcdef12-1234-1234-1234-123456789abc', '/:id'],
    ['/reset-password/secret', null],
    ['/Case/', '/Case/'],
  ])('cleans %s', (input, expected) => expect(cleanPath(input, defaultRules)).toBe(expected));
  it.each([
    '//evil.test/path',
    '/%2fsecret',
    '/%00',
    '/%GG',
    '/a/../b',
    '/a\\b',
    '/' + '路'.repeat(200),
  ])('rejects ambiguous or oversized paths', (path) =>
    expect(() => cleanPath(path, defaultRules)).toThrow(),
  );
  it('drops referrer payloads and uses opt-in restricted UTM labels', () => {
    expect(referrerHost('https://name:password@example.test/private?secret#x')).toBe(
      'example.test',
    );
    expect(cleanUtm({ utm_source: 'newsletter' }, defaultRules)).toEqual(['', '', '']);
    expect(
      cleanUtm(
        { utm_source: 'newsletter', utm_medium: 'me@example.test' },
        { ...defaultRules, allow_utm: true },
      ),
    ).toEqual(['newsletter', '', '']);
    expect(() => normalizeOrigin('https://example.test/private')).toThrow();
  });
  it('canonicalizes IPs and separates site, purpose and epoch HMACs', () => {
    expect(canonicalIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(canonicalIp('2001:0db8:0:0:0:0:0:1')).toBe('2001:db8::1');
    const key = Buffer.alloc(32, 1);
    const keys = [
      ['visitor', 'a', 1],
      ['visitor', 'b', 1],
      ['ip', 'a', 1],
      ['visitor', 'a', 2],
    ] as const;
    expect(
      new Set(keys.map(([p, s, e]) => identityKey(key, p, s, e, 'same').toString('hex'))).size,
    ).toBe(4);
  });
  it('requires separate stable secrets and HTTPS in production', () => {
    expect(() =>
      readSecurityConfig({
        VISITOR_HMAC_KEY: '11'.repeat(32),
        IP_HMAC_KEY: '11'.repeat(32),
        CSRF_HMAC_KEY: '33'.repeat(32),
      }),
    ).toThrow('Independent');
    expect(() => readSecurityConfig({ NODE_ENV: 'production' })).toThrow('HTTPS');
  });
  it('reserves execution slots for a different site and removes cancelled waiters', async () => {
    const gate = new FairGate(4, 2, 8, 4);
    const controller = new AbortController();
    const a = await gate.acquire('a', controller.signal),
      b = await gate.acquire('a', controller.signal);
    const queued = gate.acquire('a', controller.signal).catch(() => 'cancelled');
    const small = await gate.acquire('b', new AbortController().signal);
    controller.abort();
    expect(await queued).toBe('cancelled');
    a();
    b();
    small();
  });
  it('admits ten tabs heartbeat/PV/interaction budget but rejects a burst', () => {
    const limits = new RateLimits();
    for (let i = 0; i < 60; i++) limits.take('cid', 60, 2);
    expect(() => limits.take('cid', 60, 2)).toThrow('rate_limited');
  });
});
