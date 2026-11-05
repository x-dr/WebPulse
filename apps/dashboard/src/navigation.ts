import { useEffect, useState } from 'react';
import type { Site } from './api/types.js';

export type Scope = { site: Site; start: string; end: string };
export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function today(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts();
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function validRange(start: string, end: string, timezone: string) {
  const valid = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    Number.isFinite(Date.parse(d)) &&
    new Date(d).toISOString().slice(0, 10) === d;
  if (!valid(start) || !valid(end)) return false;
  const length = (Date.parse(end) - Date.parse(start)) / 86400000;
  return (
    length > 0 && length <= 365 && start <= today(timezone) && end <= addDays(today(timezone), 1)
  );
}
export function useNavigation() {
  const [url, setUrl] = useState(() => new URL(window.location.href));
  useEffect(() => {
    const update = () => setUrl(new URL(window.location.href));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const navigate = (path: string, changes: Record<string, string | null> = {}) => {
    const next = new URL(path, window.location.origin);
    for (const name of ['site_id', 'start_date', 'end_date']) {
      if (!next.searchParams.has(name) && url.searchParams.has(name))
        next.searchParams.set(name, url.searchParams.get(name)!);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.searchParams.delete(key);
      else next.searchParams.set(key, value);
    }
    window.history.pushState({}, '', next.pathname + next.search);
    setUrl(next);
  };
  return { url, navigate };
}
export type Navigate = ReturnType<typeof useNavigation>['navigate'];
