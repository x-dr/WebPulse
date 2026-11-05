import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, chown, chmod } from 'node:fs/promises';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import https from 'node:https';
import net from 'node:net';
import assert from 'node:assert/strict';

// Only generated project names, volumes, credentials and /tmp files are touched.
const started = Date.now();
const temporary = await mkdtemp(join(tmpdir(), 'webpulse-m4-'));
const project = `webpulse-m4-${randomBytes(5).toString('hex')}`;
const envFile = join(temporary, 'production.env');
const args = ['compose', '--env-file', envFile, '-f', resolve('compose.yml'), '-p', project];
const log = [];
const checks = [];
async function run(binary, argv, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(binary, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun(stdout);
      else {
        log.push(stderr, stdout);
        reject(new Error(`${binary} operation failed (${code})`));
      }
    });
    child.stdin.end(options.input);
  });
}
const compose = (argv, options) => run('docker', [...args, ...argv], options);
const cli = (name, input) =>
  compose(['run', '--rm', '-T', 'ops', 'node', 'dist/cli.js', name], { input });
const sql = (query) =>
  compose([
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'webpulse_owner',
    '-d',
    'webpulse',
    '-At',
    '-c',
    query,
  ]);
const script = (code) =>
  compose(['run', '--rm', '-T', 'ops', 'node', '--input-type=module', '-e', code]);
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
async function until(work) {
  for (let i = 0; i < 60; i++) {
    try {
      if (await work()) return;
    } catch {
      /* Startup can briefly refuse connections. */
    }
    await pause(500);
  }
  throw new Error('Readiness deadline exceeded');
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}
const secretDirectory = join(temporary, 'secrets');
const tls = join(temporary, 'tls');
const journalTls = join(temporary, 'journal-tls');
const journalData = join(temporary, 'journal');
let restoreContainer;
try {
  for (const dir of [tls, journalTls, journalData]) {
    await mkdir(dir, { mode: 0o700 });
    await chown(dir, 1000, 1000);
  }
  await run('node', ['ops/initialize.mjs', secretDirectory]);
  async function certificate(dir, name) {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-days',
        '2',
        '-subj',
        `/CN=${name}`,
        '-addext',
        `subjectAltName=DNS:${name}`,
        '-keyout',
        join(dir, 'privkey.pem'),
        '-out',
        join(dir, 'fullchain.pem'),
      ],
      { stdio: 'ignore' },
    );
    for (const file of ['privkey.pem', 'fullchain.pem']) {
      await chown(join(dir, file), 1000, 1000);
      await chmod(join(dir, file), 0o400);
    }
  }
  await certificate(tls, 'stats.local');
  await certificate(journalTls, 'journal');
  const httpPort = await freePort();
  const httpsPort = await freePort();
  const origin = `https://stats.local:${httpsPort}`;
  await writeFile(
    envFile,
    `COMPOSE_PROJECT_NAME=${project}\nWEBPULSE_DOMAIN=stats.local\nADMIN_ORIGIN=${origin}\nDB_NAME=webpulse\nSECRET_DIR=${secretDirectory}\nTLS_DIR=${tls}\nDELETION_JOURNAL_URL=https://journal:8443\nJOURNAL_CA_FILE=${join(journalTls, 'fullchain.pem')}\nJOURNAL_TLS_DIR=${journalTls}\nJOURNAL_DATA_DIR=${journalData}\nWEB_BIND_IP=127.0.0.1\nHTTP_PORT=${httpPort}\nHTTPS_PORT=${httpsPort}\nPRIVATE_SUBNET=172.30.89.0/24\nWEB_PRIVATE_IP=172.30.89.10\nAPI_PRIVATE_IP=172.30.89.20\nDB_PRIVATE_IP=172.30.89.30\n`,
    { mode: 0o600 },
  );
  await compose(['config', '--quiet']);
  await compose(['up', '-d', '--wait', 'db']);
  await cli('database:prepare');
  await cli('database:prepare');
  checks.push('fresh and repeat database:prepare');
  await compose([
    'run',
    '--rm',
    '-T',
    '--no-deps',
    'journal',
    'node',
    'dist/cli.js',
    'journal:init',
  ]);
  await compose(['--profile', 'local-journal', 'up', '-d', 'journal']);
  const password = randomBytes(24).toString('hex');
  await compose(['run', '--rm', '-T', 'ops', 'node', 'dist/cli.js', 'admin:create', 'admin'], {
    input: password + '\n',
  });
  await compose(['up', '-d', '--wait', 'api', 'web']);
  checks.push('non-root production API and TLS Nginx startup');
  const ca = await readFile(join(tls, 'fullchain.pem'));
  function request(path, method = 'GET', body, headers = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolveRequest, reject) => {
      const req = https.request(
        {
          hostname: 'stats.local',
          port: httpsPort,
          path,
          method,
          ca,
          lookup: (_host, _options, callback) =>
            callback(null, [{ address: '127.0.0.1', family: 4 }]),
          headers: {
            ...(payload === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += String(chunk);
          });
          res.on('end', () =>
            resolveRequest({
              status: res.statusCode,
              headers: res.headers,
              text,
              json: () => JSON.parse(text),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }
  const home = await request('/realtime');
  assert.equal(home.status, 200);
  assert.match(home.text, /WebPulse/);
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await request('/api/v1/health/ready')).status, 404);
  assert.equal((await request('/tracker.js')).status, 200);
  const login = await request(
    '/api/v1/auth/login',
    'POST',
    { username: 'admin', password },
    { origin },
  );
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /__Host-wp_admin=.*Secure/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const headers = { origin, cookie, 'x-csrf-token': login.json().data.csrf_token };
  const create = async (name) => {
    const response = await request(
      '/api/v1/sites',
      'POST',
      {
        name,
        primary_origin: 'https://site.test',
        allowed_origins: ['https://site.test'],
        timezone: 'UTC',
      },
      headers,
    );
    assert.equal(response.status, 201);
    return response.json().data.site_id;
  };
  const removed = await create('Site removal');
  const kept = await create('Visitor removal');
  const cid = randomUUID();
  const other = randomUUID();
  const collect = async (site, visitor, path) => {
    const id = randomUUID();
    const response = await request(
      '/api/v1/collect',
      'POST',
      {
        site_id: site,
        cid: visitor,
        consent: 'granted',
        events: [
          {
            type: 'page_view',
            event_id: id,
            page_view_id: id,
            page: { origin: 'https://site.test', path },
            reason: 'initial',
          },
        ],
      },
      {
        origin: 'https://site.test',
        'x-forwarded-for': randomBytes(4).join('.'),
        'x-real-ip': '192.0.2.99',
      },
    );
    assert.equal(response.status, 204);
  };
  await collect(removed, cid, '/site-private');
  await collect(kept, cid, '/visitor-private');
  await collect(kept, other, '/keep');
  assert.equal(
    (
      await sql(
        'SELECT max(n) FROM (SELECT count(DISTINCT ip_key) AS n FROM events GROUP BY site_id) s',
      )
    ).trim(),
    '1',
  );
  checks.push('TLS login, Secure cookie, static SPA/SDK, forwarded-header overwrite');
  await script(
    `import {createPool} from './dist/db/database.js'; import {readConfig} from './dist/config/env.js'; import {readSecurityConfig} from './dist/config/security.js'; import {identityKey} from './dist/modules/identity/keys.js'; const p=createPool(readConfig().database); const proxy=identityKey(readSecurityConfig().ipKey,'ip','${kept}',1,'172.30.89.10'); const r=await p.query('SELECT count(*)::int AS n FROM events e JOIN sites s ON s.id=e.site_id WHERE s.public_id=$1 AND e.ip_key=$2',['${kept}',proxy]); if(r.rows[0].n) throw Error('Proxy address used instead of client'); await p.end();`,
  );
  await new Promise((resolveStream, reject) => {
    const req = https.get(
      {
        hostname: 'stats.local',
        port: httpsPort,
        path: `/api/v1/realtime?site_id=${kept}`,
        ca,
        lookup: (_host, _options, callback) =>
          callback(null, [{ address: '127.0.0.1', family: 4 }]),
        headers: { cookie },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += String(chunk);
          if (data.includes('event: snapshot') && data.includes('/keep')) {
            req.destroy();
            resolveStream();
          }
        });
      },
    );
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('TLS SSE timeout'));
    });
    req.on('error', reject);
  });
  checks.push('unbuffered SSE through TLS proxy');
  const permissions = JSON.parse(
    await compose([
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      `import {createPool} from './dist/db/database.js'; import {readConfig} from './dist/config/env.js'; import {existsSync,writeFileSync} from 'node:fs'; const p=createPool(readConfig().database); const denied=[]; for(const sql of ['CREATE TABLE forbidden(id int)','ALTER TABLE sites ADD COLUMN forbidden int',"UPDATE schema_migrations SET checksum=repeat('0',64)","INSERT INTO admins(username,password_hash) VALUES('forbidden','x')"]) {try {await p.query(sql); denied.push(false)}catch {denied.push(true)}} let readOnly=false; try{writeFileSync('/app/forbidden','x')}catch{readOnly=true} console.log(JSON.stringify({denied,uid:process.getuid(),readOnly,privateKey:existsSync('/run/secrets/deletion_private_key')})); await p.end();`,
    ]),
  );
  assert.deepEqual(permissions.denied, [true, true, true, true]);
  assert.equal(permissions.uid, 1000);
  assert.equal(permissions.readOnly, true);
  assert.equal(permissions.privateKey, false);
  checks.push('runtime role cannot DDL, alter migration history or create admins; no decrypt key');
  const recipient = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const backupPublic = join(temporary, 'backup-public.pem');
  const backupPrivate = join(temporary, 'backup-private.pem');
  await writeFile(backupPublic, recipient.publicKey, { mode: 0o600 });
  await writeFile(backupPrivate, recipient.privateKey, { mode: 0o600 });
  const backupEnv = {
    WEBPULSE_ENV_FILE: envFile,
    BACKUP_DIR: join(temporary, 'backups'),
    BACKUP_SECRET_DIR: secretDirectory,
    BACKUP_PUBLIC_KEY_FILE: backupPublic,
  };
  await until(async () => {
    try {
      await cli('backup:metadata');
      return true;
    } catch {
      return false;
    }
  });
  await run('node', ['ops/backup.mjs'], { env: backupEnv });
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(backupEnv.BACKUP_DIR);
  const manifest = join(
    backupEnv.BACKUP_DIR,
    files.find((f) => f.endsWith('.json')),
  );
  assert.equal((await sql('SELECT count(*) FROM backup_inventory')).trim(), '1');
  checks.push('encrypted pg_dump + matching key backup + inventory');
  const deletion = await request(
    `/api/v1/sites/${removed}`,
    'DELETE',
    { confirm_name: 'Site removal' },
    { ...headers, 'idempotency-key': randomUUID() },
  );
  assert.equal(deletion.status, 202, deletion.text);
  await compose(
    ['run', '--rm', '-T', 'ops', 'node', 'dist/cli.js', 'visitor:delete', kept, randomUUID()],
    { input: cid + '\n' },
  );
  await script(
    `import {createPool} from './dist/db/database.js'; import {readConfig} from './dist/config/env.js'; import {readDeletionKey} from './dist/modules/deletion/encryption.js'; import {readJournalClient} from './dist/modules/deletion/journal-client.js'; import {maintenanceWorker} from './dist/modules/maintenance/worker.js'; const p=createPool(readConfig().database); const w=maintenanceWorker(p,readDeletionKey(),readJournalClient()); for(let i=0;i<8;i++) await w.run(); const r=await p.query("SELECT count(*)::int AS pending FROM deletion_jobs WHERE status<>'succeeded'"); if(r.rows[0].pending) throw Error('pending deletion'); await p.end();`,
  );
  assert.equal((await sql('SELECT count(*) FROM events')).trim(), '1');
  assert.equal(
    (await sql('SELECT count(*) FROM deletion_jobs WHERE completion_sequence IS NOT NULL')).trim(),
    '2',
  );
  checks.push(
    'real HTTPS journal acknowledgements and completion records; site and visitor deletion',
  );
  await compose(['up', '-d', 'worker']);
  await compose(['restart', 'db', 'api', 'web']);
  await until(
    async () => (await request('/api/v1/sites', 'GET', undefined, { cookie })).status === 200,
  );
  assert.equal((await sql('SELECT count(*) FROM events')).trim(), '1');
  checks.push('database/API/web restart preserves acknowledged facts and deletion state');
  const restored = `webpulse_restore_${randomBytes(4).toString('hex')}`;
  const restoreStarted = Date.now();
  await run('node', ['ops/restore.mjs', manifest], {
    env: { ...backupEnv, BACKUP_PRIVATE_KEY_FILE: backupPrivate, RESTORE_DB_NAME: restored },
  });
  const restoredQuery = (query) =>
    compose([
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'webpulse_owner',
      '-d',
      restored,
      '-At',
      '-c',
      query,
    ]);
  assert.equal((await restoredQuery('SELECT count(*) FROM sites')).trim(), '1');
  assert.equal((await restoredQuery('SELECT path FROM events')).trim(), '/keep');
  assert.equal(
    (
      await restoredQuery(
        "SELECT count(*) FROM coverage_gaps WHERE reason='privacy_replay_unverifiable' AND resolved_at IS NULL",
      )
    ).trim(),
    '6',
  );
  assert.equal((await restoredQuery('SELECT state FROM recovery_state')).trim(), 'verified');
  restoreContainer = `${project}-restore-api`;
  await compose(
    ['run', '-d', '--no-deps', '--name', restoreContainer, '-e', `DB_NAME=${restored}`, 'api'],
    { env: { API_PRIVATE_IP: '172.30.89.21' } },
  );
  await until(async () => {
    const result = await run('docker', [
      'exec',
      restoreContainer,
      'node',
      '-e',
      `fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
    ]);
    return result === '';
  });
  const date = new Date().toISOString().slice(0, 10);
  const next = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
  await run(
    'docker',
    [
      'exec',
      '-i',
      restoreContainer,
      'node',
      '--input-type=module',
      '-e',
      `import {readFileSync} from 'node:fs'; const r=await fetch('http://127.0.0.1:3000/api/v1/stats/overview?site_id=${kept}&start_date=${date}&end_date=${next}',{headers:{cookie:readFileSync(0,'utf8')}}); const j=await r.json(); if(r.status!==200 || j.data.pv!==null || !JSON.stringify(j).includes('privacy_replay_unverifiable')) throw Error('Restored report exposed unverified history');`,
    ],
    { input: cookie },
  );
  checks.push(
    'actual pg_restore of pre-deletion snapshot, replay of every intent, privacy gaps, production API boots against restored DB',
  );
  await compose([
    'run',
    '--rm',
    '-T',
    '-e',
    `DB_NAME=${restored}`,
    'ops',
    'node',
    'dist/cli.js',
    'maintenance:run',
  ]);
  assert.equal(
    (
      await restoredQuery(
        "SELECT count(*) FROM coverage_gaps WHERE reason='privacy_replay_unverifiable' AND resolved_at IS NULL",
      )
    ).trim(),
    '6',
  );
  checks.push(
    'post-restore maintenance reuses immutable completion sequences and retains privacy gaps',
  );
  const result = {
    date: '2026-11-06',
    scope:
      'isolated local production containers; self-signed test TLS; separate local journal storage',
    passed: true,
    checks,
    restore_seconds: (Date.now() - restoreStarted) / 1000,
    total_seconds: (Date.now() - started) / 1000,
    limits: [
      'No VPS deployment, trusted public certificate, off-host copy or multi-day retention proof',
      'RPO/RTO observed only for this small synthetic fixture; full workload in M5',
    ],
  };
  await writeFile('docs/verification/m4-deployment.json', JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  const logs = await compose(['logs', '--no-color', '--tail', '60']).catch(
    () => 'Logs unavailable',
  );
  await writeFile(
    '/tmp/webpulse-m4-deployment-failure.log',
    [error.stack, ...log, logs].join('\n'),
  );
  process.stderr.write(
    `M4 smoke failed: ${error.message}. Diagnostics: /tmp/webpulse-m4-deployment-failure.log\n`,
  );
  process.exitCode = 1;
} finally {
  if (restoreContainer) await run('docker', ['rm', '-f', restoreContainer]).catch(() => {});
  await compose(['--profile', 'local-journal', 'down', '-v', '--remove-orphans']).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
