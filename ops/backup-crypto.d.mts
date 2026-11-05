import type { Readable } from 'node:stream';
export function encrypt(
  input: Readable,
  destination: string,
  publicKey: string | Buffer,
): Promise<void>;
export function decrypt(
  source: string,
  destination: string,
  privateKey: string | Buffer,
): Promise<void>;
