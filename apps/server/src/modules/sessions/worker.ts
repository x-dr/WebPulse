import type pg from 'pg';
import { backgroundBudget, transaction } from '../../db/transaction.js';
import { lockSite, rulesFor } from '../sites/store.js';
import { lockVisitor, markDirty, type CollectionContext } from '../collection/context.js';
import { closeSession, type Session } from './store.js';

export function sessionCloser(pool: pg.Pool) {
  let running = false;
  let cursor = '0';
  let pending: Promise<number> | undefined;
  async function run(): Promise<number> {
    if (running) return 0;
    running = true;
    let closed = 0;
    try {
      const sites = await transaction(pool, backgroundBudget(), async (client) => {
        let rows = (
          await client.query<{ id: string; public_id: string }>(
            'SELECT id,public_id FROM sites WHERE id>$1 ORDER BY id LIMIT 5',
            [cursor],
          )
        ).rows;
        if (!rows.length) {
          cursor = '0';
          rows = (
            await client.query<{ id: string; public_id: string }>(
              'SELECT id,public_id FROM sites ORDER BY id LIMIT 5',
            )
          ).rows;
        }
        return rows;
      });
      for (const item of sites) {
        cursor = item.id;
        const due = await transaction(
          pool,
          backgroundBudget(),
          async (client) =>
            (
              await client.query<{ visitor_key: Buffer }>(
                `SELECT visitor_key FROM sessions WHERE site_id=$1 AND status='open' AND
          (last_activity_at<=clock_timestamp()-interval '30 minutes' OR started_at<=clock_timestamp()-interval '12 hours') ORDER BY last_activity_at LIMIT 20`,
                [item.id],
              )
            ).rows,
        );
        for (const candidate of due) {
          closed += await transaction(pool, backgroundBudget(), async (client) => {
            const site = await lockSite(client, item.public_id);
            if (site.maintenance_state !== 'active') return 0;
            const visitor = await lockVisitor(client, site, candidate.visitor_key);
            const now = (
              await client.query<{ now: string }>('SELECT clock_timestamp()::text AS now')
            ).rows[0]!.now;
            if (visitor && Date.parse(now) < visitor.last_activity_at.getTime()) return 0;
            const session = (
              await client.query<Session>(
                `SELECT * FROM sessions WHERE site_id=$1 AND visitor_key=$2 AND status='open' AND
              (last_activity_at<=$3::timestamptz-interval '30 minutes' OR started_at<=$3::timestamptz-interval '12 hours') FOR UPDATE`,
                [site.id, candidate.visitor_key, now],
              )
            ).rows[0];
            if (!session) return 0;
            const ctx: CollectionContext = {
              client,
              site,
              key: candidate.visitor_key,
              ipKey: Buffer.alloc(32),
              now,
              visitor,
              rules: rulesFor(site.config),
              dirty: new Set(),
            };
            await closeSession(ctx, session);
            await markDirty(ctx);
            return 1;
          });
        }
      }
      return closed;
    } finally {
      running = false;
    }
  }
  return {
    run: () => {
      pending = run();
      return pending;
    },
    start() {
      const timer = setInterval(() => {
        pending = run();
        void pending.catch(() => process.stderr.write('Session close cycle unavailable\n'));
      }, 60_000).unref();
      return async () => {
        clearInterval(timer);
        await pending?.catch(() => undefined);
      };
    },
  };
}
