import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOrigin } from '@webpulse/shared';

export type SecurityConfig = {
  adminOrigin: string;
  secureCookie: boolean;
  visitorKey: Buffer;
  ipKey: Buffer;
  csrfKey: Buffer;
};
export function readSecurityConfig(env = process.env): SecurityConfig {
  const read = (name: string) => {
    if (env[name] && env[`${name}_FILE`]) throw new Error(`Ambiguous ${name}`);
    let value = env[name];
    if (env[`${name}_FILE`]) {
      try {
        value = readFileSync(
          resolve(fileURLToPath(new URL('../../../../', import.meta.url)), env[`${name}_FILE`]!),
          'utf8',
        ).trim();
      } catch {
        throw new Error(`Cannot read ${name}`, { cause: undefined });
      }
    }
    if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Missing or invalid ${name}`);
    return Buffer.from(value, 'hex');
  };
  const adminOrigin = normalizeOrigin(env.ADMIN_ORIGIN ?? 'http://127.0.0.1:5173');
  if (env.NODE_ENV === 'production' && !adminOrigin.startsWith('https://'))
    throw new Error('HTTPS ADMIN_ORIGIN required');
  const result = {
    adminOrigin,
    secureCookie: adminOrigin.startsWith('https://'),
    visitorKey: read('VISITOR_HMAC_KEY'),
    ipKey: read('IP_HMAC_KEY'),
    csrfKey: read('CSRF_HMAC_KEY'),
  };
  if (
    result.visitorKey.equals(result.ipKey) ||
    result.visitorKey.equals(result.csrfKey) ||
    result.ipKey.equals(result.csrfKey)
  )
    throw new Error('Independent keys required');
  return result;
}
