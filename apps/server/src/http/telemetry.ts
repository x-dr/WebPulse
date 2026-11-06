import type { FastifyInstance } from 'fastify';

const bounds = [10, 25, 50, 100, 150, 200, 500, 1000, 2000, 5000, Infinity];

/** Fixed memory counters. Never retain URLs, query strings, bodies or identity labels. */
export function registerTelemetry(app: FastifyInstance) {
  const starts = new WeakMap<object, number>();
  const latency = bounds.map(() => 0);
  const statuses = { success: 0, rejected: 0, failed: 0 };
  app.addHook('onRequest', (request, _reply, done) => {
    starts.set(request, performance.now());
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const start = starts.get(request);
    if (start !== undefined) {
      const ms = performance.now() - start;
      latency[bounds.findIndex((bound) => ms <= bound)]!++;
      statuses[
        reply.statusCode < 400 ? 'success' : reply.statusCode < 500 ? 'rejected' : 'failed'
      ]++;
    }
    done();
  });
  return () => ({
    responses: { ...statuses },
    latency_buckets: bounds.map((bound, i) => ({
      upper_ms: Number.isFinite(bound) ? bound : null,
      count: latency[i],
    })),
    memory: process.memoryUsage(),
    uptime_seconds: process.uptime(),
    node_version: process.versions.node,
  });
}
