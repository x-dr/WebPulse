import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/routes.js';
import { lockSite } from '../sites/store.js';
import { ApiError } from '../../http/errors.js';
import { retentionPlan, validRetention, type RetentionSettings } from './plan.js';

export function registerRetention(app: FastifyInstance, auth: AuthService) {
  const properties = {
    raw_retention_days: { type: 'integer', minimum: 7, maximum: 30 },
    member_retention_days: { type: 'integer', minimum: 30, maximum: 90 },
    aggregate_retention_days: { type: 'integer', minimum: 90, maximum: 365 },
  };
  app.get<{
    Params: { site_id: string };
    Querystring: Partial<Record<keyof RetentionSettings, string>>;
  }>(
    '/api/v1/sites/:site_id/retention-preview',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            Object.keys(properties).map((k) => [k, { type: 'string', pattern: '^[0-9]{1,3}$' }]),
          ),
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return {
        data: await auth.managed(request, async (client) => {
          await auth.authenticate(client, request, false);
          const site = await lockSite(client, request.params.site_id);
          if (site.maintenance_state !== 'active') throw new ApiError(409, 'site_maintenance');
          const settings = {
            ...Object.fromEntries(
              Object.keys(properties).map((k) => [
                k,
                Number(
                  request.query[k as keyof RetentionSettings] ?? site[k as keyof RetentionSettings],
                ),
              ]),
            ),
          } as RetentionSettings;
          if (!validRetention(settings)) throw new ApiError(400, 'invalid_retention');
          return { settings, layers: await retentionPlan(client, site, settings) };
        }),
      };
    },
  );
  app.patch<{ Params: { site_id: string }; Body: RetentionSettings & { confirm_name: string } }>(
    '/api/v1/sites/:site_id/retention',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [...Object.keys(properties), 'confirm_name'],
          properties: { ...properties, confirm_name: { type: 'string', maxLength: 80 } },
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return {
        data: await auth.managed(request, async (client) => {
          await auth.authenticate(client, request, true);
          const site = await lockSite(client, request.params.site_id, 'UPDATE');
          if (site.maintenance_state !== 'active')
            throw new ApiError(409, 'maintenance_in_progress');
          if (site.name !== request.body.confirm_name)
            throw new ApiError(400, 'confirmation_mismatch');
          if (!validRetention(request.body)) throw new ApiError(400, 'invalid_retention');
          await client.query(
            'UPDATE sites SET raw_retention_days=$2,member_retention_days=$3,aggregate_retention_days=$4 WHERE id=$1',
            [
              site.id,
              request.body.raw_retention_days,
              request.body.member_retention_days,
              request.body.aggregate_retention_days,
            ],
          );
          await client.query(
            'UPDATE site_data_coverage SET retention_version=retention_version+1,revision=revision+1 WHERE site_id=$1',
            [site.id],
          );
          return { layers: await retentionPlan(client, { ...site, ...request.body }) };
        }),
      };
    },
  );
}
