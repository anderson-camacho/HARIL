import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ShellPorts, shell } from "../src/commands/shell.js";
import type { CliIo, HostInfo } from "../src/context.js";

// `haril shell` (TUI-T2): resolves the paths, refuses without a terminal and launches the shell bundle.
// The store is never opened and the runtime never started; the tests use a fixture bundle that records its argv.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-test-"));
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

function host(env: Record<string, string | undefined>): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: process.platform,
    arch: "x64",
    homeDir: root,
    env,
  };
}

// The running haril bundle, passed to the shell as --haril so its actions run the CLI (TUI-D13).
const HARIL_ENTRY = "/nonexistent-haril-bundle/haril.mjs";
const TTY: ShellPorts = {
  stdinIsTTY: true,
  stdoutIsTTY: true,
  bundleDir: "/nonexistent-haril-bundle",
  harilEntry: HARIL_ENTRY,
};

// A bundle stand-in: writes its argv beside itself and exits with 7, so exit-code propagation is observable.
function fixtureBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "shell.mjs");
  writeFileSync(
    entry,
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("./argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));',
      "process.exit(7);",
    ].join("\n"),
    "utf8",
  );
  return entry;
}

describe("haril shell", () => {
  it("refuses without a TTY on stdin with exit 2 and a clear message", async () => {
    const { io, err } = harness();
    const code = await shell([], io, host({}), { ...TTY, stdinIsTTY: false });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/interactive terminal/);
  });

  it("refuses without a TTY on stdout with exit 2", async () => {
    const { io, err } = harness();
    const code = await shell([], io, host({}), { ...TTY, stdoutIsTTY: false });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/interactive terminal/);
  });

  it("exits 1 and says to build when the shell bundle is missing", async () => {
    const { io, err } = harness();
    const code = await shell([], io, host({ HARIL_SHELL_ENTRY: join(root, "absent.mjs") }), TTY);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/not built; run npm run build/);
  });

  it("rejects an unknown option with exit 2", async () => {
    const { io, err } = harness();
    const code = await shell(["--bogus"], io, host({}), TTY);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unknown option "--bogus"/);
  });

  it("launches the bundle with the resolved paths and returns its exit code", async () => {
    const entry = fixtureBundle(join(root, "bundle"));
    const runtimeRoot = join(root, "runtime");
    const { io } = harness();
    const code = await shell(
      ["--data-dir", join(root, "data")],
      io,
      host({ HARIL_SHELL_ENTRY: entry, HARIL_RUNTIME_DIR: runtimeRoot }),
      TTY,
    );
    expect(code).toBe(7);
    const argv = JSON.parse(readFileSync(join(root, "bundle", "argv.json"), "utf8")) as string[];
    expect(argv).toEqual([
      "--data-dir",
      join(root, "data"),
      "--runtime-root",
      runtimeRoot,
      "--config",
      join(runtimeRoot, "config", "haril.json"),
      "--haril",
      HARIL_ENTRY,
    ]);
  });

  it("passes --no-runtime to the bundle only when it is given (LD-T6)", async () => {
    const entry = fixtureBundle(join(root, "bundle"));
    const env = { HARIL_SHELL_ENTRY: entry, HARIL_RUNTIME_DIR: join(root, "runtime") };
    const argvFile = join(root, "bundle", "argv.json");
    expect(await shell(["--no-runtime"], harness().io, host(env), TTY)).toBe(7);
    const without = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(without.at(-1)).toBe("--no-runtime");
    expect(without.filter((arg) => arg === "--no-runtime")).toHaveLength(1);

    expect(await shell([], harness().io, host(env), TTY)).toBe(7);
    expect(JSON.parse(readFileSync(argvFile, "utf8"))).not.toContain("--no-runtime");
  });

  it("passes HARIL_CONFIG as the config path when it is set", async () => {
    const entry = fixtureBundle(join(root, "bundle"));
    const config = join(root, "elsewhere", "haril.json");
    const { io } = harness();
    await shell(
      [],
      io,
      host({ HARIL_SHELL_ENTRY: entry, HARIL_CONFIG: config, HARIL_HOME: join(root, "h") }),
      TTY,
    );
    const argv = JSON.parse(readFileSync(join(root, "bundle", "argv.json"), "utf8")) as string[];
    expect(argv[argv.indexOf("--config") + 1]).toBe(config);
    expect(argv).toContain("--data-dir");
  });

  it("finds the bundle beside the installed haril.mjs (installed layout)", async () => {
    const appDir = join(root, "HARIL", "app", "0.1.0");
    fixtureBundle(appDir);
    const { io } = harness();
    const code = await shell([], io, host({ HARIL_RUNTIME_DIR: join(root, "HARIL") }), {
      ...TTY,
      bundleDir: appDir,
    });
    expect(code).toBe(7);
    expect(readFileSync(join(appDir, "argv.json"), "utf8")).toContain("--runtime-root");
  });

  it("finds apps/shell/dist from apps/haril/dist (repository layout)", async () => {
    const repo = join(root, "repo");
    fixtureBundle(join(repo, "apps", "shell", "dist"));
    const { io } = harness();
    const code = await shell([], io, host({ HARIL_RUNTIME_DIR: join(root, "rt") }), {
      ...TTY,
      bundleDir: join(repo, "apps", "haril", "dist"),
    });
    expect(code).toBe(7);
    expect(readFileSync(join(repo, "apps", "shell", "dist", "argv.json"), "utf8")).toContain(
      "--config",
    );
  });
});
