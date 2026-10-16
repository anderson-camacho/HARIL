import { type Static, Type } from "typebox";

// Provider vocabulary for M2 (docs/contracts/schemas.md sections 8.1 and 9.2). Minimal slice: only the
// fields the OpenAI-compatible adapter fills. Adding fields is a version decision, not an edit here.

// ModelDescriptor v1 (minimal). The full shape (caps, data policy, verification) arrives with the catalog.
export const ModelDescriptorSchema = Type.Object(
  {
    providerId: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
    displayName: Type.Optional(Type.String({ minLength: 1 })),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    capabilities: Type.Optional(
      Type.Object({ tools: Type.Boolean() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
export type ModelDescriptor = Static<typeof ModelDescriptorSchema>;

// Usage v1. A count the provider does not report is null, never 0 (schemas.md 8.1, MPR-02).
const NullableCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

export const UsageSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    inputTokens: NullableCount,
    outputTokens: NullableCount,
    cachedInputTokens: Type.Optional(NullableCount),
    reasoningTokens: Type.Optional(NullableCount),
  },
  { additionalProperties: false },
);
export type Usage = Static<typeof UsageSchema>;
