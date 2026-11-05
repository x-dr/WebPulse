import { mkdtemp, readFile, mkdir, writeFile, chown, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decrypt } from './backup-crypto.mjs';

const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const temporary = await mkdtemp(join(tmpdir(), 'webpulse-recover-keys-'));
try {
  await decrypt(
    source,
    join(temporary, 'keys.json'),
    await readFile(process.env.BACKUP_PRIVATE_KEY_FILE),
  );
  const material = JSON.parse(await readFile(join(temporary, 'keys.json'), 'utf8'));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(material)) {
    if (
      !/^(db_(owner|app|worker)_password|visitor_hmac_key|ip_hmac_key|csrf_hmac_key|journal_token|journal_signing_key)\.txt$|^deletion_(private|public)_key\.pem$|^visitor_hmac_history\.json$/.test(
        name,
      ) ||
      typeof value !== 'string'
    )
      throw new Error('Invalid key archive');
    const path = join(destination, name);
    const bytes = Buffer.from(value, 'base64');
    const existing = await readFile(path).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) {
      if (!existing.equals(bytes)) throw new Error('Existing key differs; no overwrite performed');
      continue;
    }
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400 });
    if (process.getuid?.() === 0) await chown(path, 1000, 1000);
  }
  process.stdout.write('Matching key files recovered; existing files preserved.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
