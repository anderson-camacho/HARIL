// Injected time and identifiers. The Core never reads the clock or randomness itself (R7).

export type EpochMs = number;

export type Cancel = () => void;

export interface Clock {
  now(): EpochMs;
  // Runs `run` after `delayMs` of clock time; the returned function cancels it.
  schedule(delayMs: number, run: () => void): Cancel;
}

export interface Ids {
  // Returns a new opaque identifier (ULID in production, sequential in tests).
  next(): string;
}
