import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chown, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import https from 'node:https';
import net from 'node:net';

export async function command(binary, argv, { input, env = {} } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-65536);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolveRun(output)
        : reject(Object.assign(new Error(`${binary} failed (${code})`), { diagnostic: errors })),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}
export async function until(work, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await work()) return;
    } catch {
      /* bounded startup retry */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('Acceptance readiness deadline exceeded');
}

export async function isolatedStack() {
  const directory = await mkdtemp(join(tmpdir(), 'webpulse-m5-'));
  const project = `webpulse-m5-${randomBytes(5).toString('hex')}`;
  const envFile = join(directory, 'production.env');
  const limitsFile = join(directory, 'limits.yml');
  const composeArgs = [
    'compose',
    '--env-file',
    envFile,
    '-f',
    resolve('compose.yml'),
    '-f',
    limitsFile,
    '-p',
    project,
  ];
  const compose = (argv, options) => command('docker', [...composeArgs, ...argv], options);
  const sql = (text) =>
    compose(
      [
        'exec',
        '-T',
        'db',
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'webpulse_owner',
        '-d',
        'webpulse',
        '-At',
      ],
      { input: text },
    );
  const cli = (name, input) =>
    compose(['run', '--rm', '-T', 'ops', 'node', 'dist/cli.js', name], { input });
  const cleanup = async () => {
    await compose(['--profile', 'local-journal', 'down', '-v', '--remove-orphans']);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const secrets = join(directory, 'secrets');
    const tls = join(directory, 'tls');
    const journalTls = join(directory, 'journal-tls');
    const journalData = join(directory, 'journal');
    await command('node', ['ops/initialize.mjs', secrets]);
    for (const [path, name] of [
      [tls, 'stats.local'],
      [journalTls, 'journal'],
    ]) {
      await mkdir(path, { mode: 0o700 });
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
          join(path, 'privkey.pem'),
          '-out',
          join(path, 'fullchain.pem'),
        ],
        { stdio: 'ignore' },
      );
      for (const file of ['privkey.pem', 'fullchain.pem']) {
        await chown(join(path, file), 1000, 1000);
        await chmod(join(path, file), 0o400);
      }
      await chown(path, 1000, 1000);
    }
    await mkdir(journalData, { mode: 0o700 });
    await chown(journalData, 1000, 1000);
    const httpsPort = await freePort();
    const httpPort = await freePort();
    const subnet = `172.29.${16 + (randomBytes(1)[0] % 200)}`;
    const origin = `https://stats.local:${httpsPort}`;
    await writeFile(
      limitsFile,
      'services:\n  db:\n    mem_limit: 320m\n    cpus: 0.50\n  api:\n    mem_limit: 192m\n    cpus: 0.30\n  worker:\n    mem_limit: 128m\n    cpus: 0.15\n  web:\n    mem_limit: 48m\n    cpus: 0.05\n',
    );
    await writeFile(
      envFile,
      [
        `COMPOSE_PROJECT_NAME=${project}`,
        'WEBPULSE_DOMAIN=stats.local',
        `ADMIN_ORIGIN=${origin}`,
        'DB_NAME=webpulse',
        `SECRET_DIR=${secrets}`,
        `TLS_DIR=${tls}`,
        'DELETION_JOURNAL_URL=https://journal:8443',
        `JOURNAL_CA_FILE=${join(journalTls, 'fullchain.pem')}`,
        `JOURNAL_TLS_DIR=${journalTls}`,
        `JOURNAL_DATA_DIR=${journalData}`,
        'WEB_BIND_IP=127.0.0.1',
        `HTTP_PORT=${httpPort}`,
        `HTTPS_PORT=${httpsPort}`,
        `PRIVATE_SUBNET=${subnet}.0/24`,
        `WEB_PRIVATE_IP=${subnet}.10`,
        `API_PRIVATE_IP=${subnet}.20`,
        `DB_PRIVATE_IP=${subnet}.30`,
        'WEBPULSE_API_IMAGE=webpulse-api:m5-acceptance',
        'WEBPULSE_WEB_IMAGE=webpulse-web:m5-acceptance',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const ca = await readFile(join(tls, 'fullchain.pem'));
    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 64,
      ca,
      lookup: (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
    });
    const request = (path, method = 'GET', body, headers = {}) =>
      new Promise((resolveRequest, reject) => {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        const req = https.request(
          `${origin}${path}`,
          {
            agent,
            method,
            headers: {
              ...headers,
              ...(encoded
                ? {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(encoded),
                  }
                : {}),
            },
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => {
              text += chunk;
            });
            res.on('end', () =>
              resolveRequest({
                status: res.statusCode,
                headers: res.headers,
                text,
                json: () => JSON.parse(text),
              }),
            );
            res.on('error', reject);
          },
        );
        req.on('error', reject);
        req.setTimeout(6000, () => req.destroy(new Error('Acceptance HTTP timeout')));
        req.end(encoded);
      });
    let closing;
    return {
      directory,
      project,
      envFile,
      limitsFile,
      secrets,
      compose,
      sql,
      cli,
      request,
      origin,
      agent,
      close() {
        if (!closing) {
          agent.destroy();
          closing = cleanup();
        }
        return closing;
      },
    };
  } catch (error) {
    await cleanup().catch(() => {});
    // No containers are started until this constructor has returned.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
