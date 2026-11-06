import type { CollectionRules } from '@webpulse/shared/browser';
import type { ReportComparison, ReportValues } from '@webpulse/shared';

export type Session = { username: string; csrf_token: string; expires_at: string };
export type Retention = {
  raw_retention_days: number;
  member_retention_days: number;
  aggregate_retention_days: number;
};
export type Site = Retention & {
  site_id: string;
  name: string;
  primary_origin: string;
  allowed_origins: string[];
  timezone: string;
  enabled: boolean;
  maintenance_state: string;
  rules: CollectionRules;
  rule_version: number;
  tracker_url: string;
};
export type ReportMeta = {
  timezone: string;
  as_of: string;
  start_utc?: string;
  effective_start_utc?: string;
  effective_end_utc: string;
  is_provisional: boolean;
  aggregation_lag_seconds?: number;
  earliest_exact_distinct_date: string | null;
  unavailable_reasons: Record<string, string>;
  data_coverage: { layer: string; finalized_through: string | null }[];
};
export type Report<T> = { data: T; meta: ReportMeta };
export type Overview = ReportValues & {
  active_visitors_15m: number;
  comparison: Record<string, ReportComparison>;
};
export type Visitors = {
  uv: number | null;
  new_visitors: number | null;
  returning_visitors: number | null;
  new_share: number | null;
  returning_share: number | null;
};
export type Trend = {
  metric: string;
  granularity: string;
  points: {
    start: string;
    end: string;
    value: number | null;
    complete: boolean;
    reason?: string;
  }[];
};
export type RankItem = {
  path?: string;
  channel?: string;
  referrer_host?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  count: number;
  share: number;
};
export type Ranking = {
  unit: string;
  total: number | null;
  items: RankItem[];
  page: number;
  page_size: number;
  total_items: number | null;
  other_count: number | null;
};
export type Job = {
  job_id: string;
  status: string;
  phase: string;
  last_error_code?: string | null;
};
export type Diagnostics = {
  last_accepted_at: string | null;
  pending_buckets: number;
  jobs: Job[];
  rejection_counts: { available: boolean; reason?: string };
  worker: { last_succeeded_at: string | null; last_error_code: string | null } | null;
};
export type RetentionPreview = {
  settings: Retention;
  layers: { layer: string; available_from: string; safe_target: string; capability_loss: string }[];
};
