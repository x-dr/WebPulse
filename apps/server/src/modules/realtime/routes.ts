import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { RealtimeSnapshot } from '@webpulse/shared';
import { transaction, backgroundBudget } from '../../db/transaction.js';
import { FairGate } from '../../http/budget.js';
import { ApiError } from '../../http/errors.js';
import type { AuthService } from '../auth/routes.js';
import { readRealtime } from './snapshot.js';
import { streamConnection } from './connection.js';

type Subscriber = ReturnType<typeof streamConnection> & {
  admin: string;
  token: string;
  site: string;
};
type Group = {
  subscribers: Set<Subscriber>;
  pending?: Promise<RealtimeSnapshot>;
  snapshot?: RealtimeSnapshot;
  timer?: NodeJS.Timeout;
};
export function registerRealtime(app: FastifyInstance, pool: pg.Pool, auth: AuthService, max = 20) {
  const boot = randomUUID();
  let sequence = 0;
  let stopping = false;
  const subscribers = new Set<Subscriber>();
  const groups = new Map<string, Group>();
  const gate = new FairGate(1, 1, 20, 1);
  function event(sub: Subscriber, name: string, data: unknown) {
    sub.send(`id: ${boot}:${++sequence}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function terminate(sub: Subscriber, name: string) {
    event(sub, name, {});
    // Allow the final frame to reach the peer before releasing the socket.
    setTimeout(sub.close, 10).unref();
  }
  function snapshot(site: string, group: Group) {
    if (!group.pending) {
      group.pending = (async () => {
        const budget = backgroundBudget();
        const release = await gate.acquire(site, budget.signal);
        try {
          const value = await transaction(pool, budget, (c) => readRealtime(c, site), {
            snapshot: true,
          });
          group.snapshot = value;
          return value;
        } finally {
          release();
        }
      })().finally(() => {
        delete group.pending;
      });
    }
    return group.pending;
  }
  async function tick(site: string, group: Group) {
    try {
      const value = await snapshot(site, group);
      if (groups.get(site) === group)
        for (const sub of group.subscribers) event(sub, 'snapshot', value);
    } catch (error) {
      for (const sub of group.subscribers) {
        if (error instanceof ApiError && [404, 409].includes(error.statusCode))
          terminate(sub, 'site_unavailable');
        else event(sub, 'delayed', {});
      }
    }
  }
  app.get<{ Querystring: { site_id: string } }>(
    '/api/v1/realtime',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['site_id'],
          properties: { site_id: { type: 'string', minLength: 8, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const identity = await auth.managed(request, async (c) => {
        await auth.authenticate(c, request, false);
        // Cached snapshots never replace the admission check (CLI/worker changes
        // may not have passed through this process's HTTP invalidation hook).
        const site = (
          await c.query(
            'SELECT enabled,maintenance_state FROM sites WHERE public_id=$1 FOR SHARE',
            [request.query.site_id],
          )
        ).rows[0];
        if (!site) throw new ApiError(404, 'site_not_found');
        if (!site.enabled || site.maintenance_state !== 'active')
          throw new ApiError(409, 'site_unavailable');
        return auth.streamIdentity(c, request);
      });
      if (
        stopping ||
        subscribers.size >= max ||
        [...subscribers].filter((s) => s.admin === identity.admin).length >= 3
      )
        throw new ApiError(429, 'stream_limit');
      const site = request.query.site_id;
      let group = groups.get(site);
      if (!group) {
        group = { subscribers: new Set() };
        groups.set(site, group);
      }
      const current = group;
      // Reserve before awaiting the shared query, so simultaneous handshakes obey limits.
      const connection = streamConnection(reply.raw, () => {
        subscribers.delete(sub);
        current.subscribers.delete(sub);
        if (!current.subscribers.size) {
          clearInterval(current.timer);
          if (groups.get(site) === current) groups.delete(site);
        }
      });
      const sub: Subscriber = { ...connection, ...identity, site };
      subscribers.add(sub);
      current.subscribers.add(sub);
      try {
        const value = current.snapshot ?? (await snapshot(site, current));
        if (request.raw.aborted || reply.raw.destroyed || stopping) return sub.close();
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'private, no-cache, no-transform',
          'x-accel-buffering': 'no',
        });
        sub.send('retry: 5000\n\n');
        event(sub, request.headers['last-event-id'] ? 'reset' : 'snapshot', value);
        if (!current.timer)
          current.timer = setInterval(() => {
            void tick(site, current);
          }, 5000).unref();
      } catch (error) {
        // Before headers: retain the ordinary JSON error response.
        subscribers.delete(sub);
        current.subscribers.delete(sub);
        if (!current.subscribers.size) {
          clearInterval(current.timer);
          if (groups.get(site) === current) groups.delete(site);
        }
        throw error;
      }
    },
  );
  const ping = setInterval(() => {
    for (const sub of subscribers) sub.send(`: ping ${new Date().toISOString()}\n\n`);
  }, 15000).unref();
  let validating = false;
  const validate = setInterval(() => {
    if (validating || !subscribers.size) return;
    validating = true;
    void transaction(pool, backgroundBudget(), async (c) => {
      const tokens = [...new Set([...subscribers].map((s) => s.token))];
      const valid = new Set(
        (
          await c.query(
            `SELECT encode(token_hash,'hex') AS token FROM admin_sessions WHERE token_hash=ANY($1::bytea[]) AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '24 hours'`,
            [tokens.map((t) => Buffer.from(t, 'hex'))],
          )
        ).rows.map((r) => r.token),
      );
      for (const sub of subscribers) if (!valid.has(sub.token)) terminate(sub, 'auth_expired');
    })
      .catch(() => {
        for (const sub of subscribers) terminate(sub, 'delayed');
      })
      .finally(() => {
        validating = false;
      });
  }, 60000).unref();
  const unsubscribe = auth.onLogout((token) => {
    for (const sub of subscribers) if (sub.token === token) terminate(sub, 'auth_expired');
  });
  app.addHook('onResponse', async (request, reply) => {
    if (
      reply.statusCode < 300 &&
      ['PATCH', 'DELETE'].includes(request.method) &&
      request.routeOptions.url === '/api/v1/sites/:site_id'
    ) {
      const site = (request.params as { site_id: string }).site_id;
      for (const sub of groups.get(site)?.subscribers ?? []) terminate(sub, 'site_unavailable');
    }
  });
  app.addHook('preClose', async () => {
    stopping = true;
    clearInterval(ping);
    clearInterval(validate);
    unsubscribe();
    const pending = [...groups.values()].map((g) => g.pending);
    for (const sub of [...subscribers]) sub.close();
    await Promise.allSettled(pending);
  });
}
