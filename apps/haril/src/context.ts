import type { AgentRuntime, Clock, Ids, Store } from "@haril/core/ports";
import type { StoreInspection } from "@haril/state-sqlite";
import type { ProviderEntry, ProviderListing } from "./providers.js";
import type { SignalSource } from "./runtime/shutdown.js";

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
  // stdin and stdout are a terminal, so a bare `haril` opens the shell instead of printing help. Absent means no.
  readonly interactive?: boolean;
  // Store inspection (read-only) and opening; defaults to the real SQLite store.
  readonly inspectStore?: (dataDir: string) => StoreInspection;
  readonly openStore?: (dataDir: string) => Store;
  readonly clock?: Clock;
  readonly ids?: Ids;
  // Agent runtime used by `haril start`; defaults to the simulated FakeAgentRuntime (M1-D7).
  readonly agentRuntime?: AgentRuntime;
  // Liveness of a lease holder's pid; defaults to the real process check (M1 fix c). Tests inject it.
  readonly isPidAlive?: (pid: number) => boolean;
  // Signals that stop `haril start` and `haril run` in order (ARCH 4.2); defaults to the process. Tests inject an emitter.
  readonly signals?: SignalSource;
  // Exit on a second signal; defaults to process.exit. Tests inject a spy.
  readonly forceExit?: (code: number) => void;
  // Provider probe used by `doctor` (M3-T7): defaults to the real catalog query of each provider. Tests that do
  // not exercise the network inject a fixed answer so they stay hermetic.
  readonly providerProbe?: (
    providers: readonly ProviderEntry[],
  ) => Promise<readonly ProviderListing[]>;
  // Per-request timeout of the real provider calls (doctor and models). Tests raise it so a cold start under
  // load is never reported as unreachable; production keeps the defaults in providers.ts.
  readonly gatewayTimeoutMs?: number;
  // Runtime inspection for doctor (M2-T3); reads files only and never executes them. Defaults to the real reader.
  readonly inspectRuntime?: (runtimeRoot: string, platform: string) => RuntimeInspection;
  // Directory of the native block.md files (M3-T1); defaults to the blocks beside the bundle or the repo root.
  readonly blocksDir?: string;
}

// The runtime installed by `npm run runtime:install` (M2-T3), as doctor reports it.
export interface RuntimeInspection {
  readonly status: "ok" | "warn";
  readonly root: string;
  readonly manifest: string;
  readonly detail: string;
  readonly node?: { readonly version: string; readonly path: string };
  readonly pi?: { readonly version: string; readonly cliPath: string };
}

export const EXIT_OK = 0;
// M1-D2: 0 ok, 1 warnings or an invalid plan, 2 errors and usage problems.
export const EXIT_INVALID = 1;
export const EXIT_WARN = 1;
export const EXIT_USAGE = 2;
export const EXIT_ERROR = 2;
