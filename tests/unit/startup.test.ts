import { describe, expect, it } from 'vitest';
import { readConfig } from '../../apps/server/src/config/env.js';
import { readSecurityConfig } from '../../apps/server/src/config/security.js';
import { startupFailureMessage } from '../../apps/server/src/config/errors.js';

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return startupFailureMessage(error);
  }
  throw new Error('Expected configuration to fail');
}

describe('safe startup diagnostics', () => {
  it('identifies missing security keys and database configuration', () => {
    expect(failure(() => readSecurityConfig({}))).toContain('Missing or invalid VISITOR_HMAC_KEY');
    expect(failure(() => readConfig({}))).toContain('DB_PASSWORD or DB_PASSWORD_FILE is required');
    expect(failure(() => readConfig({ DB_PASSWORD: 'private', PORT: 'private' }))).toContain(
      'Invalid PORT',
    );
  });

  it('reports security configuration errors without secret values or file paths', () => {
    for (const [env, reason] of [
      [{ VISITOR_HMAC_KEY: 'private-secret' }, 'Missing or invalid VISITOR_HMAC_KEY'],
      [{ VISITOR_HMAC_KEY_FILE: '/missing/private-key' }, 'Cannot read VISITOR_HMAC_KEY'],
      [
        { VISITOR_HMAC_KEY: 'private-secret', VISITOR_HMAC_KEY_FILE: '/missing/private-key' },
        'Ambiguous VISITOR_HMAC_KEY',
      ],
      [{ ADMIN_ORIGIN: 'https://user:private-secret@example.test' }, 'Invalid ADMIN_ORIGIN'],
    ] as const) {
      const output = failure(() => readSecurityConfig(env));
      expect(output).toContain(reason);
      expect(output).not.toContain('private');
      expect(output).not.toContain('example.test');
    }
    expect(
      failure(() => readConfig({ DB_PASSWORD_FILE: '/missing/private-password' })),
    ).not.toContain('/missing');
  });

  it.each(['EADDRINUSE', 'EACCES', 'EPERM', 'ENOENT'])(
    'reports %s without echoing low-level details',
    (code) => {
      const error = Object.assign(new Error('private-secret at private-host'), { code });
      const output = startupFailureMessage(error);
      expect(output).toContain('WebPulse startup failed:');
      expect(output).not.toContain('private');
    },
  );

  it.each([
    new Error('private-secret'),
    Object.assign(new Error('private-secret'), { code: '28P01' }),
    Object.assign(new Error('private-secret'), { code: 'constructor' }),
    { message: 'private-secret', code: 'private-secret' },
    'private-secret',
    undefined,
  ])('keeps unknown failures generic', (error) => {
    expect(startupFailureMessage(error)).toBe(
      'WebPulse startup failed; check environment, port and migration files.\n',
    );
  });
});
