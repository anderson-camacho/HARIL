// Delegation layer of @haril/core: pure rules of the three-layer delegation (docs/modos-y-delegacion.md 3, ADR-0021).
// Agents propose, these rules validate, and the Runtime creates; nothing here does I/O or reads the clock.
export * from "./archetypes.js";
export * from "./check-delegation.js";
export * from "./checkpoints.js";
export * from "./choose-model.js";
export * from "./globs.js";
export * from "./limits.js";
export * from "./liveness.js";
export * from "./order-preview.js";
export * from "./path-guard.js";
export * from "./rework.js";
export * from "./select-claims.js";
