import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { isolatedStack, command } from '../deployment/isolated-stack.mjs';
import { traffic, percentile } from './traffic.mjs';

const seconds = Number(process.env.M5_STEADY_SECONDS ?? 1800);
const soak = Number(process.env.M5_SOAK_SECONDS ?? 0);
const output = process.env.M5_OUTPUT ?? 'docs/verification/m5-capacity.json';
if (!Number.isInteger(seconds) || seconds < 10 || !Number.isInteger(soak) || soak < 0)
  throw new Error('Invalid M5 duration');
const started = Date.now();
const result = {
  started_at: new Date().toISOString(),
  scope:
    'isolated local production containers, verified test TLS, per-container CPU/memory quotas; not target VPS proof',
  baseline: {
    cpu_quotas: 1,
    memory_limit_mib: 688,
    journal_limit_mib: 96,
    physical_host_1gb: false,
  },
  requirements: { steady_seconds: 1800, soak_seconds: 86400 },
  passed: false,
  checks: [],
  samples: [],
  reports: [],
};
const stack = await isolatedStack();
let timer, pendingSample, background, backgroundAt;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearTimeout(backgroundAt);
  result.status = 'cancelled_by_signal';
  result.passed = false;
  void stack
    .close()
    .catch(() => {
      result.cleanup_failed = true;
    })
    .finally(async () => {
      result.finished_at = new Date().toISOString();
      await writeFile(output, JSON.stringify(result, null, 2) + '\n');
      process.exit(130);
    });
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
const status = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
try {
  status('Building production images');
  await stack.compose(['build', 'api', 'web']);
  result.images = JSON.parse(
    await command('docker', [
      'image',
      'inspect',
      'webpulse-api:m5-acceptance',
      'webpulse-web:m5-acceptance',
      '--format',
      '{{json .Id}}',
    ]).then((text) => `[${text.trim().split('\n').join(',')}]`),
  );
  await stack.compose(['up', '-d', '--wait', 'db']);
  await stack.cli('database:prepare');
  await stack.compose([
    'run',
    '--rm',
    '-T',
    '--no-deps',
    'journal',
    'node',
    'dist/cli.js',
    'journal:init',
  ]);
  await stack.compose(['--profile', 'local-journal', 'up', '-d', 'journal']);
  const password = randomBytes(24).toString('hex');
  await stack.compose(
    ['run', '--rm', '-T', 'ops', 'node', 'dist/cli.js', 'admin:create', 'admin'],
    { input: `${password}\n` },
  );
  await stack.compose(['up', '-d', '--wait', 'api', 'web']);
  const login = await stack.request(
    '/api/v1/auth/login',
    'POST',
    { username: 'admin', password },
    { origin: stack.origin },
  );
  assert.equal(login.status, 200);
  const headers = {
    origin: stack.origin,
    cookie: login.headers['set-cookie'][0].split(';')[0],
    'x-csrf-token': login.json().data.csrf_token,
  };
  const sites = [];
  for (let i = 0; i < 5; i++) {
    const response = await stack.request(
      '/api/v1/sites',
      'POST',
      {
        name: `M5 ${i}`,
        primary_origin: 'https://site.test',
        allowed_origins: ['https://site.test'],
        timezone: 'UTC',
      },
      headers,
    );
    assert.equal(response.status, 201);
    sites.push(response.json().data.site_id);
  }
  status('Seeding 300,000 PV, 90 member days and 365 aggregate days');
  const seeded = await stack.sql(await readFile('tests/performance/window.sql', 'utf8'));
  result.fixture = JSON.parse(
    seeded
      .trim()
      .split('\n')
      .findLast((line) => line.startsWith('{')),
  );
  assert.equal(result.fixture.pv, 300000);
  assert.equal(result.fixture.member_days, 90);
  assert.equal(result.fixture.aggregate_days, 365);
  result.checks.push('full retained-window fixture and cross-midnight sessions');
  const recoverySite = await stack.request(
    '/api/v1/sites',
    'POST',
    {
      name: 'M5 recovery canary',
      primary_origin: 'https://site.test',
      allowed_origins: ['https://site.test'],
      timezone: 'UTC',
    },
    headers,
  );
  assert.equal(recoverySite.status, 201);
  const canarySite = recoverySite.json().data.site_id;
  const canaryCid = randomUUID();
  const canaryId = randomUUID();
  assert.equal(
    (
      await stack.request(
        '/api/v1/collect',
        'POST',
        {
          site_id: canarySite,
          cid: canaryCid,
          consent: 'granted',
          events: [
            {
              type: 'page_view',
              event_id: canaryId,
              page_view_id: canaryId,
              page: { origin: 'https://site.test', path: '/privacy-canary' },
              reason: 'initial',
            },
          ],
        },
        { origin: 'https://site.test' },
      )
    ).status,
    204,
  );
  result.query_plans = {};
  for (const [name, sql] of Object.entries({
    page: 'SELECT * FROM events WHERE site_id=1 AND page_view_id=(SELECT id FROM page_views WHERE site_id=1 LIMIT 1)',
    session:
      'SELECT * FROM page_views WHERE site_id=1 AND session_id=(SELECT id FROM sessions WHERE site_id=1 LIMIT 1)',
    visitor:
      'SELECT * FROM sessions WHERE site_id=1 AND visitor_key=(SELECT visitor_key FROM visitors WHERE site_id=1 LIMIT 1)',
  }))
    result.query_plans[name] = JSON.parse(
      await stack.sql(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ${sql};`),
    );
  await stack.compose(['up', '-d', 'worker']);
  const initialWal = JSON.parse(await stack.sql('SELECT row_to_json(s) FROM pg_stat_wal s;'));
  const sample = async () => {
    const text = await command('docker', [
      'stats',
      '--no-stream',
      '--format',
      '{{json .}}',
      ...(await stack.compose(['ps', '-q', 'db', 'api', 'worker', 'web'])).trim().split('\n'),
    ]);
    const diagnostics = await stack.request(
      `/api/v1/sites/${sites[0]}/diagnostics`,
      'GET',
      undefined,
      headers,
    );
    const now = new Date();
    const end = now.toISOString().slice(0, 10);
    const reports = [];
    for (const days of [0, 30, 90]) {
      const start = new Date(Date.parse(end) - days * 86400000).toISOString().slice(0, 10);
      const stop = days ? end : new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
      const began = performance.now();
      const response = await stack.request(
        `/api/v1/stats/overview?site_id=${sites[0]}&start_date=${start}&end_date=${stop}`,
        'GET',
        undefined,
        headers,
      );
      reports.push({ days, status: response.status, ms: performance.now() - began });
    }
    result.reports.push(...reports);
    result.samples.push({
      at: now.toISOString(),
      containers: text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      runtime: diagnostics.status === 200 ? diagnostics.json().data.runtime : null,
      maintenance:
        diagnostics.status === 200
          ? {
              pending_buckets: diagnostics.json().data.pending_buckets,
              oldest_pending_at: diagnostics.json().data.oldest_pending_at,
              worker: diagnostics.json().data.worker,
            }
          : null,
    });
    status(
      `Sample ${result.samples.length}; reports ${reports.map((row) => `${row.days}d:${row.status}/${Math.round(row.ms)}ms`).join(' ')}`,
    );
  };
  await sample();
  timer = setInterval(() => {
    if (!pendingSample)
      pendingSample = sample()
        .catch(() => {
          result.sample_errors = (result.sample_errors ?? 0) + 1;
        })
        .finally(() => {
          pendingSample = undefined;
        });
  }, 30000);
  const recipient = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicKey = join(stack.directory, 'backup-public.pem');
  await writeFile(publicKey, recipient.publicKey, { mode: 0o600 });
  const backupEnv = {
    WEBPULSE_ENV_FILE: stack.envFile,
    WEBPULSE_COMPOSE_OVERRIDE_FILE: stack.limitsFile,
    BACKUP_DIR: join(stack.directory, 'backups'),
    BACKUP_SECRET_DIR: stack.secrets,
    BACKUP_PUBLIC_KEY_FILE: publicKey,
  };
  backgroundAt = setTimeout(() => {
    background = Promise.allSettled([
      command('node', ['ops/backup.mjs'], { env: backupEnv }),
      stack.sql('VACUUM(ANALYZE) events; VACUUM(ANALYZE) page_views;'),
    ]);
    void background.catch(() => {});
  }, 5000);
  status(`Baseline: ${seconds}s at 10 RPS; 60/30/10 mix`);
  result.steady = await traffic(stack, sites, { seconds, rps: 10 });
  clearTimeout(backgroundAt);
  for (const operation of (await background) ?? [])
    if (operation.status === 'rejected') throw operation.reason;
  result.checks.push(
    'collection overlapped with aggregation, cleanup, encrypted pg_dump and VACUUM',
  );
  status('Eight-heartbeats mix and hot/cold 50 RPS burst');
  result.eight_heartbeats = await traffic(stack, sites, {
    seconds: Math.min(seconds, 300),
    rps: 10,
    mix: 'eight-heartbeats',
  });
  result.burst = await traffic(stack, sites, { seconds: 60, rps: 50 });
  if (soak) {
    status(`Starting real-time soak ${soak}s`);
    result.soak = await traffic(stack, sites, { seconds: soak, rps: 10, mix: 'eight-heartbeats' });
  }
  clearInterval(timer);
  await pendingSample;
  await sample();
  const ids = [
    ...result.steady.acknowledged,
    ...result.eight_heartbeats.acknowledged,
    ...result.burst.acknowledged,
    ...(result.soak?.acknowledged ?? []),
  ];
  for (const id of ids) assert.match(id, /^[a-f0-9-]{36}$/);
  const persisted = Number(
    (
      await stack.sql(
        `SELECT count(*) FROM events WHERE event_id=ANY(ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]);`,
      )
    ).trim(),
  );
  result.acknowledgement = { confirmed: ids.length, persisted };
  assert.equal(persisted, ids.length);
  for (const phase of [result.steady, result.eight_heartbeats, result.burst, result.soak])
    if (phase) delete phase.acknowledged;
  result.wal = {
    before: initialWal,
    after: JSON.parse(await stack.sql('SELECT row_to_json(s) FROM pg_stat_wal s;')),
  };
  result.table_statistics = JSON.parse(
    await stack.sql(
      "SELECT coalesce(json_agg(s),'[]') FROM (SELECT relname,n_tup_ins,n_tup_upd,n_tup_hot_upd,n_dead_tup,autovacuum_count FROM pg_stat_user_tables) s;",
    ),
  );
  const manifests = (await readdir(backupEnv.BACKUP_DIR)).filter((name) => name.endsWith('.json'));
  result.backup_manifests = manifests.length;
  assert.equal(manifests.length, 1);
  status('Replaying deletion over an isolated full-window pg_restore');
  await stack.compose(['stop', 'worker']);
  await stack.compose(
    ['run', '--rm', '-T', 'ops', 'node', 'dist/cli.js', 'visitor:delete', canarySite, randomUUID()],
    { input: canaryCid + '\n' },
  );
  for (let i = 0; i < 10; i++) await stack.cli('maintenance:run');
  assert.equal(
    Number((await stack.sql("SELECT count(*) FROM events WHERE path='/privacy-canary';")).trim()),
    0,
  );
  const backupPrivate = join(stack.directory, 'backup-private.pem');
  await writeFile(backupPrivate, recipient.privateKey, { mode: 0o600 });
  const restored = `webpulse_restore_${randomBytes(5).toString('hex')}`;
  const restoreStarted = Date.now();
  const manifestPath = join(backupEnv.BACKUP_DIR, manifests[0]);
  await command('node', ['ops/restore.mjs', manifestPath], {
    env: { ...backupEnv, BACKUP_PRIVATE_KEY_FILE: backupPrivate, RESTORE_DB_NAME: restored },
  });
  const restoredSql = (sql) =>
    stack.compose([
      'exec',
      '-T',
      'db',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'webpulse_owner',
      '-d',
      restored,
      '-At',
      '-c',
      sql,
    ]);
  const privacy = JSON.parse(
    await restoredSql(
      "SELECT json_build_object('canary',(SELECT count(*) FROM events WHERE path='/privacy-canary'),'pv',(SELECT count(*) FROM events),'gate',(SELECT state FROM recovery_state),'replays',(SELECT count(*) FROM recovery_replays));",
    ),
  );
  assert.equal(privacy.canary, 0);
  assert.equal(privacy.gate, 'verified');
  assert.ok(privacy.pv >= 300000);
  assert.equal(privacy.replays, 1);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  result.recovery = {
    seconds: (Date.now() - restoreStarted) / 1000,
    backup_age_seconds: (restoreStarted - Date.parse(manifest.snapshot_at)) / 1000,
    ...privacy,
    scope:
      'full retained-window synthetic database; same-host encrypted backup; no off-host RPO proof',
  };
  result.checks.push(
    'full-window encrypted pg_restore; post-snapshot visitor deletion replayed before gate verified',
  );
  const reportP95 = Object.fromEntries(
    [0, 30, 90].map((days) => [
      days,
      percentile(
        result.reports
          .filter((row) => row.days === days && row.status === 200)
          .map((row) => row.ms),
        0.95,
      ),
    ]),
  );
  result.report_p95_ms = reportP95;
  result.thresholds = {
    no_false_ack: ids.length === persisted,
    no_dropped_iterations: result.steady.dropped === 0,
    steady_latency:
      result.steady.p95_ms !== null && result.steady.p95_ms <= 200 && result.steady.p99_ms <= 500,
    steady_errors: result.steady.errors / result.steady.requests < 0.001,
    report_latency: Object.entries(reportP95).every(
      ([days, ms]) => ms !== null && ms <= { 0: 500, 30: 1000, 90: 2000 }[days],
    ),
    report_success: result.reports.every((row) => row.status === 200),
    full_steady_duration: seconds >= 1800,
    real_24h_soak: soak >= 86400,
  };
  result.local_checks_passed = Object.entries(result.thresholds)
    .filter(([name]) => !['full_steady_duration', 'real_24h_soak'].includes(name))
    .every(([, passed]) => passed);
  result.passed = Object.values(result.thresholds).every(Boolean);
} catch (error) {
  result.error = error.message;
  const logs = await stack
    .compose(['logs', '--no-color', '--tail', '80'])
    .catch(() => 'Unavailable');
  await writeFile('/tmp/webpulse-m5-capacity-failure.txt', `${error.diagnostic ?? ''}\n${logs}`, {
    mode: 0o600,
  });
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  clearTimeout(backgroundAt);
  await background;
  await pendingSample?.catch(() => {});
  result.finished_at = new Date().toISOString();
  result.total_seconds = (Date.now() - started) / 1000;
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await stack.close();
  for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
  status(`Evidence saved: ${output}; all thresholds passed: ${result.passed}`);
}
if (!result.passed) process.exitCode = 1;
