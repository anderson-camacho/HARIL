import type { StoreGate } from "@haril/core/ports";

// Gates that depend only on the runtime versions (no file is touched). M1-D1: Node outside the
// supported range is a warning; SQLite below 3.51.3 is a hard error (INV-16).
export const MIN_SQLITE_VERSION = "3.51.3";
export const NODE_RANGE = "^24.21.0 || >=26.8.0";

export interface RuntimeVersions {
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
}

type Version = readonly [number, number, number];

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// Equivalent to "^24.21.0 || >=26.8.0".
function inNodeRange(version: Version): boolean {
  const onLine24 = version[0] === 24 && compare(version, [24, 21, 0]) >= 0;
  return onLine24 || compare(version, [26, 8, 0]) >= 0;
}

export function evaluateGates(versions: RuntimeVersions): StoreGate[] {
  return [sqliteGate(versions.sqliteVersion), nodeGate(versions.nodeVersion)];
}

export function hasErrorGate(gates: readonly StoreGate[]): boolean {
  return gates.some((gate) => gate.status === "error");
}

function sqliteGate(sqliteVersion: string): StoreGate {
  const version = parseVersion(sqliteVersion);
  if (version === null) {
    return {
      name: "sqlite",
      status: "error",
      detail: `cannot read the SQLite version "${sqliteVersion}". Remedy: use a Node release bundling SQLite ${MIN_SQLITE_VERSION} or newer.`,
    };
  }
  const minimum = parseVersion(MIN_SQLITE_VERSION) ?? [3, 51, 3];
  if (compare(version, minimum) < 0) {
    return {
      name: "sqlite",
      status: "error",
      detail: `SQLite ${sqliteVersion} is older than ${MIN_SQLITE_VERSION}. Remedy: use a Node release bundling SQLite ${MIN_SQLITE_VERSION} or newer (INV-16).`,
    };
  }
  return { name: "sqlite", status: "ok", detail: `SQLite ${sqliteVersion}` };
}

function nodeGate(nodeVersion: string): StoreGate {
  const version = parseVersion(nodeVersion);
  if (version === null || version[0] < 24) {
    return {
      name: "node",
      status: "error",
      detail: `Node ${nodeVersion} cannot run the store. Remedy: use Node ${NODE_RANGE}.`,
    };
  }
  if (!inNodeRange(version)) {
    return {
      name: "node",
      status: "warn",
      detail: `Node ${nodeVersion} is outside ${NODE_RANGE}. The Pi launch path (M2) refuses it (INV-19).`,
    };
  }
  return { name: "node", status: "ok", detail: `Node ${nodeVersion}` };
}
