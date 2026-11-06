import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/routes.js';
import { lockSite } from '../sites/store.js';

export function registerDiagnostics(
  app: FastifyInstance,
  auth: AuthService,
  runtime: () => unknown,
) {
  app.get<{ Params: { site_id: string } }>(
    '/api/v1/sites/:site_id/diagnostics',
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return {
        data: await auth.managed(request, async (client) => {
          await auth.authenticate(client, request, false);
          const site = await lockSite(client, request.params.site_id);
          const collection = (
            await client.query(
              'SELECT max(received_at) AS last_accepted_at FROM events WHERE site_id=$1',
              [site.id],
            )
          ).rows[0];
          const dirty = (
            await client.query(
              'SELECT count(*)::int AS pending_buckets,min(updated_at) AS oldest_pending_at FROM dirty_buckets WHERE site_id=$1',
              [site.id],
            )
          ).rows[0];
          const coverage = (
            await client.query(
              'SELECT layer,observed_from,available_from,available_through,aggregated_through,finalized_through,cleanup_target,retention_version,revision FROM site_data_coverage WHERE site_id=$1 ORDER BY layer',
              [site.id],
            )
          ).rows;
          const gaps = (
            await client.query(
              'SELECT layer,start_utc,end_utc,reason FROM coverage_gaps WHERE site_id=$1 AND resolved_at IS NULL ORDER BY layer,start_utc LIMIT 100',
              [site.id],
            )
          ).rows;
          const jobs = (
            await client.query(
              'SELECT id AS job_id,status,phase,last_error_code FROM deletion_jobs WHERE site_public_id=$1 ORDER BY requested_at DESC LIMIT 10',
              [site.public_id],
            )
          ).rows;
          const worker =
            (
              await client.query(
                "SELECT last_started_at,last_succeeded_at,last_error_code,details->'clock_paused' AS clock_paused,details->'counters' AS counters FROM job_state WHERE name='maintenance'",
              )
            ).rows[0] ?? null;
          return {
            site_id: site.public_id,
            enabled: site.enabled,
            maintenance_state: site.maintenance_state,
            ...collection,
            ...dirty,
            coverage,
            gaps,
            jobs,
            worker,
            runtime: runtime(),
            rejection_counts: { available: false, reason: 'not_persisted' },
          };
        }),
      };
    },
  );
}
