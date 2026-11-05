import { ApiError } from '../../http/errors.js';

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 100) formatters.clear();
    formatters.set(zone, value);
  }
  return value;
}
export function localParts(at: Date, zone: string) {
  const p = Object.fromEntries(
    formatter(zone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}:${p.second}.${String(at.getUTCMilliseconds()).padStart(3, '0')}`,
  };
}
export function offsetSeconds(at: Date, zone: string) {
  const p = localParts(at, zone);
  return (Date.parse(`${p.date}T${p.time}Z`) - at.getTime()) / 1000;
}
export function validDate(date: string) {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    date >= '1970-01-01' &&
    date <= '9998-12-31' &&
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === date
  );
}
export function addDays(date: string, days: number) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
// Explicitly enumerate offsets on both sides of a transition. PostgreSQL's
// default ambiguous-wall-clock choice differs from this project's earlier policy.
export function wallClock(date: string, zone: string, time = '00:00:00.000') {
  const wall = Date.parse(`${date}T${time}Z`);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6)
    offsets.add(offsetSeconds(new Date(wall + hours * 3600_000), zone));
  const candidates = [...offsets].map((offset) => new Date(wall - offset * 1000));
  const matches = candidates
    .filter((at) => {
      const parts = localParts(at, zone);
      return Date.parse(`${parts.date}T${parts.time}Z`) === wall;
    })
    .sort((a, b) => a.getTime() - b.getTime());
  if (matches.length)
    return { at: matches[0]!, resolution: matches.length > 1 ? 'earlier' : 'exact', adjustment: 0 };
  const shifted = candidates
    .map((at) => {
      const parts = localParts(at, zone);
      return { at, delta: Date.parse(`${parts.date}T${parts.time}Z`) - wall };
    })
    .filter((v) => v.delta > 0)
    .sort((a, b) => a.delta - b.delta)[0];
  if (!shifted) throw new ApiError(400, 'invalid_local_time');
  return { at: shifted.at, resolution: 'shift_forward', adjustment: shifted.delta / 1000 };
}
export type TimeRange = {
  start: Date;
  end: Date;
  requestedEnd: Date;
  partial: boolean;
  startDate: string;
  endDate: string;
};
export function reportRanges(startDate: string, endDate: string, zone: string, asOf: Date) {
  if (!validDate(startDate) || !validDate(endDate) || startDate >= endDate)
    throw new ApiError(400, 'invalid_date_range');
  const days = (Date.parse(`${endDate}T00:00Z`) - Date.parse(`${startDate}T00:00Z`)) / 86400_000;
  if (days > 366) throw new ApiError(400, 'range_too_large');
  const today = localParts(asOf, zone);
  if (startDate > today.date || endDate > addDays(today.date, 1))
    throw new ApiError(400, 'future_range');
  const start = wallClock(startDate, zone).at;
  const requestedEnd = wallClock(endDate, zone).at;
  const partial = requestedEnd > asOf;
  const current: TimeRange = {
    start,
    end: partial ? asOf : requestedEnd,
    requestedEnd,
    partial,
    startDate,
    endDate,
  };
  const previousStartDate = addDays(startDate, -days);
  const previousEndDate = addDays(endDate, -days);
  const resolved = partial
    ? wallClock(addDays(today.date, -days), zone, today.time)
    : wallClock(previousEndDate, zone);
  const previous: TimeRange = {
    start: wallClock(previousStartDate, zone).at,
    end: resolved.at,
    requestedEnd: wallClock(previousEndDate, zone).at,
    partial,
    startDate: previousStartDate,
    endDate: previousEndDate,
  };
  return {
    current,
    previous,
    comparison: {
      mode: 'previous_period_local_wall_clock',
      previous_start_utc: previous.start.toISOString(),
      previous_end_utc: previous.end.toISOString(),
      comparison_as_of: partial ? previous.end.toISOString() : null,
      session_cutoff: partial ? 'closed_at_lte_comparison_as_of' : 'current_snapshot_closed',
      dst_policy: 'earlier_or_shift_forward',
      dst_resolution: resolved.resolution,
      dst_adjustment_seconds: resolved.adjustment,
      current_utc_offset_seconds: offsetSeconds(current.end, zone),
      previous_utc_offset_seconds: offsetSeconds(previous.end, zone),
    },
  };
}
export function daySlices(range: TimeRange, zone: string) {
  const result: { date: string; start: Date; end: Date; full: boolean }[] = [];
  for (let date = localParts(range.start, zone).date; ; date = addDays(date, 1)) {
    const start = wallClock(date, zone).at;
    if (start >= range.end) break;
    const end = wallClock(addDays(date, 1), zone).at;
    result.push({
      date,
      start: new Date(Math.max(start.getTime(), range.start.getTime())),
      end: new Date(Math.min(end.getTime(), range.end.getTime())),
      full: start >= range.start && end <= range.end,
    });
  }
  return result;
}
