import type pg from 'pg';
import type { Site } from '../sites/store.js';
import { addDays, localParts, wallClock } from '../reports/time.js';

export type RetentionSettings = {
  raw_retention_days: number;
  member_retention_days: number;
  aggregate_retention_days: number;
};
export function validRetention(settings: RetentionSettings) {
  return (
    Number.isInteger(settings.raw_retention_days) &&
    settings.raw_retention_days >= 7 &&
    settings.raw_retention_days <= 30 &&
    Number.isInteger(settings.member_retention_days) &&
    settings.member_retention_days >= 30 &&
    settings.member_retention_days <= 90 &&
    Number.isInteger(settings.aggregate_retention_days) &&
    settings.aggregate_retention_days >= 90 &&
    settings.aggregate_retention_days <= 365 &&
    settings.raw_retention_days <= settings.member_retention_days &&
    settings.member_retention_days <= settings.aggregate_retention_days
  );
}
export async function retentionPlan(
  client: pg.PoolClient,
  site: Site,
  settings: RetentionSettings = site,
) {
  const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const today = localParts(now, site.timezone).date;
  const coverage = (
    await client.query('SELECT * FROM site_data_coverage WHERE site_id=$1', [site.id])
  ).rows;
  const frozen = coverage
    .filter((c) => ['day_aggregates', 'hour_aggregates'].includes(c.layer))
    .map((c) => c.finalized_through as Date | null);
  const safe = frozen.every(Boolean)
    ? new Date(Math.min(...frozen.map((v) => v!.getTime())))
    : null;
  let safeDay = safe ? wallClock(localParts(safe, site.timezone).date, site.timezone).at : null;
  const gap = (
    await client.query(
      "SELECT min(start_utc) AS start FROM coverage_gaps WHERE site_id=$1 AND resolved_at IS NULL AND reason<>'retention_cleanup'",
      [site.id],
    )
  ).rows[0].start as Date | null;
  if (gap && safeDay && gap < safeDay)
    safeDay = wallClock(localParts(gap, site.timezone).date, site.timezone).at;
  return coverage.map((c) => {
    const days = c.layer.includes('aggregates')
      ? settings.aggregate_retention_days
      : c.layer.includes('members')
        ? settings.member_retention_days
        : settings.raw_retention_days;
    const requested = wallClock(addDays(today, -days), site.timezone).at;
    const target =
      c.cleanup_target ??
      new Date(
        Math.max(
          c.available_from.getTime(),
          safeDay ? Math.min(requested.getTime(), safeDay.getTime()) : c.available_from.getTime(),
        ),
      );
    return {
      layer: c.layer,
      available_from: c.available_from.toISOString(),
      requested_target: requested.toISOString(),
      safe_target: target.toISOString(),
      in_progress: Boolean(c.cleanup_target),
      capability_loss: c.layer.includes('members')
        ? 'range_distinct'
        : c.layer === 'raw_pv'
          ? 'partial_range_raw'
          : c.layer === 'sessions'
            ? 'historical_session_cutoff'
            : 'historical_aggregates',
    };
  });
}
