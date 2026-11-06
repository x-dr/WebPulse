import { useQuery } from '@tanstack/react-query';
import { ApiError, isObject, request } from './client';
import type { Report } from './types';
import type { Scope } from '../navigation';

const scalar = (value: unknown) =>
  value === null || (typeof value === 'number' && Number.isFinite(value));
function validData(kind: string, data: Record<string, unknown>) {
  if (kind === 'visits')
    return (
      scalar(data.total_items) &&
      typeof data.page === 'number' &&
      typeof data.page_size === 'number' &&
      Array.isArray(data.items) &&
      data.items.every(
        (p: unknown) =>
          isObject(p) &&
          typeof p.event_id === 'string' &&
          typeof p.path === 'string' &&
          typeof p.at === 'string' &&
          typeof p.channel === 'string' &&
          (p.client_ip === null || typeof p.client_ip === 'string'),
      )
    );
  if (kind === 'trend')
    return (
      Array.isArray(data.points) &&
      data.points.every(
        (p: unknown) =>
          isObject(p) &&
          typeof p.start === 'string' &&
          typeof p.end === 'string' &&
          scalar(p.value),
      )
    );
  if (['sources', 'pages', 'entries'].includes(kind))
    return (
      scalar(data.total) &&
      scalar(data.total_items) &&
      Array.isArray(data.items) &&
      data.items.every(
        (p: unknown) => isObject(p) && typeof p.count === 'number' && typeof p.share === 'number',
      )
    );
  if (kind === 'visitors')
    return ['uv', 'new_visitors', 'returning_visitors', 'new_share', 'returning_share'].every(
      (key) => scalar(data[key]),
    );
  return (
    ['pv', 'uv', 'ip', 'sessions', 'bounce_rate', 'avg_active_ms'].every((key) =>
      scalar(data[key]),
    ) &&
    typeof data.active_visitors_15m === 'number' &&
    isObject(data.comparison)
  );
}

export function useReport<T>(kind: string, scope: Scope, extra: Record<string, string> = {}) {
  const params = {
    site_id: scope.site.site_id,
    start_date: scope.start,
    end_date: scope.end,
    timezone: scope.site.timezone,
    ...extra,
  };
  return useQuery({
    queryKey: ['report', kind, params],
    queryFn: async ({ signal }) => {
      const result = await request<Report<T>>(`/stats/${kind}?${new URLSearchParams(params)}`, {
        signal,
      });
      if (
        !isObject(result.data) ||
        !isObject(result.meta) ||
        !isObject(result.meta.unavailable_reasons) ||
        !Array.isArray(result.meta.data_coverage) ||
        typeof result.meta.as_of !== 'string' ||
        typeof result.meta.timezone !== 'string' ||
        !validData(kind, result.data as Record<string, unknown>)
      ) {
        throw new ApiError(502, 'invalid_response');
      }
      return result;
    },
    staleTime: 30_000,
  });
}
