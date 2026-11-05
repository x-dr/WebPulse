import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, today, validRange } from '../../apps/dashboard/src/navigation.js';

afterEach(() => vi.useRealTimers());
describe('dashboard natural-day filters', () => {
  it('uses the selected site date on opposite sides of UTC midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T23:30:00Z'));
    expect(today('Asia/Shanghai')).toBe('2026-11-06');
    expect(today('America/Los_Angeles')).toBe('2026-11-05');
    expect(validRange('2026-11-06', '2026-11-07', 'Asia/Shanghai')).toBe(true);
    expect(validRange('2026-11-06', '2026-11-07', 'America/Los_Angeles')).toBe(false);
  });
  it('keeps calendar-day boundaries across DST and leap days', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('rejects invalid dates, reversed intervals and ranges over 365 days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    expect(validRange('2026-02-29', '2026-03-01', 'UTC')).toBe(false);
    expect(validRange('2026-11-06', '2026-11-06', 'UTC')).toBe(false);
    expect(validRange('2026-11-06', '2026-11-05', 'UTC')).toBe(false);
    expect(validRange('2025-11-05', '2026-11-06', 'UTC')).toBe(false);
    expect(validRange('2025-11-06', '2026-11-06', 'UTC')).toBe(true);
    expect(validRange('2026-11-06', 'invalid', 'UTC')).toBe(false);
  });
});
