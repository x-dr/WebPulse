import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { FileJournal, verifyLedger } from '../../apps/server/src/modules/deletion/journal.js';
import {
  encryptSelector,
  decryptSelector,
} from '../../apps/server/src/modules/deletion/encryption.js';
import { encrypt, decrypt } from '../../ops/backup-crypto.mjs';

describe('M4 independent encrypted journal and backup integrity', () => {
  it('uses an encryption-only public key for HTTP requests', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const selector = {
      site_public_id: 'site_test',
      kind: 'visitor' as const,
      cutoff_at: '2026-11-01T00:00:00Z',
      visitor_keys: [{ epoch: 1, key: randomBytes(32).toString('hex') }],
      scope: 'all_observed_before_cutoff' as const,
    };
    const envelope = encryptSelector(selector, { publicKey, keyId: 'v1' });
    expect(JSON.stringify(envelope)).not.toContain(selector.visitor_keys[0]!.key);
    expect(
      decryptSelector(envelope, 'v1', { key: Buffer.alloc(0), privateKey, keyId: 'v1' }),
    ).toEqual(selector);
    expect(() => decryptSelector(envelope, 'v1', { key: Buffer.alloc(0), keyId: 'v1' })).toThrow();
    expect(createPublicKey(privateKey).equals(publicKey)).toBe(true);
  });
  it('requires explicit initialization, survives reopen, deduplicates ack-loss, and rejects gaps/tampering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webpulse-journal-'));
    const key = randomBytes(32);
    try {
      const journal = new FileJournal(dir, key);
      await expect(journal.read()).rejects.toThrow('uninitialized');
      await journal.initialize();
      const intent = {
        taskId: randomUUID(),
        keyId: 'v1',
        schemaVersion: 1 as const,
        envelope: { nonce: 'n', ciphertext: 'secret encrypted', tag: 't' },
      };
      const acks = await Promise.all([journal.persist(intent), journal.persist(intent)]);
      expect(acks).toEqual([{ sequence: '1' }, { sequence: '1' }]);
      await new FileJournal(dir, key).complete(intent.taskId, { verified: true });
      const ledger = await journal.read();
      expect(ledger.head.sequence).toBe('2');
      expect(() => verifyLedger(ledger.records.slice(1), key, ledger.head)).toThrow('incomplete');
      expect(() => verifyLedger(ledger.records.slice(0, 1), key, ledger.head)).toThrow(
        'incomplete',
      );
      await expect(journal.persist({ ...intent, keyId: 'changed' })).rejects.toThrow('conflict');
      ledger.records[0]!.intent!.envelope.ciphertext = 'tampered';
      await writeFile(join(dir, 'ledger.json'), JSON.stringify(ledger));
      await expect(journal.read()).rejects.toThrow('incomplete');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('authenticates streaming backups before publishing decrypted output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webpulse-backup-'));
    try {
      const pair = generateKeyPairSync('rsa', {
        modulusLength: 3072,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const path = join(dir, 'db.wpbackup');
      const data = randomBytes(200000);
      await encrypt(Readable.from([data]), path, pair.publicKey);
      await decrypt(path, join(dir, 'restored'), pair.privateKey);
      expect(await readFile(join(dir, 'restored'))).toEqual(data);
      const bytes = await readFile(path);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await writeFile(path, bytes);
      await expect(decrypt(path, join(dir, 'invalid'), pair.privateKey)).rejects.toThrow();
      await expect(readFile(join(dir, 'invalid'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
