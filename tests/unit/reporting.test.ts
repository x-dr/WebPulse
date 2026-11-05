import { describe, it, expect } from 'vitest';
import {
  wallClock,
  reportRanges,
  daySlices,
  validDate,
} from '../../apps/server/src/modules/reports/time.js';
import { compareMetric } from '../../packages/shared/src/reporting.js';
import {
  encryptSelector,
  decryptSelector,
} from '../../apps/server/src/modules/deletion/encryption.js';
import { randomBytes } from 'node:crypto';

describe('M2 local calendar and availability contracts', () => {
  it('chooses the first repeated wall-clock time and shifts a missing time by the DST gap', () => {
    const earlier = wallClock('2026-11-01', 'America/New_York', '01:30:00.000');
    expect(earlier.at.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(earlier.resolution).toBe('earlier');
    const shifted = wallClock('2026-03-08', 'America/New_York', '02:30:00.000');
    expect(shifted.at.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(shifted).toMatchObject({ resolution: 'shift_forward', adjustment: 3600 });
  });
  it('uses 23/25-hour natural days and preserves the real second occurrence of current as_of', () => {
    const spring = reportRanges(
      '2026-03-08',
      '2026-03-09',
      'America/New_York',
      new Date('2026-03-10Z'),
    );
    expect(spring.current.end.getTime() - spring.current.start.getTime()).toBe(23 * 3600_000);
    const fall = reportRanges(
      '2026-11-01',
      '2026-11-02',
      'America/New_York',
      new Date('2026-11-03Z'),
    );
    expect(fall.current.end.getTime() - fall.current.start.getTime()).toBe(25 * 3600_000);
    const current = reportRanges(
      '2026-11-01',
      '2026-11-02',
      'America/New_York',
      new Date('2026-11-01T06:30Z'),
    );
    expect(current.current.end.toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });
  it('produces previous partial end with explicit DST resolution and unifies full/partial date slices', () => {
    const spring = reportRanges(
      '2026-03-09',
      '2026-03-10',
      'America/New_York',
      new Date('2026-03-09T06:30Z'),
    );
    expect(spring.previous.end.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(spring.comparison.dst_adjustment_seconds).toBe(3600);
    const r = reportRanges('2026-11-03', '2026-11-05', 'UTC', new Date('2026-11-04T10:00Z'));
    expect(daySlices(r.current, 'UTC').map((s) => s.full)).toEqual([true, false]);
  });
  it('rejects invalid, oversized and future dates, distinguishes zero baseline from unavailable', () => {
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2026-13-01')).toBe(false);
    expect(() =>
      reportRanges('2026-11-05', '2026-11-07', 'UTC', new Date('2026-11-05T10:00Z')),
    ).toThrow();
    expect(compareMetric(2, 0)).toEqual({
      previous: 0,
      relative_change: null,
      reason: 'zero_baseline',
    });
    expect(compareMetric(null, 0, 'deletion_rebuild')).toMatchObject({
      reason: 'deletion_rebuild',
    });
    expect(compareMetric(0.5, 0.25, undefined, true).percentage_point_change).toBe(25);
  });
  it('authenticates encrypted selectors and the key version', () => {
    const key = { key: randomBytes(32), keyId: 'test' };
    const selector = {
      site_public_id: 'site_test',
      kind: 'site' as const,
      cutoff_at: '2026-11-05T00:00Z',
      visitor_keys: [],
      scope: 'all_observed_before_cutoff' as const,
    };
    const envelope = encryptSelector(selector, key);
    expect(JSON.stringify(envelope)).not.toContain('site_test');
    expect(decryptSelector(envelope, key.keyId, key)).toEqual(selector);
    expect(() =>
      decryptSelector({ ...envelope, tag: randomBytes(16).toString('base64') }, key.keyId, key),
    ).toThrow();
    expect(() => decryptSelector(envelope, 'wrong', key)).toThrow();
  });
});
