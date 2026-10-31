// The JSON that `haril tools status --json` and `haril memory status --json` print, built for the TOOLS tab's tests.

export const COPY = "D:\\HARIL\\engram\\3.6.0\\engram.exe";
export const GO_ENGRAM = "C:\\Users\\ana\\go\\bin\\engram.exe";
export const GO_GENTLE = "C:\\Users\\ana\\go\\bin\\gentle-ai.exe";

export interface InstallJson {
  path: string;
  origin: string;
  origins: string[];
  version: string | null;
  versionError: string | null;
  active: boolean;
}

export function install(
  path: string,
  version: string | null,
  origins: string[],
  active = true,
): InstallJson {
  return {
    path,
    origin: origins[0] ?? "path",
    origins,
    version,
    versionError: version === null ? "timed out" : null,
    active,
  };
}

export interface ToolJson {
  id: string;
  state: string;
  active: InstallJson | null;
  installs: InstallJson[];
  latest: string | null;
  latestCheckedAt: string | null;
  qualified: string | null;
  newerUpstream: boolean;
  notes: string[];
}

export function engram(over: Partial<ToolJson> = {}): ToolJson {
  const active = install(COPY, "3.6.0", ["haril"]);
  return {
    id: "engram",
    state: "ok",
    active,
    installs: [active],
    latest: "3.6.0",
    latestCheckedAt: "2026-10-30T12:00:00.000Z",
    qualified: "3.6.0",
    newerUpstream: false,
    notes: [],
    ...over,
  };
}

export function gentle(over: Partial<ToolJson> = {}): ToolJson {
  const active = install(GO_GENTLE, "4.3.1", ["path", "go-bin"]);
  return {
    id: "gentle-ai",
    state: "ok",
    active,
    installs: [active],
    latest: "4.3.1",
    latestCheckedAt: "2026-10-30T12:00:00.000Z",
    qualified: null,
    newerUpstream: false,
    notes: [],
    ...over,
  };
}

export const statusJson = (tools: ToolJson[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: "haril.tools.status/1",
    generatedAt: "2026-10-30T12:00:00.000Z",
    tools,
    ...extra,
  });

export const memoryJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    initialized: true,
    dataDir: "D:\\HARIL\\data",
    runtime: "running",
    provider: "engram",
    providerSource: "recorded",
    persistent: true,
    health: "active",
    degraded: false,
    lastState: "active",
    lastStateAt: 1_700_000_000_000,
    lastError: null,
    outbox: { pending: 0, sending: 0, needsReview: 0, dead: 0, delivered: 3, depth: 0 },
    ...over,
  });

// The document `haril tools ensure --json` prints: what happened to Engram, and the status after it.
export const ensureJson = (
  result: Record<string, unknown>,
  tools: ToolJson[] = [engram(), gentle()],
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    schema: "haril.tools.ensure/1",
    engram: result,
    status: JSON.parse(statusJson(tools, extra)),
  });

// The document `haril tools update gentle-ai --json` prints.
export const updateJson = (
  result: Record<string, unknown>,
  tools: ToolJson[] = [engram(), gentle()],
): string =>
  JSON.stringify({
    schema: "haril.tools.update/1",
    gentleAi: { warnings: [], ...result },
    status: JSON.parse(statusJson(tools)),
  });

// What `haril tools update gentle-ai --json` prints on stderr, exiting 2, when it has no terminal to ask on and no --yes:
// the plan, and the reason nothing ran.
export const PLAN_STDERR = [
  "gentle-ai: 4.0.0 -> 4.3.1",
  "  go          go1.27.0",
  "  command     go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@v4.3.1",
  `  installs to ${GO_GENTLE}`,
  "  note        builds gentle-ai from source (a few minutes the first time); Go checks the module against its checksum database",
  "haril: confirmation required: there is no terminal to ask on; run this in a terminal, or pass --yes to go ahead without asking",
  "",
].join("\n");
