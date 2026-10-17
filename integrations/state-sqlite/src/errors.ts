// Errors of the SQLite store. `code` is the stable `store.*` identifier; `details` is machine-readable.
export type StoreErrorCode =
  | "store.gate_failed"
  | "store.migration_failed"
  | "store.conflict"
  | "store.not_found"
  | "store.fenced"
  | "store.stale"
  | "store.io";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: StoreErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.details = details;
  }
}
