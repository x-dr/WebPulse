import type { CollectionRules } from './collection.js';
export const defaultRules: CollectionRules = {
  routing_mode: 'history',
  excluded_prefixes: ['/auth/callback', '/reset-password', '/payment/result'],
  redact_identifiers: true,
  allow_utm: false,
  exclude_bots: true,
};
