import type { FastifyInstance } from 'fastify';
import { HealthResponseSchema, type HealthResponse } from '@webpulse/shared';

export function registerHealthRoutes(app: FastifyInstance, ready: () => Promise<void>): void {
  app.get(
    '/api/v1/health/live',
    {
      schema: { response: { 200: HealthResponseSchema } },
    },
    async (): Promise<HealthResponse> => ({ status: 'ok', service: 'webpulse', check: 'live' }),
  );

  app.get(
    '/api/v1/health/ready',
    {
      schema: { response: { 200: HealthResponseSchema, 503: HealthResponseSchema } },
    },
    async (_request, reply): Promise<HealthResponse> => {
      reply.header('Cache-Control', 'no-store');
      try {
        await ready();
        return { status: 'ok', service: 'webpulse', check: 'ready' };
      } catch {
        reply.code(503);
        return { status: 'unavailable', service: 'webpulse', check: 'ready' };
      }
    },
  );
}
