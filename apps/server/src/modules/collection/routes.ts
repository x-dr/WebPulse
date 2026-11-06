import {
  CollectSchema,
  HeartbeatSchema,
  type CollectBody,
  type HeartbeatBody,
} from '@webpulse/shared';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type pg from 'pg';
import type { SecurityConfig } from '../../config/security.js';
import { transaction } from '../../db/transaction.js';
import { FairGate, RateLimits, requestBudget } from '../../http/budget.js';
import { ApiError } from '../../http/errors.js';
import { canonicalIp, identityKey } from '../identity/keys.js';
import { checkSite, lockSite, rulesFor } from '../sites/store.js';
import { lockVisitor, markDirty, type CollectionContext } from './context.js';
import { acceptEvents } from './events.js';
import { acceptHeartbeat } from './heartbeat.js';

export function registerCollection(app: FastifyInstance, pool: pg.Pool, security: SecurityConfig) {
  const gate = new FairGate();
  const limits = new RateLimits();
  const cors = (reply: FastifyReply, origin: string) =>
    reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    body: CollectBody | HeartbeatBody,
  ) {
    if (request.headers['sec-gpc'] === '1' || request.headers.dnt === '1')
      throw new ApiError(403, 'privacy_opt_out');
    const siteId = body.site_id;
    const clientIp = canonicalIp(request.ip);
    const ip = identityKey(security.ipKey, 'ip', siteId, 1, clientIp);
    const rateKey = identityKey(security.visitorKey, 'rate', siteId, 1, body.cid).toString('hex');
    limits.take(`site:${siteId}`, 60, 60);
    limits.take(`events:${siteId}`, 600, 600, 'events' in body ? body.events.length : 1);
    limits.take(`visitor:${rateKey}`, 60, 2);
    limits.take(`ip:${ip.toString('hex')}`, 120, 10);
    const release = await gate.acquire(siteId, requestBudget(request).signal);
    try {
      await transaction(pool, requestBudget(request), async (client) => {
        const site = await lockSite(client, siteId);
        checkSite(site, request.headers.origin);
        cors(reply, request.headers.origin!);
        const rules = rulesFor(site.config);
        if (
          rules.exclude_bots &&
          /bot\b|crawler|spider|headless|slurp/i.test(request.headers['user-agent'] ?? '')
        )
          return;
        if (
          'events' in body &&
          body.events.some(
            (event) => event.type === 'page_view' && event.page.origin !== request.headers.origin,
          )
        )
          throw new ApiError(403, 'origin_denied');
        const key = identityKey(security.visitorKey, 'visitor', siteId, site.key_version, body.cid);
        const visitor = await lockVisitor(client, site, key);
        const now = (await client.query<{ now: string }>('SELECT clock_timestamp()::text AS now'))
          .rows[0]!.now;
        const ctx: CollectionContext = {
          client,
          site,
          key,
          ipKey: identityKey(security.ipKey, 'ip', siteId, site.key_version, clientIp),
          clientIp,
          now,
          visitor,
          rules,
          dirty: new Set(),
        };
        try {
          if ('events' in body) await acceptEvents(ctx, body.events);
          else await acceptHeartbeat(ctx, body);
        } catch (error) {
          if (typeof error === 'object' && error && 'code' in error && error.code === '23505')
            throw new ApiError(409, 'event_conflict');
          throw error;
        }
        await markDirty(ctx);
      });
    } finally {
      release();
    }
    reply.code(204).send();
  }
  app.get<{ Params: { site_id: string } }>(
    '/api/v1/tracker-config/:site_id',
    async (request, reply) => {
      if (request.headers['sec-gpc'] === '1' || request.headers.dnt === '1')
        throw new ApiError(403, 'privacy_opt_out');
      const release = await gate.acquire(request.params.site_id, requestBudget(request).signal);
      try {
        const data = await transaction(pool, requestBudget(request), async (client) => {
          const site = await lockSite(client, request.params.site_id);
          checkSite(site, request.headers.origin);
          return { rules: rulesFor(site.config), rule_version: site.rule_version };
        });
        cors(reply, request.headers.origin!).header('cache-control', 'no-store');
        return { data };
      } finally {
        release();
      }
    },
  );
  app.register(async (collection) => {
    collection.removeContentTypeParser('text/plain');
    collection.addContentTypeParser(
      'text/plain',
      { parseAs: 'string', bodyLimit: 16 * 1024 },
      (_request, body, done) => {
        try {
          done(null, JSON.parse(body as string));
        } catch {
          done(new ApiError(400, 'invalid_schema'));
        }
      },
    );
    collection.post<{ Body: CollectBody }>(
      '/api/v1/collect',
      { schema: { body: CollectSchema } },
      (req, reply) => handle(req, reply, req.body),
    );
    collection.post<{ Body: HeartbeatBody }>(
      '/api/v1/heartbeat',
      { schema: { body: HeartbeatSchema } },
      (req, reply) => handle(req, reply, req.body),
    );
    for (const path of ['/api/v1/collect', '/api/v1/heartbeat'])
      collection.options(path, async (request, reply) => {
        if (
          !request.headers.origin ||
          request.headers.origin === 'null' ||
          request.headers['access-control-request-method'] !== 'POST' ||
          (request.headers['access-control-request-headers'] ?? '')
            .split(',')
            .some((value) => value.trim() && value.trim().toLowerCase() !== 'content-type')
        )
          throw new ApiError(403, 'origin_denied');
        const release = await gate.acquire('preflight', requestBudget(request).signal);
        try {
          await transaction(pool, requestBudget(request), async (client) => {
            if (
              !(
                await client.query(
                  "SELECT 1 FROM sites WHERE enabled AND maintenance_state='active' AND allowed_origins ? $1 LIMIT 1",
                  [request.headers.origin],
                )
              ).rowCount
            )
              throw new ApiError(403, 'origin_denied');
          });
        } finally {
          release();
        }
        cors(reply, request.headers.origin)
          .header('access-control-allow-methods', 'POST')
          .header('access-control-allow-headers', 'Content-Type')
          .code(204)
          .send();
      });
  });
}
