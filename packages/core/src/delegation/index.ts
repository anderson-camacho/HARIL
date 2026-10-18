// Delegation layer of @haril/core: pure rules of the three-layer delegation (docs/modos-y-delegacion.md 3, ADR-0021).
// Agents propose, these rules validate, and the Runtime creates; nothing here does I/O or reads the clock.
export * from "./archetypes.js";
export * from "./globs.js";
export * from "./limits.js";
export * from "./select-claims.js";
