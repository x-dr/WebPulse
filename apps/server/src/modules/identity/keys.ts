import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export const digest = (value: string) => createHash('sha256').update(value).digest();
export function identityKey(
  master: Buffer,
  purpose: string,
  site: string,
  epoch: number,
  value: string,
): Buffer {
  const derived = createHmac('sha256', master)
    .update(JSON.stringify([purpose, site, epoch]))
    .digest();
  return createHmac('sha256', derived).update(value).digest();
}
export function canonicalIp(input: string): string {
  if (isIP(input) === 4) return input;
  if (isIP(input) !== 6) throw new Error('invalid_ip');
  const normalized = new URL(`http://[${input}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  return [
    Number.parseInt(mapped[1]!, 16) >>> 8,
    Number.parseInt(mapped[1]!, 16) & 255,
    Number.parseInt(mapped[2]!, 16) >>> 8,
    Number.parseInt(mapped[2]!, 16) & 255,
  ].join('.');
}
export function visitorLock(site: string, key: Buffer): string {
  return digest(`visitor:${site}:${key.toString('hex')}`)
    .readBigInt64BE()
    .toString();
}
