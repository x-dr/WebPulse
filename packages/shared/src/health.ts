import { Type, type Static } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('ok'), Type.Literal('unavailable')]),
    service: Type.Literal('webpulse'),
    check: Type.Union([Type.Literal('live'), Type.Literal('ready')]),
  },
  { additionalProperties: false },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;
