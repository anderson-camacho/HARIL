import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TOOL_IDS, type ToolId } from "./types.js";

// <runtime root>/state/tools.json: only what costs a network call to learn, per tool, the latest published version and
// when it was last asked for or failed. What is installed is found again on every run and never stored.
//
// The file is a cache, so a damaged one is simply an empty one: reading never throws. Writing goes to a temporary file
// beside it that is renamed over it, so a reader never sees half a file and a failed write leaves the old one.

export interface ToolRecord {
  readonly latest?: string;
  readonly latestCheckedAt?: string;
  readonly lastFailureAt?: string;
  readonly lastFailure?: string;
}

// The last Engram install that failed, kept so a console that starts again does not retry for a while.
interface EngramInstallFailure {
  readonly failedAt: string;
  readonly message: string;
}

export interface ToolsState {
  readonly version: 1;
  readonly tools: Partial<Record<ToolId, ToolRecord>>;
  // Optional, so a file written before it existed reads as before, and one that has it still reads as version 1.
  readonly engramInstall?: EngramInstallFailure;
}

const MAX_FAILURE_LENGTH = 200;

// How long `haril tools ensure` waits after a failed Engram install before it tries again by itself.
export const INSTALL_COOLDOWN_MS = 6 * 3_600_000;

export function emptyToolsState(): ToolsState {
  return { version: 1, tools: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseRecord(value: unknown): ToolRecord | undefined {
  if (!isRecord(value)) return undefined;
  const record: { -readonly [K in keyof ToolRecord]: ToolRecord[K] } = {};
  if (typeof value.latest === "string" && /^\d+\.\d+\.\d+$/.test(value.latest)) {
    record.latest = value.latest;
  }
  if (isoTime(value.latestCheckedAt)) record.latestCheckedAt = value.latestCheckedAt;
  if (isoTime(value.lastFailureAt)) record.lastFailureAt = value.lastFailureAt;
  if (typeof value.lastFailure === "string") {
    record.lastFailure = value.lastFailure.slice(0, MAX_FAILURE_LENGTH);
  }
  return record;
}

function parseInstallFailure(value: unknown): EngramInstallFailure | undefined {
  if (!isRecord(value) || !isoTime(value.failedAt) || typeof value.message !== "string") {
    return undefined;
  }
  return { failedAt: value.failedAt, message: value.message.slice(0, MAX_FAILURE_LENGTH) };
}

// Any text is accepted: what cannot be read as the current schema is dropped, never reported as an error.
export function parseToolsState(text: string | undefined): ToolsState {
  if (text === undefined) return emptyToolsState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyToolsState();
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.tools)) {
    return emptyToolsState();
  }
  const tools: Partial<Record<ToolId, ToolRecord>> = {};
  for (const id of TOOL_IDS) {
    const record = parseRecord(parsed.tools[id]);
    if (record !== undefined) tools[id] = record;
  }
  const engramInstall = parseInstallFailure(parsed.engramInstall);
  return engramInstall === undefined ? { version: 1, tools } : { version: 1, tools, engramInstall };
}

export function readToolsState(path: string): ToolsState {
  try {
    return parseToolsState(readFileSync(path, "utf8"));
  } catch {
    return emptyToolsState();
  }
}

export function writeToolsState(path: string, state: ToolsState): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    // Owner-only where the platform has modes; on Windows the folder's inherited ACL applies.
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
