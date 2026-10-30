import { compareVersions } from "../version-compare.js";
import { type DetectDeps, detectInstalls } from "./detect.js";
import { LATEST_TTL_MS, type LatestFetch, lookupDue, lookupLatest } from "./latest.js";
import type { ToolRecord, ToolsState } from "./state.js";
import {
  type Install,
  TOOL_IDS,
  type ToolId,
  type ToolState,
  type ToolStatus,
  type ToolsReport,
} from "./types.js";

// Joins detection (always recomputed, cheap) with the latest published version (cached, asked for on demand) into the
// status of each tool. Engram is judged against the version HARIL is qualified for; gentle-ai against the latest one.

const GENTLE_AI_INSTALL =
  "go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@latest";

export interface ToolsInput {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  // HARIL's own copy of Engram, and the binary the runtime executes (memory.binary, or that same copy).
  readonly harilCopy: string;
  readonly runtimeBinary: string;
  // The Engram version HARIL is qualified for.
  readonly pin: string;
  // Problems found while reading the settings, shown with Engram.
  readonly notes?: readonly string[];
}

export interface ToolsDeps {
  readonly detect: DetectDeps;
  readonly fetch: LatestFetch;
  readonly now: () => number;
  readonly readState: () => ToolsState;
  readonly writeState: (state: ToolsState) => void;
}

// never: use only what is cached. if-due: ask GitHub when the cache is older than 24 h and no failure is under
// its 1 h cooldown. always: ask now (haril tools status --refresh).
export type RefreshMode = "never" | "if-due" | "always";

// What is known about the latest published version of one tool.
export interface LatestView {
  readonly latest: string | null;
  readonly checkedAt: string | null;
  readonly notes: readonly string[];
}

export interface ToolContext {
  readonly pin: string;
  readonly runtimeBinary: string;
}

function placesNote(installs: readonly Install[]): string | undefined {
  if (installs.length < 2) return undefined;
  const versions = [...new Set(installs.map((install) => install.version ?? "unknown"))];
  if (versions.length < 2) return undefined;
  return `installed in ${installs.length} places with different versions: ${versions.join(", ")}`;
}

interface Verdict {
  readonly state: ToolState;
  readonly notes: string[];
  readonly newerUpstream: boolean;
}

function engramVerdict(active: Install | null, view: LatestView, context: ToolContext): Verdict {
  const { pin } = context;
  const newerUpstream = view.latest !== null && compareVersions(view.latest, pin) > 0;
  const notes: string[] = [];
  if (newerUpstream) {
    notes.push(
      `Engram ${view.latest} is published, but HARIL is qualified for ${pin}; HARIL adopts a new Engram only once it has qualified it`,
    );
  }
  if (active === null) {
    notes.push(
      `Engram is not installed where HARIL runs it (expected at ${context.runtimeBinary}); install it with: npm run memory:install`,
    );
    return { state: "missing", notes, newerUpstream };
  }
  if (active.origin === "config") {
    notes.push("memory.binary in haril.json overrides HARIL's own copy of Engram");
  }
  if (active.version === null) {
    notes.push(`could not read the version of ${active.path}: ${active.versionError ?? "unknown"}`);
    return { state: "unknown", notes, newerUpstream };
  }
  const order = compareVersions(active.version, pin);
  if (order < 0) {
    notes.push(
      `Engram ${active.version} is older than the version HARIL is qualified for (${pin})`,
    );
    return { state: "outdated", notes, newerUpstream };
  }
  if (order > 0) {
    notes.push(
      `Engram ${active.version} is newer than the version HARIL is qualified for (${pin})`,
    );
  }
  return { state: "ok", notes, newerUpstream };
}

function gentleAiVerdict(active: Install | null, view: LatestView): Verdict {
  const notes: string[] = [];
  if (active === null) {
    notes.push(
      `gentle-ai was not found on PATH or in Go's bin directories; install it with: ${GENTLE_AI_INSTALL} (needs Go)`,
    );
    return { state: "missing", notes, newerUpstream: false };
  }
  if (!active.origins.includes("path")) {
    notes.push("gentle-ai is only in Go's bin directory, which is not on PATH");
  }
  if (active.version === null) {
    notes.push(`could not read the version of ${active.path}: ${active.versionError ?? "unknown"}`);
    return { state: "unknown", notes, newerUpstream: false };
  }
  if (view.latest === null) return { state: "unknown", notes, newerUpstream: false };
  if (compareVersions(active.version, view.latest) < 0) {
    notes.push(
      `gentle-ai ${view.latest} is available (installed ${active.version}); update it with: ${GENTLE_AI_INSTALL} (needs Go)`,
    );
    return { state: "outdated", notes, newerUpstream: false };
  }
  return { state: "ok", notes, newerUpstream: false };
}

// The pure classification of one tool; every note that explains the state is built here.
export function buildToolStatus(
  id: ToolId,
  installs: readonly Install[],
  view: LatestView,
  context: ToolContext,
): ToolStatus {
  const active = installs.find((install) => install.active) ?? null;
  const verdict =
    id === "engram" ? engramVerdict(active, view, context) : gentleAiVerdict(active, view);
  const places = placesNote(installs);
  return {
    id,
    state: verdict.state,
    active,
    installs,
    latest: view.latest,
    latestCheckedAt: view.checkedAt,
    qualified: id === "engram" ? context.pin : null,
    newerUpstream: verdict.newerUpstream,
    notes: [...verdict.notes, ...(places === undefined ? [] : [places]), ...view.notes],
  };
}

interface Resolved {
  readonly view: LatestView;
  readonly record: ToolRecord | undefined;
  readonly changed: boolean;
}

const REFRESH_HINT = "run: haril tools status --refresh";

async function resolveLatest(
  id: ToolId,
  record: ToolRecord | undefined,
  mode: RefreshMode,
  deps: ToolsDeps,
): Promise<Resolved> {
  const now = deps.now();
  const at = new Date(now).toISOString();
  const lookingUp = mode === "always" || (mode === "if-due" && lookupDue(record, now));
  const notes: string[] = [];
  let next = record;
  let failed: string | undefined;

  if (lookingUp) {
    const result = await lookupLatest(id, deps.fetch);
    if (result.ok) {
      next = { latest: result.version, latestCheckedAt: at };
    } else {
      failed = result.reason;
      next = { ...record, lastFailureAt: at, lastFailure: result.reason };
    }
  }

  const latest = next?.latest ?? null;
  const checkedAt = next?.latestCheckedAt ?? null;
  const since = checkedAt === null ? undefined : now - Date.parse(checkedAt);
  if (failed !== undefined) {
    const kept = checkedAt === null ? "" : ` (showing the one checked at ${checkedAt})`;
    notes.push(`could not check the latest version: ${failed}${kept}`);
  } else if (latest === null) {
    notes.push(`the latest version has not been checked yet; ${REFRESH_HINT}`);
  } else if (!lookingUp && since !== undefined && since >= LATEST_TTL_MS) {
    notes.push(
      `the latest version is from a check older than 24 h (${checkedAt}); ${REFRESH_HINT}`,
    );
  }
  if (!lookingUp && next?.lastFailure !== undefined && next.lastFailureAt !== undefined) {
    // A failure older than the last good check says nothing about the value being shown.
    const newer = checkedAt === null || Date.parse(next.lastFailureAt) > Date.parse(checkedAt);
    if (newer) notes.push(`the last check failed at ${next.lastFailureAt}: ${next.lastFailure}`);
  }
  return { view: { latest, checkedAt, notes }, record: next, changed: lookingUp };
}

export async function collectToolsReport(
  input: ToolsInput,
  deps: ToolsDeps,
  refresh: RefreshMode,
): Promise<ToolsReport> {
  const state = deps.readState();
  const base = { platform: input.platform, env: input.env, homeDir: input.homeDir };
  const context: ToolContext = { pin: input.pin, runtimeBinary: input.runtimeBinary };

  const results = await Promise.all(
    TOOL_IDS.map(async (id) => {
      const detection =
        id === "engram"
          ? { ...base, harilCopy: input.harilCopy, runtimeBinary: input.runtimeBinary }
          : base;
      const [installs, latest] = await Promise.all([
        detectInstalls(id, detection, deps.detect),
        resolveLatest(id, state.tools[id], refresh, deps),
      ]);
      return { id, installs, latest };
    }),
  );

  let saveFailure: string | undefined;
  if (results.some((result) => result.latest.changed)) {
    const tools: ToolsState["tools"] = { ...state.tools };
    for (const { id, latest } of results) {
      if (latest.record !== undefined) tools[id] = latest.record;
    }
    try {
      deps.writeState({ version: 1, tools });
    } catch (error) {
      saveFailure = error instanceof Error ? error.message : String(error);
    }
  }

  const statuses = results.map(({ id, installs, latest }) => {
    const status = buildToolStatus(id, installs, latest.view, context);
    const extra = [
      ...(id === "engram" ? (input.notes ?? []) : []),
      ...(latest.changed && saveFailure !== undefined
        ? [`could not save the tools state: ${saveFailure}`]
        : []),
    ];
    return extra.length === 0 ? status : { ...status, notes: [...extra, ...status.notes] };
  });
  return {
    schema: "haril.tools.status/1",
    generatedAt: new Date(deps.now()).toISOString(),
    tools: statuses,
  };
}
