import { type Static, Type } from "typebox";

// Closed vocabularies from docs/contracts/schemas.md section 3 (one definition each).
// Adding a value to a closed vocabulary is a version break and needs an ADR.

export const TaskStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("running"),
  Type.Literal("blocked"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
export type TaskState = Static<typeof TaskStateSchema>;

export const TaskPhaseSchema = Type.Union([
  Type.Literal("executing"),
  Type.Literal("verifying"),
  Type.Literal("integrating"),
  Type.Literal("recovering"),
]);
export type TaskPhase = Static<typeof TaskPhaseSchema>;

export const BlockReasonSchema = Type.Union([
  Type.Literal("awaiting_human"),
  Type.Literal("needs_authorization"),
  Type.Literal("budget"),
  Type.Literal("cooldown"),
  Type.Literal("surface_conflict"),
  Type.Literal("dep_failed"),
  Type.Literal("memory_unavailable"),
  Type.Literal("no_route"),
  Type.Literal("sandbox_unavailable"),
  Type.Literal("block_unavailable"),
]);
export type BlockReason = Static<typeof BlockReasonSchema>;

export const RetryReasonSchema = Type.Union([
  Type.Literal("transient"),
  Type.Literal("orphaned"),
  Type.Literal("verify_failed"),
  Type.Literal("route_failover"),
]);
export type RetryReason = Static<typeof RetryReasonSchema>;

export const TaskKindSchema = Type.Union([
  Type.Literal("work"),
  Type.Literal("plan"),
  Type.Literal("verify"),
  Type.Literal("summarize"),
]);
export type TaskKind = Static<typeof TaskKindSchema>;

export const DataClassSchema = Type.Union([
  Type.Literal("public"),
  Type.Literal("internal"),
  Type.Literal("secret"),
]);
export type DataClass = Static<typeof DataClassSchema>;
