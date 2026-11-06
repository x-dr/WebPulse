import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { decrypt } from './backup-crypto.mjs';
import { composeArguments } from './compose.mjs';

const manifestPath = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const base = manifestPath.replace(/\.json$/, '');
const target = process.env.RESTORE_DB_NAME;
if (!target || !/^webpulse_restore_[a-z0-9_]{1,40}$/.test(target))
  throw new Error('Use a new isolated RESTORE_DB_NAME=webpulse_restore_<name>');
const privateKey = await readFile(process.env.BACKUP_PRIVATE_KEY_FILE);
for (const [suffix, checksum] of [
  ['db', manifest.checksum],
  ['keys', manifest.keys_checksum],
]) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(`${base}.${suffix}.wpbackup`)) hash.update(chunk);
  if (hash.digest('hex') !== checksum) throw new Error('Backup checksum mismatch');
}
const compose = composeArguments();
async function command(args, input) {
  const child = spawn('docker', [...compose, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  const completion = new Promise((resolveCommand, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolveCommand()
        : reject(new Error('Restore operation failed; keep target isolated')),
    );
  });
  void completion.catch(() => {});
  if (input) await pipeline(input, child.stdin);
  else child.stdin.end();
  await completion;
}
const temporary = await mkdtemp(join(tmpdir(), 'webpulse-restore-'));
try {
  await decrypt(`${base}.db.wpbackup`, join(temporary, 'database.dump'), privateKey);
  await decrypt(`${base}.keys.wpbackup`, join(temporary, 'keys.json'), privateKey);
  // Compare stable keys before restoring. Recovery never silently replaces current keys.
  const material = JSON.parse(await readFile(join(temporary, 'keys.json'), 'utf8'));
  const secretDirectory = resolve(process.env.BACKUP_SECRET_DIR ?? 'secrets');
  for (const [name, value] of Object.entries(material)) {
    if (!/^[a-z_]+\.(txt|pem|json)$/.test(name)) throw new Error('Invalid key archive');
    if (!(await readFile(join(secretDirectory, name))).equals(Buffer.from(value, 'base64')))
      throw new Error('Matching backup keys required');
  }
  await command(['exec', '-T', 'db', 'createdb', '-U', 'webpulse_owner', target]);
  await command(
    [
      'exec',
      '-T',
      'db',
      'pg_restore',
      '-U',
      'webpulse_owner',
      '-d',
      target,
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
    ],
    createReadStream(join(temporary, 'database.dump')),
  );
  const cli = (name) =>
    command(['run', '--rm', '-T', '-e', `DB_NAME=${target}`, 'ops', 'node', 'dist/cli.js', name]);
  // Old backups may predate the gate table; no public service points at this new database.
  await cli('database:prepare');
  await cli('recovery:lock');
  await cli('recovery:replay');
  process.stdout.write(
    `Isolated restore verified: ${target}. Sites remain paused. Validate reports and privacy before configuring services to use this database.\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
