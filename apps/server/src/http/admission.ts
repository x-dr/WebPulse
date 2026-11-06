import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';

/** Bound work before recovery checks, body parsing, authentication and pool acquisition. */
export function registerAdmission(app: FastifyInstance, capacity = 64) {
  let active = 0;
  let rejected = 0;
  app.addHook('onRequest', (request, reply, done) => {
    if (request.routeOptions.url?.startsWith('/api/v1/health/')) return done();
    if (active >= capacity) {
      rejected++;
      return done(new ApiError(503, 'server_busy'));
    }
    active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      reply.raw.off('finish', release);
      reply.raw.off('close', release);
    };
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
    done();
  });
  return () => ({ active_requests: active, rejected_requests: rejected, capacity });
}
