import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let database: PGlite;

beforeEach(async () => {
  database = new PGlite();
  await database.waitReady;
  // Minimal relational fixtures prove M0 query semantics; these are not migrations
  // or implementations of aggregation, retention, or collection endpoints.
  await database.exec(`
    CREATE TABLE pv(visitor text, ip text, at timestamptz, path text);
    CREATE TABLE members(day date, visitor text);
    CREATE TABLE sessions(started_at timestamptz, closed_at timestamptz, active_ms bigint);
    CREATE TABLE totals(day date PRIMARY KEY, pv bigint, is_final boolean);
    CREATE TABLE pages(day date, path text, pv bigint, PRIMARY KEY(day, path));
    CREATE TABLE dirty(day date PRIMARY KEY);
    INSERT INTO pv VALUES
      ('a', 'shared', '2026-11-02T09:00:00Z', '/a'),
      ('b', 'shared', '2026-11-02T15:00:00Z', '/b'),
      ('a', 'shared', '2026-11-01T09:00:00Z', '/a');
    INSERT INTO members VALUES
      ('2026-11-01', 'a'), ('2026-11-02', 'a'), ('2026-11-02', 'b');
    INSERT INTO sessions VALUES
      ('2026-11-02T09:00:00Z', '2026-11-02T11:30:00Z', 15000),
      ('2026-11-02T08:00:00Z', '2026-11-02T10:00:00Z', 30000),
      ('2026-11-01T23:55:00Z', '2026-11-02T00:40:00Z', 45000);
  `);
});

afterEach(async () => {
  await database.close();
});

describe('M0 SQL design probes on PGlite', () => {
  it('R02 excludes afternoon visitors and the exact upper PV boundary', async () => {
    await database.exec(`INSERT INTO pv VALUES ('c', 'other', '2026-11-02T10:00:00Z', '/c')`);
    const full = await database.query(`
      SELECT count(DISTINCT visitor)::integer AS uv FROM members WHERE day = '2026-11-02'
    `);
    const partial = await database.query(`
      SELECT count(*)::integer AS pv, count(DISTINCT visitor)::integer AS uv,
             count(DISTINCT ip)::integer AS ip
      FROM pv WHERE at >= '2026-11-02T00:00:00Z' AND at < '2026-11-02T10:00:00Z'
    `);
    expect(full.rows).toEqual([{ uv: 2 }]);
    expect(partial.rows).toEqual([{ pv: 1, uv: 1, ip: 1 }]);
  });

  it('R02 deduplicates visitors across full-day members and partial-day facts', async () => {
    const result = await database.query(`
      WITH people AS (
        SELECT visitor FROM members WHERE day = '2026-11-01'
        UNION
        SELECT visitor FROM pv
        WHERE at >= '2026-11-02T00:00:00Z' AND at < '2026-11-02T10:00:00Z'
      ) SELECT count(*)::integer AS uv FROM people
    `);
    expect(result.rows).toEqual([{ uv: 1 }]);
  });

  it('R02 applies the actual historical close cutoff and start-date attribution', async () => {
    const result = await database.query(`
      SELECT count(*)::integer AS sessions,
             count(*) FILTER (WHERE closed_at <= '2026-11-02T10:00:00Z')::integer AS closed,
             sum(active_ms) FILTER (WHERE closed_at <= '2026-11-02T10:00:00Z')::integer AS ms
      FROM sessions
      WHERE started_at >= '2026-11-02T00:00:00Z' AND started_at < '2026-11-02T10:00:00Z'
    `);
    expect(result.rows).toEqual([{ sessions: 2, closed: 1, ms: 30000 }]);
  });

  it('R05 replaces disappearing groups and preserves a covered zero total', async () => {
    const rebuild = async () => {
      await database.exec(`
        BEGIN;
        DELETE FROM pages WHERE day = '2026-11-02';
        INSERT INTO pages
          SELECT '2026-11-02'::date, path, count(*) FROM pv
          WHERE at >= '2026-11-02T00:00:00Z' AND at < '2026-11-03T00:00:00Z'
          GROUP BY path;
        INSERT INTO totals
          SELECT '2026-11-02'::date, count(*), false FROM pv
          WHERE at >= '2026-11-02T00:00:00Z' AND at < '2026-11-03T00:00:00Z'
          ON CONFLICT(day) DO UPDATE SET pv = excluded.pv, is_final = false;
        COMMIT;
      `);
    };
    await rebuild();
    await database.exec("DELETE FROM pv WHERE visitor = 'a'");
    await rebuild();
    expect((await database.query('SELECT path, pv::integer FROM pages')).rows).toEqual([
      { path: '/b', pv: 1 },
    ]);
    // A shared IP still belongs to the remaining visitor.
    expect((await database.query('SELECT count(DISTINCT ip)::integer AS ip FROM pv')).rows).toEqual(
      [{ ip: 1 }],
    );
    await database.exec('DELETE FROM pv');
    await rebuild();
    await rebuild();
    expect((await database.query('SELECT path FROM pages')).rows).toEqual([]);
    expect((await database.query('SELECT pv::integer FROM totals')).rows).toEqual([{ pv: 0 }]);
  });

  it('R01 finds an overdue non-final bucket even when the dirty queue is empty', async () => {
    await database.exec("INSERT INTO totals VALUES ('2026-11-02', 1, false)");
    expect((await database.query('SELECT * FROM dirty')).rows).toEqual([]);
    const due = await database.query(`
      SELECT day::text FROM totals
      WHERE NOT is_final
        AND (day + 1)::timestamp AT TIME ZONE 'UTC' + interval '12 hours 30 minutes'
            <= timestamptz '2026-11-03T12:30:00Z'
    `);
    // Eligibility only: publishing/finalizing still needs all contract guards.
    expect(due.rows).toEqual([{ day: '2026-11-02' }]);
  });
});
