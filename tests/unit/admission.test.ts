import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';

it('rejects excess work before downstream hooks and releases every admission after completion', async () => {
  const app = buildApp({ ready: async () => {} });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  app.get('/blocked', async () => {
    entered++;
    await barrier;
    return {};
  });
  await app.ready();
  const requests = Array.from({ length: 64 }, () => app.inject('/blocked'));
  // inject is lazy until its then method is called.
  const pending = Promise.all(requests);
  try {
    for (let i = 0; i < 100 && entered < 64; i++) await setImmediate();
    expect(entered).toBe(64);
    const rejected = await app.inject('/blocked');
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().error.code).toBe('server_busy');
    expect(rejected.headers['retry-after']).toBe('1');
    expect(entered).toBe(64);
    expect((await app.inject('/api/v1/health/live')).statusCode).toBe(200);
    release();
    expect((await pending).every((r) => r.statusCode === 200)).toBe(true);
    expect((await app.inject('/blocked')).statusCode).toBe(200);
  } finally {
    release();
    await pending;
    await app.close();
  }
});

it('does not leak admissions after validation errors, not-found responses and repeated failures', async () => {
  const app = buildApp({ ready: async () => {} });
  app.get('/failure', async () => {
    throw new Error('private SQL, password and path');
  });
  try {
    for (let i = 0; i < 80; i++) {
      const response = await app.inject('/failure');
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toMatch(/private|password|SQL/);
      expect((await app.inject('/missing')).statusCode).toBe(404);
    }
    expect((await app.inject('/api/v1/health/live')).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
