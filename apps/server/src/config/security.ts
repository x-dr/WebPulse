import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOrigin } from '@webpulse/shared';
import { ConfigurationError } from './errors.js';

export type SecurityConfig = {
  adminOrigin: string;
  secureCookie: boolean;
  visitorKey: Buffer;
  ipKey: Buffer;
  csrfKey: Buffer;
};
export function readSecurityConfig(env = process.env): SecurityConfig {
  const read = (name: string) => {
    if (env[name] && env[`${name}_FILE`]) throw new ConfigurationError(`Ambiguous ${name}`);
    let value = env[name];
    if (env[`${name}_FILE`]) {
      try {
        value = readFileSync(
          resolve(fileURLToPath(new URL('../../../../', import.meta.url)), env[`${name}_FILE`]!),
          'utf8',
        ).trim();
      } catch {
        throw new ConfigurationError(`Cannot read ${name}`);
      }
    }
    if (!value || !/^[a-f0-9]{64}$/i.test(value))
      throw new ConfigurationError(`Missing or invalid ${name}`);
    return Buffer.from(value, 'hex');
  };
  let adminOrigin: string;
  try {
    adminOrigin = normalizeOrigin(env.ADMIN_ORIGIN ?? 'http://127.0.0.1:5173');
  } catch {
    throw new ConfigurationError('Invalid ADMIN_ORIGIN');
  }
  if (env.NODE_ENV === 'production' && !adminOrigin.startsWith('https://'))
    throw new ConfigurationError('HTTPS ADMIN_ORIGIN required');
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
    throw new ConfigurationError('Independent keys required');
  return result;
}
