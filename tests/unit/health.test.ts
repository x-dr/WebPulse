import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';

const apps: ReturnType<typeof buildApp>[] = [];
function create(ready: () => Promise<void>) {
  const app = buildApp({ ready });
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('health and transport boundaries', () => {
  it('keeps liveness independent of an unavailable database', async () => {
    const app = create(async () => {
      throw new Error('private database details');
    });
    const live = await app.inject('/api/v1/health/live');
    const ready = await app.inject('/api/v1/health/ready');
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'unavailable', service: 'webpulse', check: 'ready' });
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.body).not.toContain('private');
  });

  it('reports readiness only after the database check succeeds', async () => {
    const app = create(async () => {});
    const response = await app.inject('/api/v1/health/ready');
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('does not echo URLs, query strings or driver errors', async () => {
    const app = create(async () => {});
    app.get('/broken', async () => {
      throw new Error('private database details');
    });
    const missing = await app.inject('/missing?token=private-value');
    const broken = await app.inject('/broken');
    expect(missing.statusCode).toBe(404);
    expect(broken.statusCode).toBe(500);
    expect(missing.body + broken.body).not.toContain('private');
  });

  it('rejects unknown fields and type coercion instead of silently accepting them', async () => {
    const app = create(async () => {});
    app.post(
      '/validation',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['count'],
            properties: { count: { type: 'integer' } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    for (const payload of [{ count: 1, unknown: true }, { count: '1' }]) {
      expect((await app.inject({ method: 'POST', url: '/validation', payload })).statusCode).toBe(
        400,
      );
    }
    expect(
      (await app.inject({ method: 'POST', url: '/validation', payload: { count: 1 } })).statusCode,
    ).toBe(200);
  });
});
