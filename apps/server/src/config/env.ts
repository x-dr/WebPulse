import { existsSync, readFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export function loadWorkspaceEnv(): void {
  // Both src/ and dist/ have the same relative location; independent of process.cwd().
  const path = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (existsSync(path)) loadEnvFile(path);
}

type Environment = Record<string, string | undefined>;

function integer(env: Environment, key: string, fallback: number, max: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

export function readConfig(env: Environment = process.env) {
  if (env.DB_PASSWORD && env.DB_PASSWORD_FILE) {
    throw new Error('Configure only DB_PASSWORD or DB_PASSWORD_FILE');
  }
  let password = env.DB_PASSWORD ?? '';
  if (env.DB_PASSWORD_FILE) {
    try {
      password = readFileSync(env.DB_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error('Cannot read DB_PASSWORD_FILE');
    }
  }
  if (!password) throw new Error('DB_PASSWORD or DB_PASSWORD_FILE is required');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error('Invalid LOG_LEVEL');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: integer(env, 'PORT', 3000, 65_535),
    logLevel,
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
