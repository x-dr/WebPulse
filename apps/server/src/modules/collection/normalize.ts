import {
  cleanPath,
  cleanUtm,
  referrerHost,
  type CollectionEvent,
  type CollectionRules,
} from '@webpulse/shared';
import { digest } from '../identity/keys.js';
import { ApiError } from '../../http/errors.js';

export function normalizedEvent(
  event: CollectionEvent,
  rules: CollectionRules,
  key: Buffer,
  epoch: number,
) {
  let path = '';
  if (event.type === 'page_view') {
    if (event.event_id !== event.page_view_id) throw new ApiError(400, 'invalid_schema');
    try {
      path = cleanPath(event.page.path, rules) ?? '';
    } catch {
      throw new ApiError(400, 'invalid_path');
    }
  }
  const host = event.type === 'page_view' ? referrerHost(event.referrer) : '';
  const utm = cleanUtm(event.type === 'page_view' ? event.utm : undefined, rules);
  const payload = [
    1,
    key.toString('hex'),
    epoch,
    event.type,
    event.page_view_id,
    ...(event.type === 'page_view'
      ? [event.page.origin, path, host, ...utm, event.reason]
      : [event.interaction_kind]),
  ];
  return { path, host, utm, fingerprint: digest(JSON.stringify(payload)) };
}
