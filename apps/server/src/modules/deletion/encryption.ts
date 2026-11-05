import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DeletionKey = { key: Buffer; keyId: string };
export type Selector = {
  site_public_id: string;
  kind: 'site' | 'visitor';
  cutoff_at: string;
  visitor_keys: { epoch: number; key: string }[];
  scope: 'all_observed_before_cutoff';
};
export type Envelope = { nonce: string; ciphertext: string; tag: string };
export function encryptSelector(selector: Selector, config: DeletionKey): Envelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.key, nonce);
  cipher.setAAD(Buffer.from(`webpulse:deletion:1:${config.keyId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(selector)), cipher.final()]);
  return {
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}
export function decryptSelector(envelope: Envelope, keyId: string, config: DeletionKey): Selector {
  if (keyId !== config.keyId) throw new Error('deletion_key_unavailable');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    config.key,
    Buffer.from(envelope.nonce, 'base64'),
  );
  decipher.setAAD(Buffer.from(`webpulse:deletion:1:${keyId}`));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString(),
  ) as Selector;
}
export function readDeletionKey(env = process.env): DeletionKey | undefined {
  if (!env.DELETION_ENCRYPTION_KEY && !env.DELETION_ENCRYPTION_KEY_FILE) return undefined;
  if (env.DELETION_ENCRYPTION_KEY && env.DELETION_ENCRYPTION_KEY_FILE)
    throw new Error('Ambiguous deletion key');
  const value =
    env.DELETION_ENCRYPTION_KEY ??
    readFileSync(
      resolve(
        fileURLToPath(new URL('../../../../../', import.meta.url)),
        env.DELETION_ENCRYPTION_KEY_FILE!,
      ),
      'utf8',
    ).trim();
  if (!/^[a-f0-9]{64}$/i.test(value) || !/^[a-zA-Z0-9_-]{1,64}$/.test(env.DELETION_KEY_ID ?? 'v1'))
    throw new Error('Invalid deletion key');
  return { key: Buffer.from(value, 'hex'), keyId: env.DELETION_KEY_ID ?? 'v1' };
}
