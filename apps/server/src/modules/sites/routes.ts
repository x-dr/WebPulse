import { randomBytes } from 'node:crypto';
import { RulesSchema, defaultRules, normalizeOrigin, type CollectionRules } from '@webpulse/shared';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/routes.js';
import { ApiError } from '../../http/errors.js';
import { lockSite, rulesFor, type Site } from './store.js';

type CreateSite = {
  name: string;
  primary_origin: string;
  allowed_origins: string[];
  timezone?: string;
  rules?: CollectionRules;
  raw_retention_days?: number;
  member_retention_days?: number;
  aggregate_retention_days?: number;
};
type PatchSite = Partial<
  Pick<CreateSite, 'name' | 'primary_origin' | 'allowed_origins' | 'rules'>
> & { enabled?: boolean };
const properties = {
  name: { type: 'string', minLength: 1, maxLength: 80 },
  primary_origin: { type: 'string', maxLength: 300 },
  allowed_origins: {
    type: 'array',
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
    items: { type: 'string', maxLength: 300 },
  },
  rules: RulesSchema,
};
function origins(primary: string, allowed: string[]) {
  try {
    if (
      normalizeOrigin(primary) !== primary ||
      allowed.some((value) => normalizeOrigin(value) !== value) ||
      !allowed.includes(primary)
    )
      throw new Error('origin');
  } catch {
    throw new ApiError(400, 'invalid_origin');
  }
}
function represent(site: Site, adminOrigin: string) {
  return {
    site_id: site.public_id,
    name: site.name,
    primary_origin: site.primary_origin,
    allowed_origins: site.allowed_origins,
    timezone: site.timezone,
    enabled: site.enabled,
    maintenance_state: site.maintenance_state,
    rules: rulesFor(site.config),
    rule_version: site.rule_version,
    raw_retention_days: site.raw_retention_days,
    member_retention_days: site.member_retention_days,
    aggregate_retention_days: site.aggregate_retention_days,
    tracker_url: `${adminOrigin}/tracker.js`,
    identity_retention_days: 90,
    identity_epochs: site.config.identity_epochs ?? [],
  };
}
export function registerSites(app: FastifyInstance, auth: AuthService, adminOrigin: string) {
  app.get('/api/v1/sites', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return {
      data: await auth.managed(request, async (client) => {
        await auth.authenticate(client, request, false);
        return (await client.query<Site>('SELECT * FROM sites ORDER BY id')).rows.map((site) =>
          represent(site, adminOrigin),
        );
      }),
    };
  });
  app.post<{ Body: CreateSite }>(
    '/api/v1/sites',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'primary_origin', 'allowed_origins'],
          properties: {
            ...properties,
            timezone: { type: 'string', maxLength: 80 },
            raw_retention_days: { type: 'integer', minimum: 7, maximum: 30 },
            member_retention_days: { type: 'integer', minimum: 30, maximum: 90 },
            aggregate_retention_days: { type: 'integer', minimum: 90, maximum: 365 },
          },
        },
      },
    },
    async (request, reply) => {
      const data = await auth.managed(request, async (client) => {
        await auth.authenticate(client, request, true);
        const body = request.body;
        origins(body.primary_origin, body.allowed_origins);
        const timezone = body.timezone ?? 'Asia/Shanghai';
        if (
          !(await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [timezone]))
            .rowCount
        )
          throw new ApiError(400, 'invalid_timezone');
        const publicId = `site_${randomBytes(16).toString('hex')}`;
        const config = body.rules ?? defaultRules;
        const site = (
          await client.query<Site>(
            `INSERT INTO sites(public_id,name,primary_origin,allowed_origins,timezone,config,raw_retention_days,member_retention_days,aggregate_retention_days)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb || jsonb_build_object('identity_epochs',jsonb_build_array(jsonb_build_object('visitor',1,'ip',1,'effective_at',clock_timestamp()))),$7,$8,$9) RETURNING *`,
            [
              publicId,
              body.name,
              body.primary_origin,
              JSON.stringify(body.allowed_origins),
              timezone,
              JSON.stringify(config),
              body.raw_retention_days ?? 30,
              body.member_retention_days ?? 90,
              body.aggregate_retention_days ?? 365,
            ],
          )
        ).rows[0]!;
        await client.query('INSERT INTO site_rules(site_id,version,config) VALUES ($1,1,$2)', [
          site.id,
          JSON.stringify(config),
        ]);
        return represent(site, adminOrigin);
      });
      reply.code(201).header('cache-control', 'private, no-store');
      return { data };
    },
  );
  app.get<{ Params: { site_id: string } }>('/api/v1/sites/:site_id', async (request, reply) => {
    reply.header('cache-control', 'private, no-store');
    return {
      data: await auth.managed(request, async (client) => {
        await auth.authenticate(client, request, false);
        return represent(await lockSite(client, request.params.site_id), adminOrigin);
      }),
    };
  });
  app.patch<{ Params: { site_id: string }; Body: PatchSite }>(
    '/api/v1/sites/:site_id',
    {
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: { ...properties, enabled: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const data = await auth.managed(request, async (client) => {
        await auth.authenticate(client, request, true);
        const old = await lockSite(client, request.params.site_id, 'UPDATE');
        if (old.maintenance_state !== 'active') throw new ApiError(409, 'maintenance_in_progress');
        const body = request.body;
        const primary = body.primary_origin ?? old.primary_origin;
        const allowed = body.allowed_origins ?? old.allowed_origins;
        origins(primary, allowed);
        const config = body.rules ?? rulesFor(old.config);
        const site = (
          await client.query<Site>(
            `UPDATE sites SET name=$2,primary_origin=$3,allowed_origins=$4,enabled=$5,config=config || $6::jsonb,rule_version=rule_version+1 WHERE id=$1 RETURNING *`,
            [
              old.id,
              body.name ?? old.name,
              primary,
              JSON.stringify(allowed),
              body.enabled ?? old.enabled,
              JSON.stringify(config),
            ],
          )
        ).rows[0]!;
        await client.query('INSERT INTO site_rules(site_id,version,config) VALUES ($1,$2,$3)', [
          site.id,
          site.rule_version,
          JSON.stringify(config),
        ]);
        return represent(site, adminOrigin);
      });
      reply.header('cache-control', 'private, no-store');
      return { data };
    },
  );
}
