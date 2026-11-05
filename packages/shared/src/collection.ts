import { Type, type Static } from '@sinclair/typebox';

const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
const enumeration = <T extends string>(values: T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));
export const RulesSchema = Type.Object(
  {
    routing_mode: enumeration(['history', 'hash', 'manual']),
    excluded_prefixes: Type.Array(Type.String({ minLength: 1, maxLength: 200, pattern: '^/' }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    redact_identifiers: Type.Boolean(),
    allow_utm: Type.Boolean(),
    exclude_bots: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CollectionRules = Static<typeof RulesSchema>;
export { defaultRules } from './rules.js';
const timestamp = Type.Optional(Type.String({ maxLength: 40, pattern: '^\\d{4}-\\d\\d-\\d\\dT' }));
const base = { event_id: uuid, page_view_id: uuid, client_ts: timestamp };
const utm = Type.Object(
  {
    utm_source: Type.Optional(Type.String({ maxLength: 64 })),
    utm_medium: Type.Optional(Type.String({ maxLength: 64 })),
    utm_campaign: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);
export const PageViewSchema = Type.Object(
  {
    ...base,
    type: Type.Literal('page_view'),
    page: Type.Object(
      {
        origin: Type.String({ maxLength: 300 }),
        path: Type.String({ minLength: 1, maxLength: 512 }),
      },
      { additionalProperties: false },
    ),
    referrer: Type.Optional(Type.String({ maxLength: 2048 })),
    utm: Type.Optional(utm),
    reason: enumeration(['initial', 'navigation', 'resume', 'bfcache', 'manual']),
  },
  { additionalProperties: false },
);
export const InteractionSchema = Type.Object(
  {
    ...base,
    type: Type.Literal('interaction'),
    interaction_kind: enumeration(['click', 'key', 'scroll']),
  },
  { additionalProperties: false },
);
export const EventSchema = Type.Union([PageViewSchema, InteractionSchema]);
export type PageViewEvent = Static<typeof PageViewSchema>;
export type InteractionEvent = Static<typeof InteractionSchema>;
export type CollectionEvent = Static<typeof EventSchema>;
const identity = {
  site_id: Type.String({ minLength: 8, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' }),
  cid: uuid,
  consent: Type.Literal('granted'),
};
export const CollectSchema = Type.Object(
  { ...identity, events: Type.Array(EventSchema, { minItems: 1, maxItems: 20 }) },
  { additionalProperties: false },
);
export const HeartbeatSchema = Type.Object(
  {
    ...identity,
    page_view_id: uuid,
    total_visible_ms: Type.Integer({ minimum: 0, maximum: 43_200_000 }),
    client_ts: timestamp,
  },
  { additionalProperties: false },
);
export type CollectBody = Static<typeof CollectSchema>;
export type HeartbeatBody = Static<typeof HeartbeatSchema>;
