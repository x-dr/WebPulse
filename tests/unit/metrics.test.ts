import { describe, expect, it } from 'vitest';
import { closedSessionMetrics } from '../../packages/shared/src/metrics.js';

describe('closed session metric contract', () => {
  it('keeps empty denominators unavailable instead of reporting zero', () => {
    expect(closedSessionMetrics({ closed_sessions: 0, bounced_sessions: 0, active_ms: 0 })).toEqual(
      { bounce_rate: null, avg_active_ms: null },
    );
  });

  it('calculates ratios and full duration without truncation', () => {
    expect(
      closedSessionMetrics({ closed_sessions: 4, bounced_sessions: 1, active_ms: 1_452_000 }),
    ).toEqual({ bounce_rate: 0.25, avg_active_ms: 363_000 });
  });

  it.each([
    { closed_sessions: 1, bounced_sessions: 2, active_ms: 0 },
    { closed_sessions: -1, bounced_sessions: 0, active_ms: 0 },
    { closed_sessions: 0, bounced_sessions: 0, active_ms: 1 },
    { closed_sessions: 1, bounced_sessions: 0, active_ms: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid totals %j', (input) => {
    expect(() => closedSessionMetrics(input)).toThrow(RangeError);
  });
});
