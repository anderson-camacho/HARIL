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

export interface ToolsReport {
  readonly schema: "haril.tools.status/1";
  readonly generatedAt: string;
  readonly tools: readonly ToolStatus[];
}
