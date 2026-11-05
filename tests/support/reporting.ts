import { randomUUID, createHash } from 'node:crypto';
import type { Fixture } from './postgres.js';
import { maintenanceConnection } from '../../apps/server/src/modules/aggregation/connection.js';

export const key = (value: string) => createHash('sha256').update(value).digest();
export type SampleSession = {
  visitor: string;
  epoch?: number;
  start: string;
  closed?: string;
  path?: string;
  source?: string;
  active?: number;
  interaction?: number;
  pages: { at: string; path: string; ip?: string }[];
};
export async function observe(f: Fixture, at = '2026-10-30T00:00:00Z') {
  await f.pool.query(
    "UPDATE sites SET created_at=$1,config=jsonb_set(config,'{identity_epochs}',jsonb_build_array(jsonb_build_object('visitor',1,'ip',1,'effective_at',$1::timestamptz)))",
    [at],
  );
  await f.pool.query(
    'UPDATE site_data_coverage SET observed_from=$1,available_from=$1,available_through=clock_timestamp()',
    [at],
  );
}
export async function seed(f: Fixture, samples: SampleSession[]) {
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    const site = (await client.query('SELECT id,timezone FROM sites WHERE public_id=$1', [f.site]))
      .rows[0];
    for (const s of samples) {
      const visitor = key(s.visitor);
      await client.query(
        `INSERT INTO visitors(site_id,visitor_key,first_seen_pv_at,last_activity_at,latest_path,key_version) VALUES ($1,$2,$3,$3,$4,$5) ON CONFLICT(site_id,visitor_key) DO UPDATE SET first_seen_pv_at=least(visitors.first_seen_pv_at,excluded.first_seen_pv_at)`,
        [site.id, visitor, s.start, s.path ?? s.pages[0]!.path, s.epoch ?? 1],
      );
      const session = randomUUID();
      const last = s.pages.at(-1)!.at;
      await client.query(
        `INSERT INTO sessions(site_id,id,visitor_key,status,started_at,last_activity_at,ended_at,closed_at,close_reason,entry_path,exit_path,source_channel,page_views,interactions,active_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          site.id,
          session,
          visitor,
          s.closed ? 'closed' : 'open',
          s.start,
          last,
          s.closed ? last : null,
          s.closed ?? null,
          s.closed ? 'timeout' : null,
          s.pages[0]!.path,
          s.pages.at(-1)!.path,
          s.source ?? 'direct',
          s.pages.length,
          s.interaction ?? 0,
          s.active ?? 0,
        ],
      );
      for (const p of s.pages) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO events(site_id,event_id,session_id,visitor_key,ip_key,event_type,page_view_id,path,occurred_at,received_at,local_date,payload_fingerprint,rule_version,first_seen_pv_at) SELECT $1,$2,$3,$4,$5,'page_view',$2,$6,$7,$7,($7::timestamptz AT TIME ZONE $8)::date,$9,1,first_seen_pv_at FROM visitors WHERE site_id=$1 AND visitor_key=$4`,
          [
            site.id,
            id,
            session,
            visitor,
            key(p.ip ?? 'shared'),
            p.path,
            p.at,
            site.timezone,
            key(id),
          ],
        );
        await client.query(
          'INSERT INTO page_views(site_id,id,session_id,occurred_at) VALUES ($1,$2,$3,$4)',
          [site.id, id, session, p.at],
        );
      }
      await client.query('UPDATE events SET key_version=$3 WHERE site_id=$1 AND session_id=$2', [
        site.id,
        session,
        s.epoch ?? 1,
      ]);
    }
    await client.query(
      `INSERT INTO visitor_days SELECT site_id,local_date,visitor_key,min(first_seen_pv_at) FROM events GROUP BY site_id,local_date,visitor_key ON CONFLICT DO NOTHING`,
    );
    await client.query(
      'INSERT INTO ip_days SELECT DISTINCT site_id,local_date,ip_key FROM events ON CONFLICT DO NOTHING',
    );
    await client.query(
      `INSERT INTO distinct_hours SELECT site_id,date_trunc('hour',occurred_at),1::smallint,visitor_key,min(first_seen_pv_at) FROM events GROUP BY site_id,date_trunc('hour',occurred_at),visitor_key UNION SELECT DISTINCT site_id,date_trunc('hour',occurred_at),2::smallint,ip_key,NULL::timestamptz FROM events ON CONFLICT DO NOTHING`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function maintained<T>(
  f: Fixture,
  work: (client: Parameters<Parameters<typeof maintenanceConnection>[1]>[0]) => Promise<T>,
) {
  return (await maintenanceConnection(f.pool, work))!;
}
