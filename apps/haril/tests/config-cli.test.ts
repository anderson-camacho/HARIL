import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELEGATION_FIELDS } from "@haril/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import { harness, parseJson } from "./helpers.js";

// `haril config get|set` (docs/modos-y-delegacion.md 6; phase F7) and doctor's check of the delegation section (P10).
// get shows a value or a whole group with each value's source; set validates the result like every reader of the file,
// keeps every other key and the file's indentation and line endings, and writes through a temporary file renamed over
// it. Nothing here reaches the network: doctor's provider probe is a stub.

let root: string;
let configDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-config-cli-"));
  configDir = join(root, "config");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function hostFor(configPath: string): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: root,
    cwd: root,
    env: { HARIL_HOME: join(root, "data"), HARIL_CONFIG: configPath },
    providerProbe: async () => [],
    inspectRuntime: (runtimeRoot) => ({
      status: "warn",
      root: runtimeRoot,
      manifest: join(runtimeRoot, "manifest.json"),
      detail: "not installed",
    }),
  };
}

function writeConfig(text: string): string {
  const path = join(root, "haril.json");
  writeFileSync(path, text);
  return path;
}

async function cli(args: string[], configPath: string) {
  const h = harness();
  const code = await run(args, h.io, hostFor(configPath));
  return { code, out: h.out, err: h.err };
}

describe("haril config get", () => {
  it("shows one value and its source, the default when the file does not set it", async () => {
    const path = writeConfig(JSON.stringify({ ui: { theme: "haril-dark" } }));
    const text = await cli(["config", "get", "delegation.context.compactAtTokens"], path);
    expect(text.code).toBe(0);
    expect(text.out).toEqual(["delegation.context.compactAtTokens = 300000  (default)"]);
    const json = await cli(["config", "get", "delegation.context.compactAtTokens", "--json"], path);
    expect(json.code).toBe(0);
    expect(parseJson(json.out)).toMatchObject({
      path: "delegation.context.compactAtTokens",
      value: 300_000,
      default: 300_000,
      source: "default",
      effect: "new workflows",
      kind: { type: "integer", min: 32_768, max: 10_000_000, unit: "tokens" },
      configPath: path,
    });
  });

  it("shows a whole group, every field with its value and source", async () => {
    const path = writeConfig(
      JSON.stringify({ delegation: { context: { perLayer: { orchestrator: 400_000 } } } }),
    );
    const text = await cli(["config", "get", "delegation.context"], path);
    expect(text.out).toEqual([
      "delegation.context.compactAtTokens = 300000  (default)",
      "delegation.context.perLayer.orchestrator = 400000  (haril.json)",
      "delegation.context.perLayer.delegator = 300000  (default: inherits delegation.context.compactAtTokens)",
      "delegation.context.perLayer.executor = 300000  (default: inherits delegation.context.compactAtTokens)",
      "delegation.context.perLayer.auditor = 300000  (default: inherits delegation.context.compactAtTokens)",
    ]);
    const json = parseJson<{ value: unknown; fields: { path: string }[] }>(
      (await cli(["config", "get", "delegation", "--json"], path)).out,
    );
    expect(json.fields).toHaveLength(DELEGATION_FIELDS.length);
    expect(json.value).toMatchObject({
      context: { compactAtTokens: 300_000, perLayer: { orchestrator: 400_000 } },
      limits: { maxAuditRetries: 1 },
    });
  });

  it("reads other keys of the file as they are, and refuses an unknown delegation path", async () => {
    const path = writeConfig(JSON.stringify({ ui: { theme: "haril-dark" } }));
    expect((await cli(["config", "get", "ui.theme"], path)).out).toEqual([
      'ui.theme = "haril-dark"  (haril.json)',
    ]);
    const unknown = await cli(["config", "get", "delegation.limits.maxChildren"], path);
    expect(unknown.code).toBe(2);
    expect(unknown.err.join("\n")).toContain("unknown setting delegation.limits.maxChildren");
  });

  it("reports the file's problems instead of values when the section is invalid", async () => {
    const path = writeConfig(JSON.stringify({ delegation: { limits: { maxAuditRetries: 5 } } }));
    const got = await cli(["config", "get", "delegation"], path);
    expect(got.code).toBe(2);
    expect(got.err.join("\n")).toContain("/delegation/limits/maxAuditRetries");
  });
});

describe("haril config set", () => {
  const original = [
    "{",
    '    "providers": [',
    '        { "id": "cliproxy", "baseUrl": "http://127.0.0.1:8317/v1", "keyEnv": "HARIL_CLIPROXYAPI_KEY" }',
    "    ],",
    '    "ui": { "theme": "haril-dark" },',
    '    "delegation": { "quota": { "managementKeyEnv": "TEST_MGMT_KEY" } }',
    "}",
    "",
  ].join("\r\n");

  it("keeps every other key, the indentation and the line endings, and leaves no temporary file", async () => {
    const path = writeConfig(original);
    const set = await cli(
      ["config", "set", "delegation.limits.maxActiveChildren.orchestrator", "3"],
      path,
    );
    expect(set.code).toBe(0);
    expect(set.out.join("\n")).toContain(
      "delegation.limits.maxActiveChildren.orchestrator: 5 (default) -> 3 (haril.json)",
    );
    const written = readFileSync(path, "utf8");
    expect(JSON.parse(written)).toEqual({
      providers: [
        { id: "cliproxy", baseUrl: "http://127.0.0.1:8317/v1", keyEnv: "HARIL_CLIPROXYAPI_KEY" },
      ],
      ui: { theme: "haril-dark" },
      delegation: {
        quota: { managementKeyEnv: "TEST_MGMT_KEY" },
        limits: { maxActiveChildren: { orchestrator: 3 } },
      },
    });
    expect(written).toContain('\r\n    "ui": {\r\n        "theme": "haril-dark"');
    expect(written.endsWith("}\r\n")).toBe(true);
    expect(written.replace(/\r\n/g, "")).not.toContain("\n");
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a value its field does not accept and leaves the file as it was", async () => {
    const path = writeConfig(original);
    for (const [setting, value] of [
      ["delegation.limits.maxAuditRetries", "2"],
      ["delegation.limits.maxEscalationsPerTask", "3"],
      ["delegation.context.compactAtTokens", "300k"],
      ["delegation.models.layers.executor.level", "ultra"],
    ] as const) {
      const refused = await cli(["config", "set", setting, value], path);
      expect([setting, refused.code]).toEqual([setting, 2]);
      expect(refused.err.join("\n")).toContain(`/${setting.split(".").join("/")}`);
    }
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("sets only delegation settings it knows", async () => {
    const path = writeConfig(original);
    const other = await cli(["config", "set", "ui.theme", "haril-light"], path);
    expect(other.code).toBe(2);
    expect(other.err.join("\n")).toContain("only delegation settings can be set");
    const unknown = await cli(["config", "set", "delegation.quota.managementKey", "x"], path);
    expect(unknown.code).toBe(2);
    expect(unknown.err.join("\n")).toContain("unknown setting delegation.quota.managementKey");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("never writes a file that holds a key, even when the change itself is valid", async () => {
    const path = writeConfig(JSON.stringify({ apiKey: "sk-not-a-real-value" }));
    const refused = await cli(["config", "set", "delegation.limits.maxAuditRetries", "0"], path);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain("/apiKey: keys are never stored in haril.json");
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ apiKey: "sk-not-a-real-value" }));
  });

  it("reads lists, levels, models and null, and --json says what changed", async () => {
    const path = writeConfig("{}");
    const runs: [string, string][] = [
      ["delegation.autonomy.defaultStops", "after_plan, at_end"],
      ["delegation.models.allow.executor", '["cliproxy/a","cliproxy/b"]'],
      ["delegation.models.layers.executor.model", "cliproxy/Gemini1/gemini-3-flash"],
      ["delegation.models.layers.executor.level", "high"],
      ["delegation.models.auditorDistinctFromExecutor", "false"],
      ["delegation.quota.switchAtPercent5h", "72.5"],
      ["delegation.limits.maxWorkflowTokens", "5_000_000"],
    ];
    for (const [setting, value] of runs) {
      const set = await cli(["config", "set", setting, value], path);
      expect([setting, set.code, set.err]).toEqual([setting, 0, []]);
    }
    const json = await cli(
      ["config", "set", "delegation.models.layers.executor.model", "null", "--json"],
      path,
    );
    expect(parseJson(json.out)).toMatchObject({
      path: "delegation.models.layers.executor.model",
      previous: { value: "cliproxy/Gemini1/gemini-3-flash", source: "file" },
      value: null,
      source: "file",
      written: true,
      effect: "next model choice",
      configPath: path,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      delegation: {
        autonomy: { defaultStops: ["after_plan", "at_end"] },
        models: {
          allow: { executor: ["cliproxy/a", "cliproxy/b"] },
          layers: { executor: { model: null, level: "high" } },
          auditorDistinctFromExecutor: false,
        },
        quota: { switchAtPercent5h: 72.5 },
        limits: { maxWorkflowTokens: 5_000_000 },
      },
    });
  });

  it("--reset takes a value back to its default and drops the groups it empties", async () => {
    const path = writeConfig(
      JSON.stringify({
        ui: { theme: "x" },
        delegation: { context: { perLayer: { executor: 400_000 } } },
      }),
    );
    const reset = await cli(
      ["config", "set", "delegation.context.perLayer.executor", "--reset"],
      path,
    );
    expect(reset.code).toBe(0);
    expect(reset.out.join("\n")).toContain(
      "delegation.context.perLayer.executor: 400000 (haril.json) -> 300000 (default)",
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ui: { theme: "x" } });
  });

  it("creates the file when it does not exist yet", async () => {
    const path = join(configDir, "haril.json");
    expect(existsSync(path)).toBe(false);
    const set = await cli(
      ["config", "set", "delegation.context.perLayer.orchestrator", "400000"],
      path,
    );
    expect(set.code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify({ delegation: { context: { perLayer: { orchestrator: 400_000 } } } }, null, 2)}\n`,
    );
    const got = await cli(["config", "get", "delegation.context.perLayer.orchestrator"], path);
    expect(got.out).toEqual(["delegation.context.perLayer.orchestrator = 400000  (haril.json)"]);
  });
});

describe("haril doctor and the delegation section (P10)", () => {
  it("reports the section ok, from the file or the defaults", async () => {
    const path = writeConfig(JSON.stringify({ delegation: { limits: { maxAuditRetries: 0 } } }));
    const text = await cli(["doctor"], path);
    expect(text.out.join("\n")).toMatch(/delegation\s+ok\s+file\s+/);
    const json = parseJson<{ delegation: unknown }>((await cli(["doctor", "--json"], path)).out);
    expect(json.delegation).toEqual({ status: "ok", source: "file", path });
  });

  it("reports every problem of the section with its path and fails", async () => {
    const path = writeConfig(
      JSON.stringify({ delegation: { limits: { maxAuditRetries: 2 }, nope: 1 } }),
    );
    const text = await cli(["doctor"], path);
    expect(text.code).toBe(2);
    expect(text.out.join("\n")).toMatch(/delegation\s+error\s+/);
    expect(text.out.join("\n")).toContain("/delegation/nope: unknown key");
    const json = parseJson<{ status: string; delegation: { status: string; errors: string[] } }>(
      (await cli(["doctor", "--json"], path)).out,
    );
    expect(json.status).toBe("error");
    expect(json.delegation.status).toBe("error");
    expect(json.delegation.errors).toContain("/delegation/nope: unknown key");
  });
});
