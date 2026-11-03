export const METRIC_VERSION = 1;
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_MAX_DURATION_MS = 12 * 60 * 60 * 1000;

// Count only closed sessions in this denominator. No ended sessions means unavailable.
export function closedSessionMetrics(input: {
  closed_sessions: number;
  bounced_sessions: number;
  active_ms: number;
}): { bounce_rate: number | null; avg_active_ms: number | null } {
  const { closed_sessions, bounced_sessions, active_ms } = input;
  if (
    ![closed_sessions, bounced_sessions, active_ms].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    bounced_sessions > closed_sessions ||
    (closed_sessions === 0 && active_ms !== 0)
  ) {
    throw new RangeError('Invalid closed session totals');
  }
  return {
    bounce_rate: closed_sessions === 0 ? null : bounced_sessions / closed_sessions,
    avg_active_ms: closed_sessions === 0 ? null : active_ms / closed_sessions,
  };
}
