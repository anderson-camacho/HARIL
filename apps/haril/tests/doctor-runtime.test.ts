import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, type HostInfo, run } from "../src/cli.js";

// doctor's runtime section: reads <runtime root>/runtime/manifest.json and checks that the files exist.
// It never executes them, and it does not change the overall exit code (the runtime is optional in M2).
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-doctor-rt-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: () => {
      throw new Error("not used");
    },
  };
  return { io, out, err };
}

const HEALTHY_STORE = {
  dataDir: "/tmp/data",
  dbPath: "/tmp/data/haril.db",
  initialized: false,
  sqliteVersion: "3.53.3",
  schemaVersion: null,
  gates: [{ name: "sqlite", status: "ok", detail: "SQLite 3.53.3" }],
} as const;

function host(env: Record<string, string | undefined>): HostInfo {
  return {
    nodeVersion: "v24.22.0",
    platform: "linux",
    arch: "x64",
    homeDir: "/home/tester",
    env: { HARIL_GATEWAY_URL: "http://127.0.0.1:1/v1", ...env },
    inspectStore: () => HEALTHY_STORE,
    gatewayProbe: async () => ({ status: "warn", detail: "unreachable" }),
  };
}

describe("doctor runtime section", () => {
  it("warns 'not installed' when no manifest exists, and leaves the exit code alone", async () => {
    const { io, out } = harness();
    const code = await run(["doctor"], io, host({ HARIL_RUNTIME_DIR: root }));
    expect(out.join("\n")).toContain(`runtime   warn  ${root}`);
    expect(out.join("\n")).toContain("not installed: run npm run runtime:install");
    expect(code).toBe(1); // only the gateway warning above; the runtime does not add to it
  });

  it("reports the Node and Pi versions and paths when the manifest and its files exist", async () => {
    const nodePath = join(root, "node.exe");
    const cliPath = join(root, "cli.js");
    writeFileSync(nodePath, "");
    writeFileSync(cliPath, "");
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(
      join(root, "runtime", "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        node: { version: "24.22.0", path: nodePath, sha256: "c".repeat(64) },
        pi: { version: "1.2.0", cliPath },
        installedAt: "2026-10-16T00:00:00.000Z",
      }),
    );
    const { io, out } = harness();
    await run(["doctor"], io, host({ HARIL_RUNTIME_DIR: root }));
    const text = out.join("\n");
    expect(text).toMatch(/runtime\s+ok\s+/);
    expect(text).toContain(`node      24.22.0  ${nodePath}`);
    expect(text).toContain(`pi        1.2.0  ${cliPath}`);
  });

  it("warns when the manifest points at files that are missing", async () => {
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(
      join(root, "runtime", "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        node: { version: "24.22.0", path: join(root, "gone.exe"), sha256: null },
        pi: { version: "1.2.0", cliPath: join(root, "gone.js") },
        installedAt: "2026-10-16T00:00:00.000Z",
      }),
    );
    const { io, out } = harness();
    await run(["doctor"], io, host({ HARIL_RUNTIME_DIR: root }));
    expect(out.join("\n")).toMatch(/runtime\s+warn\s+/);
    expect(out.join("\n")).toContain("files missing");
  });

  it("prints the runtime in the JSON report", async () => {
    const { io, out } = harness();
    await run(["doctor", "--json"], io, host({ HARIL_RUNTIME_DIR: root }));
    const report = JSON.parse(out.join("\n")) as {
      runtime: { status: string; root: string; manifest: string };
    };
    expect(report.runtime.status).toBe("warn");
    expect(report.runtime.root).toBe(root);
    expect(report.runtime.manifest).toMatch(/runtime[\\/]manifest\.json$/);
  });
});
