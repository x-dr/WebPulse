import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
export function summarize(rows) {
  const good = rows.filter((row) => row.status === 204);
  return {
    requests: rows.length,
    accepted: good.length,
    rate_limited: rows.filter((row) => row.status === 429).length,
    busy: rows.filter(
      (row) => row.status === 503 && ['server_busy', 'rate_limited'].includes(row.code),
    ).length,
    errors: rows.filter(
      (row) =>
        row.status !== 204 &&
        row.status !== 429 &&
        !(row.status === 503 && row.code === 'server_busy'),
    ).length,
    responses: Object.fromEntries(
      [...new Set(rows.map((row) => `${row.status}:${row.code ?? 'accepted'}`))].map((code) => [
        code,
        rows.filter((row) => `${row.status}:${row.code ?? 'accepted'}` === code).length,
      ]),
    ),
    p95_ms: percentile(
      good.map((row) => row.ms),
      0.95,
    ),
    p99_ms: percentile(
      good.map((row) => row.ms),
      0.99,
    ),
  };
}

export async function traffic(stack, sites, { seconds, rps, mix = 'baseline' }) {
  const actors = sites.map((site) =>
    Array.from({ length: 16 }, () => ({
      site,
      cid: randomUUID(),
      page: randomUUID(),
      interaction: randomUUID(),
      visible: 0,
    })),
  );
  const rows = [],
    acknowledged = [],
    pending = new Set();
  let dropped = 0;
  const call = async (actor, kind, record = true) => {
    const previous = { page: actor.page, interaction: actor.interaction, visible: actor.visible };
    let events;
    if (kind === 'pv') {
      actor.page = randomUUID();
      actor.interaction = randomUUID();
      actor.visible = 0;
      events = [
        {
          type: 'page_view',
          event_id: actor.page,
          page_view_id: actor.page,
          page: { origin: 'https://site.test', path: '/load/article' },
          reason: 'initial',
        },
      ];
    } else if (kind === 'interaction')
      events = [
        {
          type: 'interaction',
          event_id: actor.interaction,
          page_view_id: actor.page,
          interaction_kind: 'click',
        },
      ];
    else actor.visible += 100;
    const started = performance.now();
    let result;
    try {
      result = await stack.request(
        `/api/v1/${kind === 'heartbeat' ? 'heartbeat' : 'collect'}`,
        'POST',
        {
          site_id: actor.site,
          cid: actor.cid,
          consent: 'granted',
          ...(events ? { events } : { page_view_id: actor.page, total_visible_ms: actor.visible }),
        },
        { origin: 'https://site.test', 'user-agent': 'WebPulseAcceptance' },
      );
    } catch {
      result = { status: 0, text: '' };
    }
    let code;
    if (result.status >= 400) {
      try {
        code = result.json().error?.code;
      } catch {
        code = 'proxy_rejection';
      }
    }
    if (record)
      rows.push({
        kind,
        site: sites.indexOf(actor.site),
        status: result.status,
        code,
        ms: performance.now() - started,
      });
    if (kind === 'pv' && result.status === 204) acknowledged.push(events[0].event_id);
    if (kind === 'pv' && result.status !== 204) Object.assign(actor, previous);
    if (!record && result.status !== 204) throw new Error('Traffic warm-up failed');
  };
  for (const list of actors) for (const actor of list) await call(actor, 'pv', false);
  const started = performance.now();
  const count = Math.floor(seconds * rps);
  for (let i = 0; i < count; i++) {
    const delay = started + (i * 1000) / rps - performance.now();
    if (delay > 0) await new Promise((resolveWait) => setTimeout(resolveWait, delay));
    if (pending.size >= 64) {
      dropped++;
      continue;
    }
    const siteIndex = i % 10 < 6 ? 0 : (i % 10) - 5;
    const actor = actors[siteIndex][Math.floor(i / 10) % 16];
    const position = i % 10;
    const kind =
      mix === 'eight-heartbeats'
        ? position === 0
          ? 'pv'
          : position === 9
            ? 'interaction'
            : 'heartbeat'
        : position < 3
          ? 'pv'
          : position === 9
            ? 'interaction'
            : 'heartbeat';
    const task = (actor.pending ?? Promise.resolve())
      .then(() => call(actor, kind))
      .finally(() => pending.delete(task));
    actor.pending = task;
    pending.add(task);
  }
  await Promise.all(pending);
  return {
    duration_seconds: (performance.now() - started) / 1000,
    rps,
    mix,
    dropped,
    ...summarize(rows),
    cold_sites: summarize(rows.filter((row) => row.site !== 0)),
    operations: Object.fromEntries(
      ['pv', 'heartbeat', 'interaction'].map((kind) => [
        kind,
        summarize(rows.filter((row) => row.kind === kind)),
      ]),
    ),
    acknowledged,
  };
}
