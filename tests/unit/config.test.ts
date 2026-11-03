import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../apps/server/src/config/env.js';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true })));

describe('environment validation', () => {
  it('fails closed without a database password', () => {
    expect(() => readConfig({})).toThrow('DB_PASSWORD');
  });

  it('defaults to loopback and a bounded shared connection pool', () => {
    const config = readConfig({ DB_PASSWORD: 'test-only' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.database.max).toBe(8);
    expect(config.database.options).toBe('-c timezone=UTC');
  });

  it.each(['0', '65536', '3000x', '3.5', ''])('rejects invalid PORT %j', (value) => {
    expect(() => readConfig({ DB_PASSWORD: 'test-only', PORT: value })).toThrow('Invalid PORT');
  });

  it('rejects an oversized pool and invalid logger level', () => {
    expect(() => readConfig({ DB_PASSWORD: 'test-only', DB_POOL_MAX: '21' })).toThrow(
      'DB_POOL_MAX',
    );
    expect(() => readConfig({ DB_PASSWORD: 'test-only', LOG_LEVEL: 'invalid' })).toThrow(
      'LOG_LEVEL',
    );
  });

  it('reads a secret file without losing password spaces', () => {
    const directory = mkdtempSync(join(tmpdir(), 'webpulse-config-'));
    temporary.push(directory);
    const path = join(directory, 'password');
    writeFileSync(path, ' test-only \n', { mode: 0o600 });
    expect(readConfig({ DB_PASSWORD_FILE: path }).database.password).toBe(' test-only ');
  });

  it('rejects ambiguous secret sources and hides unreadable paths', () => {
    expect(() =>
      readConfig({ DB_PASSWORD: 'test-only', DB_PASSWORD_FILE: '/missing-secret' }),
    ).toThrow('Configure only');
    expect(() => readConfig({ DB_PASSWORD_FILE: '/missing-secret' })).toThrow(
      'Cannot read DB_PASSWORD_FILE',
    );
  });
});
