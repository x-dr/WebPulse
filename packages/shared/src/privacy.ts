import type { CollectionRules, PageViewEvent } from './collection.js';

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin === 'null' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('invalid_origin');
  return url.origin;
}

// No configurable regular expressions: both execution cost and rule history stay bounded.
export function cleanPath(input: string, rules: CollectionRules): string | null {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\'))
    throw new Error('invalid_path');
  const raw = input.split(/[?#]/, 1)[0]!;
  const segments = raw.split('/').map((part) => decodeURIComponent(part).normalize('NFC'));
  if (
    segments.some(
      (part) =>
        [...part].some(
          (char) =>
            char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\',
        ) ||
        part === '.' ||
        part === '..',
    )
  )
    throw new Error('invalid_path');
  const decoded = segments.join('/');
  if (
    rules.excluded_prefixes.some(
      (prefix) =>
        decoded === prefix || decoded.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
    )
  )
    return null;
  const path = segments
    .map((segment) => {
      if (
        rules.redact_identifiers &&
        (/^\d+$/.test(segment) ||
          /@/.test(segment) ||
          /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(segment) ||
          /^[a-zA-Z0-9_.=-]{24,}$/.test(segment))
      )
        return ':id';
      return segment === ':id'
        ? segment
        : encodeURI(segment).replace(/[?#]/g, (char) => encodeURIComponent(char));
    })
    .join('/');
  if (new TextEncoder().encode(path).length > 512) throw new Error('invalid_path');
  return path;
}

export function referrerHost(value = ''): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.length <= 253
      ? url.hostname
      : '!invalid';
  } catch {
    return '!invalid';
  }
}
export function cleanUtm(
  value: PageViewEvent['utm'],
  rules: CollectionRules,
): [string, string, string] {
  return ['utm_source', 'utm_medium', 'utm_campaign'].map((key) => {
    const field = value?.[key as keyof NonNullable<PageViewEvent['utm']>];
    // A deliberate low-cardinality label alphabet excludes addresses and URL payloads.
    return rules.allow_utm && field && /^[\p{L}\p{N} _.-]{1,64}$/u.test(field)
      ? field.normalize('NFC')
      : '';
  }) as [string, string, string];
}
export function sourceChannel(host: string, ownHost: string, utm: string[]): string {
  if (utm.some(Boolean)) return 'campaign';
  if (host === '!invalid') return 'unknown';
  if (!host || host === ownHost) return 'direct';
  if (
    /^(www\.)?(google\.[a-z.]+|bing\.com|baidu\.com|duckduckgo\.com|search\.yahoo\.com)$/.test(host)
  )
    return 'organic';
  return 'referral';
}
