import type { StoreInspection } from "@haril/state-sqlite";
import { describe, expect, it } from "vitest";
import { type CliIo, type HostInfo, run } from "../src/cli.js";
import type { ProviderListing } from "../src/providers.js";
import { VERSION } from "../src/version.js";

// Store inspection is faked here; the real filesystem path is covered by doctor-store.test.ts.
const HEALTHY_STORE = {
  dataDir: "/home/tester/.local/share/haril",
  dbPath: "/home/tester/.local/share/haril/haril.db",
  initialized: false,
  sqliteVersion: "3.53.3",
  schemaVersion: null,
  gates: [{ name: "sqlite", status: "ok", detail: "SQLite 3.53.3" }],
} as const;

// The gateway probe is faked here so these tests never reach a real gateway (doctor-gateway.test.ts covers it).
const PROVIDERS_OK: ProviderListing[] = [
  {
    id: "cliproxy",
    url: "http://127.0.0.1:8317/v1",
    key: "set",
    status: "ok",
    detail: "reachable, 2 models",
    models: [
      { providerId: "cliproxy", id: "a" },
      { providerId: "cliproxy", id: "b" },
    ],
  },
];

// The runtime is faked too: doctor-runtime.test.ts covers the real manifest reader.
const RUNTIME_MISSING = {
  status: "warn",
  root: "/home/tester/.local/share/haril",
  manifest: "/home/tester/.local/share/haril/runtime/manifest.json",
  detail: "not installed: run npm run runtime:install",
} as const;

const HOST: HostInfo = {
  nodeVersion: "v24.21.0",
  platform: "linux",
  arch: "x64",
  homeDir: "/home/tester",
  env: {},
  inspectStore: () => HEALTHY_STORE,
  providerProbe: async () => PROVIDERS_OK,
  inspectRuntime: () => RUNTIME_MISSING,
};

// Fake io: captures every line and serves files from an in-memory map.
function harness(files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return content;
    },
  };
  return { io, out, err };
}

function planTask(localId: string, dependsOn: string[] = [], kind = "work") {
  return {
    localId,
    dependsOn,
    goal: `Goal of ${localId}`,
    description: "",
    priority: 0,
    kind,
    agent: "developer-block",
    requires: [],
    context: [],
    surface: { write: [], read: [] },
    budget: { maxCostMicros: 0, maxTokens: 1000, maxWallMs: 60000 },
    timeoutMs: 60000,
    maxAttempts: 1,
    acceptance: [],
  };
}

const planJson = (tasks: ReturnType<typeof planTask>[]) =>
  JSON.stringify({ schemaVersion: 1, tasks });

const VALID_PLAN = planJson([planTask("a"), planTask("b", ["a"])]);
const CYCLE_PLAN = planJson([planTask("a", ["b"]), planTask("b", ["a"])]);

describe("version and help", () => {
  it("--version prints the package version and exits 0", () => {
    const { io, out, err } = harness();
    expect(run(["--version"], io, HOST)).toBe(0);
    expect(out).toEqual([`haril ${VERSION}`]);
    expect(err).toEqual([]);
  });

  it("the version command prints the same line", () => {
    const { io, out } = harness();
    expect(run(["version"], io, HOST)).toBe(0);
    expect(out).toEqual([`haril ${VERSION}`]);
  });

  it("help lists every command and exits 0", () => {
    const { io, out } = harness();
    expect(run(["help"], io, HOST)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("doctor");
    expect(text).toContain("states");
    expect(text).toContain("plan validate");
    expect(text).toContain("project init");
    expect(text).toContain("task add");
    expect(text).toContain("plan import");
    expect(text).toContain("status");
  });

  it("--help is the same as help", () => {
    const { io, out } = harness();
    expect(run(["--help"], io, HOST)).toBe(0);
    expect(out.join("\n")).toContain("plan validate");
  });

  it("no arguments outside a terminal prints help to stderr and exits 2", () => {
    const { io, out, err } = harness();
    expect(run([], io, HOST)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("doctor");
  });

  it("no arguments in a terminal opens the console, the same as haril console", async () => {
    const { io, err } = harness();
    // The host says it is a terminal, so the bare command goes to `haril console`. Under the test runner the real
    // stdin is not a TTY, so the console itself refuses: its own message proves the dispatch, and no help is printed.
    expect(await run([], io, { ...HOST, interactive: true })).toBe(2);
    expect(err.join("\n")).toContain("the console needs an interactive terminal");
    expect(err.join("\n")).not.toContain("doctor");
  });

  it("an unknown command prints an error and help to stderr and exits 2", () => {
    const { io, out, err } = harness();
    expect(run(["bogus"], io, HOST)).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toContain("unknown command");
    expect(err.join("\n")).toContain("doctor");
  });
});

describe("doctor", async () => {
  const doctorJson = async (nodeVersion: string) => {
    const { io, out } = harness();
    const code = await run(["doctor", "--json"], io, { ...HOST, nodeVersion });
    return { code, report: JSON.parse(out.join("\n")) as { status: string } };
  };

  it.each(["v24.21.0", "v24.22.1", "v26.8.0", "v27.0.0"])(
    "reports ok on %s, which satisfies ^24.21.0 || >=26.8.0",
    async (nodeVersion) => {
      const { code, report } = await doctorJson(nodeVersion);
      expect(code).toBe(0);
      expect(report.status).toBe("ok");
    },
  );

  it("reports warn on v24.19.0 and exits 1 (M1-D2: warnings, the kept 24.x deviation)", async () => {
    const { code, report } = await doctorJson("v24.19.0");
    expect(code).toBe(1);
    expect(report.status).toBe("warn");
  });

  it.each(["v22.12.0", "v25.1.0", "v26.7.9"])(
    "reports error on %s and exits 2 (M1-D2: errors; INV-19)",
    async (nodeVersion) => {
      const { code, report } = await doctorJson(nodeVersion);
      expect(code).toBe(2);
      expect(report.status).toBe("error");
    },
  );

  it("prints node, platform and arch in text form", async () => {
    const { io, out } = harness();
    expect(await run(["doctor"], io, { ...HOST, nodeVersion: "v24.19.0", platform: "win32" })).toBe(
      1,
    );
    const text = out.join("\n");
    expect(text).toContain("v24.19.0");
    expect(text).toContain("win32");
    expect(text).toContain("x64");
    expect(text).toContain("warn");
  });

  it("prints a JSON report with node, platform, arch, store and status", async () => {
    const { io, out } = harness();
    await run(["doctor", "--json"], io, { ...HOST, nodeVersion: "v24.19.0", platform: "win32" });
    expect(JSON.parse(out.join("\n"))).toEqual({
      status: "warn",
      node: {
        version: "v24.19.0",
        required: "^24.21.0 || >=26.8.0",
        status: "warn",
      },
      platform: "win32",
      arch: "x64",
      store: {
        status: "ok",
        dataDir: HEALTHY_STORE.dataDir,
        dbPath: HEALTHY_STORE.dbPath,
        initialized: false,
        sqliteVersion: "3.53.3",
        schemaVersion: null,
        gates: HEALTHY_STORE.gates,
      },
      providers: expect.objectContaining({
        status: "ok",
        entries: [expect.objectContaining({ id: "cliproxy", key: "set", status: "ok", models: 2 })],
      }),
      runtime: RUNTIME_MISSING,
    });
  });

  it("rejects an unknown flag with exit 2", async () => {
    const { io, err } = harness();
    expect(await run(["doctor", "--verbose"], io, HOST)).toBe(2);
    expect(err.join("\n")).toContain("--verbose");
  });
});

describe("states", () => {
  it("prints the seven task states and the legal transitions and exits 0", () => {
    const { io, out } = harness();
    expect(run(["states"], io, HOST)).toBe(0);
    const text = out.join("\n");
    for (const state of [
      "pending",
      "ready",
      "running",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(text).toContain(state);
    }
    expect(out.some((line) => line.includes("failed -> ready"))).toBe(true);
    expect(out.some((line) => line.includes("completed -> (terminal)"))).toBe(true);
  });
});

describe("plan validate", () => {
  it("prints OK with the task count and topological order for a valid plan", () => {
    const { io, out, err } = harness({ "plan.json": VALID_PLAN });
    expect(run(["plan", "validate", "plan.json"], io, HOST)).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain("OK");
    expect(text).toContain("2 tasks");
    expect(text).toContain("order: a, b");
  });

  it("prints a JSON result for a valid plan with --json", () => {
    const { io, out } = harness({ "plan.json": VALID_PLAN });
    expect(run(["plan", "validate", "plan.json", "--json"], io, HOST)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ ok: true, taskCount: 2, order: ["a", "b"] });
  });

  it("reports a cycle with its path and exits 1", () => {
    const { io, out } = harness({ "cycle.json": CYCLE_PLAN });
    expect(run(["plan", "validate", "cycle.json"], io, HOST)).toBe(1);
    expect(out.join("\n")).toContain("dependency cycle: a -> b -> a");
  });

  it("reports the cycle code in JSON form and exits 1", () => {
    const { io, out } = harness({ "cycle.json": CYCLE_PLAN });
    expect(run(["plan", "validate", "cycle.json", "--json"], io, HOST)).toBe(1);
    const result = JSON.parse(out.join("\n")) as { ok: boolean; issues: { code: string }[] };
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(["cycle"]);
  });

  it("reports schema errors as '<path>: <message>' and exits 1", () => {
    const badKind = planJson([planTask("a", [], "dance")]);
    const { io, out } = harness({ "bad.json": badKind });
    expect(run(["plan", "validate", "bad.json"], io, HOST)).toBe(1);
    expect(out.some((line) => line.includes("/tasks/0/kind"))).toBe(true);
  });

  it("treats a non-object JSON document as a schema error and exits 1", () => {
    const { io } = harness({ "null.json": "null" });
    expect(run(["plan", "validate", "null.json"], io, HOST)).toBe(1);
  });

  it("exits 2 when the file cannot be read", () => {
    const { io, err } = harness();
    expect(run(["plan", "validate", "missing.json"], io, HOST)).toBe(2);
    expect(err.join("\n")).toContain("missing.json");
  });

  it("exits 2 when the file is not valid JSON", () => {
    const { io, err } = harness({ "broken.json": "{ not json" });
    expect(run(["plan", "validate", "broken.json"], io, HOST)).toBe(2);
    expect(err.join("\n").toLowerCase()).toContain("json");
  });

  it("exits 2 with usage when the file argument is missing", () => {
    const { io, err } = harness();
    expect(run(["plan", "validate"], io, HOST)).toBe(2);
    expect(err.join("\n")).toContain("usage");
  });

  it("exits 2 for a plan subcommand that does not exist", () => {
    const { io, err } = harness();
    expect(run(["plan"], io, HOST)).toBe(2);
    expect(run(["plan", "lint", "x.json"], io, HOST)).toBe(2);
    expect(err.length).toBeGreaterThan(0);
  });

  it("exits 2 for an unknown flag", () => {
    const { io, err } = harness({ "plan.json": VALID_PLAN });
    expect(run(["plan", "validate", "plan.json", "--strict"], io, HOST)).toBe(2);
    expect(err.join("\n")).toContain("--strict");
  });
});

describe("doctor store section", async () => {
  it("prints the data directory and says the store is not initialized, exit 0", async () => {
    const { io, out } = harness();
    expect(await run(["doctor"], io, HOST)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(HEALTHY_STORE.dataDir);
    expect(text).toContain("not initialized");
    expect(text).toContain("3.53.3");
  });

  it("reports the schema version of an initialized store", async () => {
    const { io, out } = harness();
    const inspectStore = () => ({ ...HEALTHY_STORE, initialized: true, schemaVersion: 1 });
    expect(await run(["doctor"], io, { ...HOST, inspectStore })).toBe(0);
    expect(out.join("\n")).toContain("schema 1");
  });

  it("a SQLite gate error makes doctor exit 2 with the remedy in the text", async () => {
    const { io, out } = harness();
    const inspectStore = (): StoreInspection => ({
      ...HEALTHY_STORE,
      sqliteVersion: "3.50.7",
      gates: [
        {
          name: "sqlite",
          status: "error",
          detail: "SQLite 3.50.7 is older than 3.51.3. Remedy: use a newer Node.",
        },
      ],
    });
    expect(await run(["doctor"], io, { ...HOST, inspectStore })).toBe(2);
    expect(out.join("\n")).toContain("Remedy");
  });

  it("accepts --data-dir and passes it to the store inspection", async () => {
    const { io } = harness();
    const seen: string[] = [];
    const inspectStore = (dataDir: string) => {
      seen.push(dataDir);
      return HEALTHY_STORE;
    };
    expect(await run(["doctor", "--data-dir", "/tmp/custom"], io, { ...HOST, inspectStore })).toBe(
      0,
    );
    expect(await run(["doctor", "--data-dir=/tmp/other"], io, { ...HOST, inspectStore })).toBe(0);
    expect(seen).toEqual(["/tmp/custom", "/tmp/other"]);
  });

  it("exits 2 with usage when --data-dir has no value", async () => {
    const { io, err } = harness();
    expect(await run(["doctor", "--data-dir"], io, HOST)).toBe(2);
    expect(err.join("\n")).toContain("--data-dir");
  });
});
