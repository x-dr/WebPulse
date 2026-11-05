import { readFile } from 'node:fs/promises';
import { buildApp } from '../../apps/server/src/app.js';
import { fixture } from './postgres.js';

/** Actual HTTP app and built dashboard over one origin; DB is an isolated random schema. */
export async function dashboardFixture() {
  const f = await fixture();
  const security = { ...f.security, secureCookie: false, adminOrigin: 'http://127.0.0.1:5173' };
  const app = buildApp({
    ready: async () => {},
    pool: f.pool,
    security,
    deletionKey: f.deletionKey,
  });
  const root = new URL('../../apps/dashboard/dist/', import.meta.url);
  app.get('/*', async (request, reply) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    if (path.startsWith('/assets/') && /^\/assets\/[\w.-]+\.(?:js|css)$/.test(path)) {
      return reply
        .type(path.endsWith('.js') ? 'application/javascript' : 'text/css')
        .send(await readFile(new URL(path.slice(1), root)));
    }
    return reply.type('text/html; charset=utf-8').send(await readFile(new URL('index.html', root)));
  });
  try {
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    security.adminOrigin = endpoint;
    return {
      ...f,
      endpoint,
      http: app,
      close: async () => {
        await app.close();
        await f.close();
      },
    };
  } catch (error) {
    await app.close();
    await f.close();
    throw error;
  }
}
