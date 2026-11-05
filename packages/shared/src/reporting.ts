import { Type, type Static } from '@sinclair/typebox';

export const reportMetrics = [
  'pv',
  'uv',
  'ip',
  'sessions',
  'closed_sessions',
  'bounced_sessions',
  'total_closed_active_ms',
  'bounce_rate',
  'avg_active_ms',
  'new_visitors',
  'returning_visitors',
] as const;
export type ReportMetric = (typeof reportMetrics)[number];
export type ReportValues = Record<ReportMetric, number | null>;
export type UnavailableReasons = Partial<Record<ReportMetric, string>>;
export const ReportQuerySchema = Type.Object(
  {
    site_id: Type.String({ minLength: 8, maxLength: 64 }),
    start_date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    end_date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    timezone: Type.Optional(Type.String({ maxLength: 80 })),
  },
  { additionalProperties: false },
);
export type ReportQuery = Static<typeof ReportQuerySchema>;
export type ReportComparison = {
  previous: number | null;
  relative_change: number | null;
  percentage_point_change?: number | null;
  reason?: string;
};
export function compareMetric(
  current: number | null,
  previous: number | null,
  reason?: string,
  percentage = false,
): ReportComparison {
  return {
    previous,
    relative_change:
      reason || current === null || previous === null || previous === 0
        ? null
        : (current - previous) / previous,
    ...(percentage
      ? {
          percentage_point_change:
            reason || current === null || previous === null ? null : (current - previous) * 100,
        }
      : {}),
    ...(reason || current === null || previous === null
      ? { reason: reason ?? 'no_closed_sessions' }
      : previous === 0
        ? { reason: 'zero_baseline' }
        : {}),
  };
}
