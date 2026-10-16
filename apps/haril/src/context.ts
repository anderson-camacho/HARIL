import type { Clock, Ids, Store } from "@haril/core/ports";
import type { StoreInspection } from "@haril/state-sqlite";

// Shared shapes of the CLI: io, host ports and exit codes. Command modules depend on this file, never on cli.ts.

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): string;
}

// Everything the composition root injects. Tests replace the store and inspection; defaults are real.
export interface HostInfo {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  // Environment and home directory used to resolve the data directory (M1-D8).
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  // Working directory for relative paths; defaults to the process cwd.
  readonly cwd?: string;
  // Store inspection (read-only) and opening; defaults to the real SQLite store.
  readonly inspectStore?: (dataDir: string) => StoreInspection;
  readonly openStore?: (dataDir: string) => Store;
  readonly clock?: Clock;
  readonly ids?: Ids;
}

export const EXIT_OK = 0;
// M1-D2: 0 ok, 1 warnings or an invalid plan, 2 errors and usage problems.
export const EXIT_INVALID = 1;
export const EXIT_WARN = 1;
export const EXIT_USAGE = 2;
export const EXIT_ERROR = 2;
