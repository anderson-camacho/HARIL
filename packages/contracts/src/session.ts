import { type Static, Type } from "typebox";
import { RunIdSchema, SessionIdSchema } from "./primitives.js";

// TODO(schemas.md section 4, SessionId row / ARCH 8.2): schemas.md defines no Session entity,
// only the SessionId (one per run, 1:1 with the run). The shape { sessionId, runId } is a guess.
export const SessionSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    runId: RunIdSchema,
  },
  { additionalProperties: false },
);
export type Session = Static<typeof SessionSchema>;
