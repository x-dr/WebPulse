import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/routes.js';
import { ApiError } from '../../http/errors.js';
import { publicJob, requestDeletion } from './jobs.js';
import type { DeletionEncryptor } from './encryption.js';

export function registerDeletion(app: FastifyInstance, auth: AuthService, key?: DeletionEncryptor) {
  app.delete<{ Params: { site_id: string }; Body: { confirm_name: string } }>(
    '/api/v1/sites/:site_id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['site_id'],
          properties: { site_id: { type: 'string', minLength: 8, maxLength: 64 } },
        },
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['confirm_name'],
          properties: { confirm_name: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    async (request, reply) => {
      const data = await auth.managed(request, async (client) => {
        await auth.authenticate(client, request, true);
        return requestDeletion(
          client,
          {
            site: request.params.site_id,
            kind: 'site',
            confirmName: request.body.confirm_name,
            idempotencyKey: String(request.headers['idempotency-key']),
          },
          key,
        );
      });
      return reply.code(202).header('cache-control', 'private, no-store').send({ data });
    },
  );
  app.get<{ Params: { job_id: string } }>(
    '/api/v1/jobs/:job_id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['job_id'],
          properties: { job_id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return {
        data: await auth.managed(request, async (client) => {
          await auth.authenticate(client, request, false);
          const job = (
            await client.query('SELECT * FROM deletion_jobs WHERE id=$1', [request.params.job_id])
          ).rows[0];
          if (!job) throw new ApiError(404, 'job_not_found');
          return publicJob(job);
        }),
      };
    },
  );
}
