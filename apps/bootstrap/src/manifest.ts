import { MANIFEST_SCHEMA_VERSION } from "./constants.js";

// runtime/manifest.json (M2-T3). The doctor reads the same shape; `node.sha256` is null only for a Node
// that was already installed before the manifest existed (its archive was not re-verified).

export interface Manifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly node: {
    readonly version: string;
    readonly path: string;
    readonly sha256: string | null;
  };
  readonly pi: {
    readonly version: string;
    readonly cliPath: string;
  };
  readonly installedAt: string;
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseManifest(text: string): Manifest {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error("unsupported manifest schema");
  }
  const node = objectField(value, "node");
  const pi = objectField(value, "pi");
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    node: {
      version: stringField(node, "version"),
      path: stringField(node, "path"),
      sha256: node.sha256 === null ? null : stringField(node, "sha256"),
    },
    pi: { version: stringField(pi, "version"), cliPath: stringField(pi, "cliPath") },
    installedAt: stringField(value, "installedAt"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`manifest field ${key} must be an object`);
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`manifest field ${key} must be a string`);
  return value;
}
