import type { DatabaseSync } from "node:sqlite";
import type { RuntimeLeaseSummary } from "@haril/core/ports";

// The newest runtime lease (M1-D6), shared by the store and the read-only readers (haril memory status, MC-T4).
const LEASE_COLUMNS =
  "instance_id AS instanceId, pid, started_at AS startedAt, heartbeat_at AS heartbeatAt, expires_at AS expiresAt, status, node_version AS nodeVersion, sqlite_version AS sqliteVersion";

type LeaseRow = Extract<RuntimeLeaseSummary, { status: "active" | "released" | "lost" }>;

export function readLeaseSummary(db: DatabaseSync): RuntimeLeaseSummary {
  const row = db
    .prepare(
      `SELECT ${LEASE_COLUMNS} FROM runtime_leases ORDER BY (status = 'active') DESC, runtime_epoch DESC LIMIT 1`,
    )
    .get() as unknown as LeaseRow | undefined;
  return row ?? { status: "none" };
}
