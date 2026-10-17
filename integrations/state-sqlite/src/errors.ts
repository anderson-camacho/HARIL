// Errors of the SQLite store. `code` is the stable `store.*` identifier; `details` is machine-readable.
export type StoreErrorCode =
  | "store.gate_failed"
  | "store.migration_failed"
  | "store.conflict"
  | "store.not_found"
  | "store.fenced"
  | "store.stale"
  | "store.io";

// The gate refusal of a haril.db another application wrote, shared by the open and the read-only readers.
export function foreignApplicationError(applicationId: number): StoreError {
  return new StoreError(
    "store.gate_failed",
    "haril.db belongs to another application (application_id differs). Remedy: point HARIL_HOME or --data-dir at a HARIL data directory.",
    { gate: "application_id", applicationId },
  );
}

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
