import { defaultRules, type CollectionRules } from '@webpulse/shared';
import type pg from 'pg';
import { ApiError } from '../../http/errors.js';

export type Site = {
  id: string;
  public_id: string;
  name: string;
  primary_origin: string;
  allowed_origins: string[];
  timezone: string;
  enabled: boolean;
  maintenance_state: string;
  config: Partial<CollectionRules> & { identity_epochs?: unknown[] };
  rule_version: number;
  key_version: number;
  raw_retention_days: number;
  member_retention_days: number;
  aggregate_retention_days: number;
};
export const rulesFor = (config: Partial<CollectionRules>): CollectionRules => ({
  routing_mode: config.routing_mode ?? defaultRules.routing_mode,
  excluded_prefixes: config.excluded_prefixes ?? defaultRules.excluded_prefixes,
  redact_identifiers: config.redact_identifiers ?? defaultRules.redact_identifiers,
  allow_utm: config.allow_utm ?? defaultRules.allow_utm,
  exclude_bots: config.exclude_bots ?? defaultRules.exclude_bots,
});
export async function lockSite(
  client: pg.PoolClient,
  publicId: string,
  mode: 'SHARE' | 'UPDATE' = 'SHARE',
): Promise<Site> {
  const result = await client.query<Site>(`SELECT * FROM sites WHERE public_id=$1 FOR ${mode}`, [
    publicId,
  ]);
  if (!result.rows[0]) throw new ApiError(404, 'site_not_found');
  return result.rows[0];
}
export function checkSite(site: Site, origin: string | undefined) {
  if (site.maintenance_state !== 'active')
    throw new ApiError(
      409,
      site.maintenance_state === 'deleting' ? 'site_deleting' : 'site_maintenance',
    );
  if (!site.enabled) throw new ApiError(403, 'site_disabled');
  if (!origin || origin === 'null' || !site.allowed_origins.includes(origin))
    throw new ApiError(403, 'origin_denied');
}
