import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { encrypt } from './backup-crypto.mjs';

// Environment paths contain no credentials. Database/key values are read via files.
const envFile = resolve(process.env.WEBPULSE_ENV_FILE ?? '.env.production');
const compose = ['compose', '--env-file', envFile, '-f', 'compose.yml'];
function command(args, input) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn('docker', [...compose, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let result = '';
    child.stdout.on('data', (chunk) => {
      result += String(chunk);
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolveCommand(result) : reject(new Error('Backup operation failed')),
    );
    child.stdin.end(input);
  });
}
const destination = resolve(process.env.BACKUP_DIR ?? 'backups');
const secrets = resolve(process.env.BACKUP_SECRET_DIR ?? 'secrets');
const recipient = await readFile(process.env.BACKUP_PUBLIC_KEY_FILE);
await mkdir(destination, { recursive: true, mode: 0o700 });
const id = randomUUID();
const base = join(destination, id);
const metadata = JSON.parse(
  await command(['run', '--rm', '-T', 'ops', 'node', 'dist/cli.js', 'backup:metadata']),
);
const dump = spawn(
  'docker',
  [
    ...compose,
    'exec',
    '-T',
    'db',
    'sh',
    '-c',
    'exec pg_dump -U webpulse_owner -d "$POSTGRES_DB" -Fc --no-owner --no-acl --exclude-table-data=public.recovery_state',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
dump.stderr.resume();
const completed = new Promise((resolveDump, reject) => {
  dump.on('error', reject);
  dump.on('close', (code) => (code === 0 ? resolveDump() : reject(new Error('pg_dump failed'))));
});
// Attach immediately; pipeline completion may arrive after process exit.
void completed.catch(() => {});
try {
  await encrypt(dump.stdout, `${base}.db.wpbackup`, recipient);
  await completed;
} catch (error) {
  dump.kill();
  await unlink(`${base}.db.wpbackup`).catch(() => {});
  throw error;
}
const material = {};
for (const name of await readdir(secrets)) {
  if (
    !/^(db_(owner|app|worker)_password|visitor_hmac_key|ip_hmac_key|csrf_hmac_key|journal_token|journal_signing_key)\.txt$|^deletion_(private|public)_key\.pem$|^visitor_hmac_history\.json$/.test(
      name,
    )
  )
    continue;
  material[name] = (await readFile(join(secrets, name))).toString('base64');
}
await encrypt(Readable.from([JSON.stringify(material)]), `${base}.keys.wpbackup`, recipient);
const digest = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const manifest = {
  id,
  ...metadata,
  completed_at: new Date().toISOString(),
  checksum: await digest(`${base}.db.wpbackup`),
  keys_checksum: await digest(`${base}.keys.wpbackup`),
  location: `${id}.db.wpbackup`,
};
await writeFile(`${base}.json`, JSON.stringify(manifest, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
await command(
  ['run', '--rm', '-T', 'ops', 'node', 'dist/cli.js', 'backup:register'],
  JSON.stringify(manifest),
);
process.stdout.write(
  `Encrypted backup complete: ${id}. Copy all three files off-host, verify checksums, then record rotation.\n`,
);
