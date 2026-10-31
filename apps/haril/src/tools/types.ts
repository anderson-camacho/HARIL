// Shapes of `haril tools status` (JSON schema "haril.tools.status/1"). Keys are stable: an absent value is null.

export type ToolId = "engram" | "gentle-ai";

export const TOOL_IDS: readonly ToolId[] = ["engram", "gentle-ai"];

// Where an install was found, in discovery order: HARIL's own copy, the memory.binary override, PATH, a Go bin dir.
export type InstallOrigin = "haril" | "config" | "path" | "go-bin";

export type ToolState = "ok" | "outdated" | "missing" | "unknown";

export interface Install {
  readonly path: string;
  // The first place it was found in; `origins` lists every place that led to the same file.
  readonly origin: InstallOrigin;
  readonly origins: readonly InstallOrigin[];
  readonly version: string | null;
  readonly versionError: string | null;
  // The install that would actually run: the runtime's Engram binary, or the first gentle-ai on PATH.
  readonly active: boolean;
}

export interface ToolStatus {
  readonly id: ToolId;
  readonly state: ToolState;
  readonly active: Install | null;
  // Every install found, the active one first.
  readonly installs: readonly Install[];
  readonly latest: string | null;
  readonly latestCheckedAt: string | null;
  // The version HARIL is qualified for: the Engram pin; null for gentle-ai.
  readonly qualified: string | null;
  // The latest published Engram is newer than the qualified one. Notification only.
  readonly newerUpstream: boolean;
  readonly notes: readonly string[];
}

// The last Engram install that failed, as the report shows it.
export interface InstallFailure {
  readonly failedAt: string;
  readonly message: string;
  // When `haril tools ensure` tries again by itself; null once the cooldown is over (a new attempt is allowed now).
  readonly retryAt: string | null;
}

// What haril.json sets for the memory provider, apart from what the runtime recorded when it last ran. `provider` is
// null when the file says nothing usable: no memory section, no file, or one that cannot be read.
export interface MemoryConfigView {
  readonly provider: "null" | "engram" | null;
  readonly binary?: string;
}

export interface ToolsReport {
  readonly schema: "haril.tools.status/1";
  readonly generatedAt: string;
  readonly tools: readonly ToolStatus[];
  // Present when the caller read the settings, so a report built without them keeps the shape it always had.
  readonly memoryConfig?: MemoryConfigView;
  // Present only while a failed Engram install is on record, so a report without one keeps the shape it always had.
  readonly engramInstallFailure?: InstallFailure;
}
