import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { ConfigurationError } from './errors.js';

export function loadWorkspaceEnv(): void {
  // Both src/ and dist/ have the same relative location; independent of process.cwd().
  const path = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (existsSync(path)) loadEnvFile(path);
}

type Environment = Record<string, string | undefined>;

function integer(env: Environment, key: string, fallback: number, max: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`Invalid ${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ConfigurationError(`Invalid ${key}`);
  }
  return value;
}

export function readConfig(env: Environment = process.env) {
  if (env.DB_PASSWORD && env.DB_PASSWORD_FILE) {
    throw new ConfigurationError('Configure only DB_PASSWORD or DB_PASSWORD_FILE');
  }
  let password = env.DB_PASSWORD ?? '';
  if (env.DB_PASSWORD_FILE) {
    try {
      password = readFileSync(env.DB_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new ConfigurationError('Cannot read DB_PASSWORD_FILE');
    }
  }
  if (!password) throw new ConfigurationError('DB_PASSWORD or DB_PASSWORD_FILE is required');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new ConfigurationError('Invalid LOG_LEVEL');
  }
  const trustedProxy = env.TRUSTED_PROXY_CIDRS?.split(',').map((s) => s.trim()) ?? [];
  if (
    trustedProxy.some((cidr) => {
      const [ip = '', prefix, extra] = cidr.split('/');
      const family = isIP(ip);
      return (
        !family ||
        extra !== undefined ||
        (prefix !== undefined &&
          (!/^\d+$/.test(prefix) ||
            Number(prefix) < 1 ||
            Number(prefix) > (family === 4 ? 32 : 128)))
      );
    })
  )
    throw new ConfigurationError('Invalid TRUSTED_PROXY_CIDRS');
  if (env.JOBS_ENABLED !== undefined && !['true', 'false'].includes(env.JOBS_ENABLED))
    throw new ConfigurationError('Invalid JOBS_ENABLED');
  return {
    host: env.HOST ?? '127.0.0.1',
    port: integer(env, 'PORT', 3000, 65_535),
    logLevel,
    trustedProxy,
    sseMax: integer(env, 'SSE_MAX_CONNECTIONS', 20, 20),
    jobsEnabled: env.JOBS_ENABLED !== 'false',
    database: {
      host: env.DB_HOST ?? '127.0.0.1',
      port: integer(env, 'DB_PORT', 5432, 65_535),
      database: env.DB_NAME ?? 'webpulse_dev',
      user: env.DB_USER ?? 'webpulse_dev',
      password,
      max: integer(env, 'DB_POOL_MAX', 8, 8),
      connectionTimeoutMillis: 750,
      idleTimeoutMillis: 10_000,
      statement_timeout: 5_000,
      options: '-c timezone=UTC',
    },
  };
}

export type AppConfig = ReturnType<typeof readConfig>;
