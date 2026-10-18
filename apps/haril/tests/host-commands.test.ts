import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allowedCommand,
  cleanEnvironment,
  DEFAULT_COMMAND_ALLOW,
  resolveProgram,
  runHostCommand,
} from "../src/runtime/host-commands.js";

// haril_run (docs/modos-y-delegacion.md 3.10.5 and section 8; phase F8): a command of the allow list, run by the host
// in the agent's worktree as argv (never a shell), with a clean environment that carries no key, a time limit and an
// output limit, its result returned as data. N0: no sandbox; an allowed command runs project code with the user's rights.

let dir: string;
let script: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "haril-host-cmd-"));
  script = join(dir, "probe.mjs");
  writeFileSync(
    script,
    [
      "const [mode, ...rest] = process.argv.slice(2);",
      'if (mode === "argv") console.log(JSON.stringify(rest));',
      'if (mode === "env") console.log(JSON.stringify({ secret: process.env.SECRET_TOKEN ?? "absent", key: process.env.HARIL_CLIPROXYAPI_KEY ?? "absent", ci: process.env.CI }));',
      'if (mode === "cwd") console.log(process.cwd());',
      'if (mode === "sleep") setTimeout(() => console.log("woke"), 10000);',
      'if (mode === "flood") { process.stdout.write("x".repeat(100000)); process.stdout.write("END"); }',
      'if (mode === "fail") { console.error("boom"); process.exit(3); }',
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const parentEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  SECRET_TOKEN: "fixture-not-a-real-token",
  HARIL_CLIPROXYAPI_KEY: "fixture-not-a-real-key",
});

const settings = (change: Partial<{ timeoutMs: number; outputMaxBytes: number }> = {}) => ({
  allow: ["node probe.mjs *"],
  timeoutMs: 20_000,
  outputMaxBytes: 16_384,
  ...change,
});

describe("allowedCommand", () => {
  it("matches an entry exactly, or as a prefix when it ends with *", () => {
    expect(allowedCommand(["npm test"], "npm", ["test"])).toBe(true);
    expect(allowedCommand(["npm test"], "npm", ["test", "--watch"])).toBe(false);
    expect(allowedCommand(["npm test *"], "npm", ["test", "--", "-t", "button"])).toBe(true);
    expect(allowedCommand(["npm test"], "npm", ["run", "evil"])).toBe(false);
    expect(allowedCommand(["npm run build"], "npm", ["run"])).toBe(false);
    expect(allowedCommand([], "npm", ["test"])).toBe(false);
  });

  it("refuses a command given as a path, whatever the list says", () => {
    expect(allowedCommand(["node --test"], "./node", ["--test"])).toBe(false);
    expect(allowedCommand(["node --test"], "C:\\tools\\node", ["--test"])).toBe(false);
    expect(allowedCommand(["node --test"], "/usr/bin/node", ["--test"])).toBe(false);
  });

  it("has a default list for the usual test and build commands, with no shell and no eval", () => {
    expect(DEFAULT_COMMAND_ALLOW).toEqual(
      expect.arrayContaining(["npm test", "pnpm test", "npm run build", "node --test"]),
    );
    expect(
      DEFAULT_COMMAND_ALLOW.some((entry) => /^(sh|bash|cmd|powershell|pwsh)\b/.test(entry)),
    ).toBe(false);
    expect(allowedCommand(DEFAULT_COMMAND_ALLOW, "node", ["-e", "process.exit(0)"])).toBe(false);
  });
});

describe("cleanEnvironment", () => {
  it("keeps the variables a program needs to start and drops everything else, keys first", () => {
    const env = cleanEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/me",
        OPENAI_API_KEY: "fixture-not-a-real-key",
        GITHUB_TOKEN: "fixture-not-a-real-token",
        HARIL_CLIPROXYAPI_KEY: "fixture-not-a-real-key",
        AWS_SECRET_ACCESS_KEY: "fixture",
        SOMETHING_ELSE: "x",
      },
      "linux",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me");
    expect(env.CI).toBe("true");
    for (const name of [
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "HARIL_CLIPROXYAPI_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "SOMETHING_ELSE",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it("keeps the Windows names whatever their case", () => {
    const env = cleanEnvironment(
      { Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "cmd" },
      "win32",
    );
    expect(env.Path ?? env.PATH).toBe("C:\\Windows");
    expect(env.SystemRoot).toBe("C:\\Windows");
  });
});

describe("resolveProgram", () => {
  const files = new Set([
    "C:\\nodejs\\node.exe",
    "C:\\nodejs\\npm.cmd",
    "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    "C:\\nodejs\\pnpm.cmd",
    "C:\\nodejs\\node_modules\\corepack\\dist\\pnpm.js",
    "C:\\tools\\git.exe",
    "C:\\tools\\custom.cmd",
    "C:\\global\\vitest.cmd",
    "C:\\global\\node_modules\\vitest\\vitest.mjs",
  ]);
  const fs = {
    exists: (path: string) => files.has(path),
    readText: (path: string) =>
      path === "C:\\global\\vitest.cmd"
        ? '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\vitest\\vitest.mjs" %*\r\n'
        : undefined,
  };
  const env = { PATH: "C:\\nodejs;C:\\tools;C:\\global", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("runs an executable found on PATH directly", () => {
    expect(resolveProgram("git", env, "win32", fs)).toEqual({
      ok: true,
      file: "C:\\tools\\git.exe",
      prefix: [],
    });
  });

  it("runs npm and pnpm through node and their script, never through cmd.exe", () => {
    expect(resolveProgram("npm", env, "win32", fs)).toEqual({
      ok: true,
      file: "C:\\nodejs\\node.exe",
      prefix: ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    });
    expect(resolveProgram("pnpm", env, "win32", fs)).toEqual({
      ok: true,
      file: "C:\\nodejs\\node.exe",
      prefix: ["C:\\nodejs\\node_modules\\corepack\\dist\\pnpm.js"],
    });
  });

  it("runs a node package's command shim through node and the script it names", () => {
    expect(resolveProgram("vitest", env, "win32", fs)).toEqual({
      ok: true,
      file: "C:\\nodejs\\node.exe",
      prefix: ["C:\\global\\node_modules\\vitest\\vitest.mjs"],
    });
  });

  it("refuses any other batch file and a program not on PATH", () => {
    expect(resolveProgram("custom", env, "win32", fs)).toMatchObject({ ok: false });
    expect(resolveProgram("nope", env, "win32", fs)).toMatchObject({ ok: false });
  });
});

describe("runHostCommand", () => {
  const nodeDir = dirname(process.execPath);
  const run = (args: string[], change: Parameters<typeof settings>[0] = {}) =>
    runHostCommand({
      command: "node",
      args: ["probe.mjs", ...args],
      cwd: dir,
      settings: settings(change),
      env: {
        ...parentEnv(),
        PATH: `${nodeDir}${process.platform === "win32" ? ";" : ":"}${parentEnv().PATH ?? ""}`,
      },
    });

  it("passes every argument as it is: no shell ever reads it", async () => {
    const result = await run(["argv", "a b", "&& echo hacked", "$(whoami)", "| more"]);
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    if (!result.ok) return;
    expect(JSON.parse(result.stdout.trim())).toEqual([
      "a b",
      "&& echo hacked",
      "$(whoami)",
      "| more",
    ]);
    expect(result.stdout).not.toMatch(/^hacked/m);
  });

  it("starts the command in the worktree with a clean environment that holds no key", async () => {
    const env = await run(["env"]);
    expect(env.ok && JSON.parse(env.stdout.trim())).toEqual({
      secret: "absent",
      key: "absent",
      ci: "true",
    });
    const cwd = await run(["cwd"]);
    expect(cwd.ok && cwd.stdout.trim().toLowerCase()).toBe(dir.toLowerCase());
  });

  it("answers a failing command with its exit code and output, as data", async () => {
    const result = await run(["fail"]);
    expect(result).toMatchObject({ ok: true, exitCode: 3, timedOut: false });
    expect(result.ok && result.stderr).toContain("boom");
  });

  it("ends a command at its time limit", async () => {
    const started = Date.now();
    const result = await run(["sleep"], { timeoutMs: 400 });
    expect(result).toMatchObject({ ok: true, timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("keeps only the end of a long output and says it was cut", async () => {
    const result = await run(["flood"], { outputMaxBytes: 1_000 });
    expect(result).toMatchObject({ ok: true, exitCode: 0, truncated: true });
    if (!result.ok) return;
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stdout.endsWith("END")).toBe(true);
  });

  it("refuses a command outside the allow list and says what is allowed", async () => {
    const result = await runHostCommand({
      command: "node",
      args: ["-e", "1"],
      cwd: dir,
      settings: settings(),
      env: parentEnv(),
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("node probe.mjs *");
  });
});
