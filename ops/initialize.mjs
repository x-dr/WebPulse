import { mkdirSync, existsSync, writeFileSync, chownSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';

// First-time material only; never overwrites or rotates an existing key.
const root = resolve(process.argv[2] ?? 'secrets');
mkdirSync(root, { recursive: true, mode: 0o700 });
const write = (name, value) => {
  const path = join(root, name);
  if (existsSync(path)) return;
  writeFileSync(path, value, { flag: 'wx', mode: 0o400 });
  if (process.getuid?.() === 0) chownSync(path, 1000, 1000);
};
for (const name of [
  'db_owner_password',
  'db_app_password',
  'db_worker_password',
  'visitor_hmac_key',
  'ip_hmac_key',
  'csrf_hmac_key',
  'journal_token',
  'journal_signing_key',
])
  write(`${name}.txt`, randomBytes(32).toString('hex') + '\n');
const privatePath = join(root, 'deletion_private_key.pem');
const publicPath = join(root, 'deletion_public_key.pem');
if (existsSync(privatePath) !== existsSync(publicPath))
  throw new Error('Incomplete deletion key pair; recover the matching files');
if (!existsSync(privatePath)) {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  write('deletion_private_key.pem', pair.privateKey);
  write('deletion_public_key.pem', pair.publicKey);
}
process.stdout.write(
  'Secret files prepared; existing files preserved. Back up matching keys with an offline recipient.\n',
);
