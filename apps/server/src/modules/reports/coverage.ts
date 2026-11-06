import type pg from 'pg';
import type { Site } from '../sites/store.js';
import { localParts, type TimeRange } from './time.js';

export type CoverageRow = {
  layer: string;
  observed_from: Date;
  available_from: Date;
  available_through: Date;
  finalized_through: Date | null;
  revision: string;
};
export type Coverage = {
  rows: CoverageRow[];
  gaps: { layer: string; start_utc: Date; end_utc: Date; reason: string }[];
};
// A site's first natural day starts when collection became possible. Earlier
// dates remain unavailable rather than becoming fabricated zero-traffic days.
export function observedRange(coverage: Coverage, range: TimeRange, zone: string): TimeRange {
  const observed = coverage.rows.find((row) => row.layer === 'raw_pv')?.observed_from;
  return observed &&
    observed > range.start &&
    observed < range.end &&
    localParts(observed, zone).date === localParts(range.start, zone).date
    ? { ...range, start: observed }
    : range;
}
export async function readCoverage(client: pg.PoolClient, site: Site): Promise<Coverage> {
  return {
    rows: (
      await client.query<CoverageRow>('SELECT * FROM site_data_coverage WHERE site_id=$1', [
        site.id,
      ])
    ).rows,
    gaps: (
      await client.query(
        'SELECT layer,start_utc,end_utc,reason FROM coverage_gaps WHERE site_id=$1 AND resolved_at IS NULL',
        [site.id],
      )
    ).rows,
  };
}
export function unavailable(
  coverage: Coverage,
  layer: string,
  start: Date,
  end: Date,
): string | undefined {
  const gap = coverage.gaps.find(
    (g) => g.layer === layer && g.start_utc < end && g.end_utc > start,
  );
  if (gap) return gap.reason;
  const row = coverage.rows.find((r) => r.layer === layer);
  if (!row) return 'coverage_unknown';
  if (start < row.observed_from) return 'before_site_created';
  if (start < row.available_from)
    return layer.includes('members')
      ? 'distinct_retention_exceeded'
      : layer === 'sessions'
        ? 'historical_sessions_unavailable'
        : layer === 'raw_pv'
          ? 'partial_range_raw_unavailable'
          : 'aggregate_retention_exceeded';
  return undefined;
}
export function epochReason(site: Site, start: Date, end: Date) {
  const epochs = site.config.identity_epochs as { effective_at?: string }[] | undefined;
  if (
    epochs?.some(
      (epoch, i) =>
        i > 0 &&
        epoch.effective_at &&
        new Date(epoch.effective_at) > start &&
        new Date(epoch.effective_at) < end,
    )
  )
    return 'identity_epoch_boundary';
  return undefined;
}
