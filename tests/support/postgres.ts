import { randomBytes, randomUUID } from 'node:crypto';
import { loadWorkspaceEnv, readConfig } from '../../apps/server/src/config/env.js';
import { createPool, migrationConnection } from '../../apps/server/src/db/database.js';
import { loadMigrations, migrate } from '../../apps/server/src/db/migrations.js';
import { buildApp } from '../../apps/server/src/app.js';
import { hashPassword } from '../../apps/server/src/modules/auth/password.js';
import { defaultRules, type CollectionEvent } from '../../packages/shared/src/index.js';

loadWorkspaceEnv();
export async function fixture(options: { trustedProxy?: string[] } = {}) {
  const config = readConfig();
  const schema = `webpulse_m1_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(config.database);
  const pool = createPool({
    ...config.database,
    options: `-c timezone=UTC -c search_path=${schema}`,
  });
  const security = {
    adminOrigin: 'https://stats.test',
    secureCookie: true,
    visitorKey: randomBytes(32),
    ipKey: randomBytes(32),
    csrfKey: randomBytes(32),
  };
  const deletionKey = { key: randomBytes(32), keyId: 'test-v1' };
  const app = buildApp({ ready: async () => {}, pool, security, deletionKey, ...options });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const client = await pool.connect();
    try {
      await migrate(migrationConnection(client), await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query('INSERT INTO admins(username,password_hash) VALUES ($1,$2)', [
      'admin',
      await hashPassword('test-password-only'),
    ]);
    await app.ready();
  } catch (error) {
    await app.close();
    await pool.end();
    await admin.end();
    throw error;
  }
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: security.adminOrigin },
    payload: { username: 'admin', password: 'test-password-only' },
  });
  if (login.statusCode !== 200) throw new Error(`Login fixture: ${login.body}`);
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const headers = {
    origin: security.adminOrigin,
    cookie,
    'x-csrf-token': login.json().data.csrf_token as string,
  };
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/sites',
    headers,
    payload: {
      name: 'Test site',
      primary_origin: 'https://web.test',
      allowed_origins: ['https://web.test'],
      timezone: 'UTC',
      rules: defaultRules,
    },
  });
  if (created.statusCode !== 201) throw new Error(`Site fixture: ${created.body}`);
  const site = created.json().data.site_id as string;
  const cid = randomUUID();
  function pv(path = '/guide'): CollectionEvent {
    const id = randomUUID();
    return {
      type: 'page_view',
      event_id: id,
      page_view_id: id,
      page: { origin: 'https://web.test', path },
      reason: 'initial',
    };
  }
  const collect = (
    events: CollectionEvent[],
    extra: {
      headers?: Record<string, string>;
      remoteAddress?: string;
      payload?: string | object;
    } = {},
    visitor = cid,
    siteId = site,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/collect',
      payload: JSON.stringify({ site_id: siteId, cid: visitor, consent: 'granted', events }),
      ...extra,
      headers: {
        origin: 'https://web.test',
        'content-type':
          typeof extra.payload === 'object' ? 'application/json' : 'text/plain;charset=UTF-8',
        ...extra.headers,
      },
    });
  const heartbeat = (id: string, total: number, visitor = cid) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat',
      headers: { origin: 'https://web.test' },
      payload: {
        site_id: site,
        cid: visitor,
        consent: 'granted',
        page_view_id: id,
        total_visible_ms: total,
      },
    });
  const patch = (payload: object) =>
    app.inject({ method: 'PATCH', url: `/api/v1/sites/${site}`, headers, payload });
  async function snapshot() {
    const tables = [
      'visitors',
      'sessions',
      'events',
      'page_views',
      'visitor_days',
      'ip_days',
      'distinct_hours',
      'dirty_buckets',
    ];
    const result: Record<string, unknown> = {};
    for (const table of tables)
      result[table] = (
        await pool.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)
      ).rows;
    return result;
  }
  async function close() {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
  return {
    app,
    pool,
    admin,
    schema,
    security,
    deletionKey,
    site,
    cid,
    pv,
    collect,
    heartbeat,
    patch,
    headers,
    cookie,
    snapshot,
    close,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
