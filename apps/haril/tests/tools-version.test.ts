import { describe, expect, it } from "vitest";
import { runCapped } from "../src/tools/system.js";
import { parseToolVersion, readInstallVersion } from "../src/tools/version.js";
import { compareVersions, versionParts } from "../src/version-compare.js";

describe("shared version comparison", () => {
  it("parses only strict x.y.z versions", () => {
    expect(versionParts("3.6.0")).toEqual([3, 6, 0]);
    expect(versionParts("v3.6.0")).toBeNull();
    expect(versionParts("3.6")).toBeNull();
    expect(versionParts("3.6.0-rc.1")).toBeNull();
    expect(versionParts(undefined)).toBeNull();
  });

  it("orders versions numerically, not as text", () => {
    expect(compareVersions("3.10.0", "3.9.9")).toBeGreaterThan(0);
    expect(compareVersions("3.3.2", "3.6.0")).toBeLessThan(0);
    expect(compareVersions("4.0.0", "4.0.0")).toBe(0);
  });

  it("throws on an invalid version, as haril update expects", () => {
    expect(() => compareVersions("latest", "1.0.0")).toThrow("invalid version");
  });
});

describe("parsing a tool's version output", () => {
  it.each([
    // The real outputs of `engram version` and `gentle-ai version` observed on this machine.
    ["engram 3.3.2\n", "engram", "3.3.2"],
    ["gentle-ai 4.0.0\n", "gentle-ai", "4.0.0"],
    ["Engram v3.6.0\r\n", "engram", "3.6.0"],
    ["engram version 3.6.0 (commit abc123)", "engram", "3.6.0"],
    ["gentle-ai — Gentle-AI: Ecosystem, Frameworks, Workflows (4.0.0)", "gentle-ai", "4.0.0"],
    ["gentle-ai 4.0.0\nA new version 4.3.1 is available\n", "gentle-ai", "4.0.0"],
    ["engram 3.6.0-rc.1", "engram", "3.6.0"],
    ["3.6.0\n", "engram", "3.6.0"],
    ["v4.3.1", "gentle-ai", "4.3.1"],
  ])("reads %j for %s as %s", (output, tool, expected) => {
    expect(parseToolVersion(output, tool)).toBe(expected);
  });

  it.each([
    ["", "engram"],
    ["engram: command not found", "engram"],
    // Another program's version must never be taken for the tool's.
    ["go version go1.27.0 windows/amd64", "engram"],
    ["gentle-ai 4.0.0", "engram"],
    ["engram\nsomething 1.2.3 else", "engram"],
  ])("finds no version in %j for %s", (output, tool) => {
    expect(parseToolVersion(output, tool)).toBeUndefined();
  });
});

describe("reading the version of an installed binary", () => {
  function scripted(replies: Record<string, { code: number | null; output: string }>) {
    const calls: string[][] = [];
    const run = async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      const reply = replies[args.join(" ")] ?? { code: 1, output: "" };
      return { ...reply, timedOut: false };
    };
    return { run, calls };
  }

  it("asks `version` first and stops when it answers", async () => {
    const { run, calls } = scripted({ version: { code: 0, output: "engram 3.3.2\n" } });
    expect(await readInstallVersion("/bin/engram", "engram", run)).toEqual({ version: "3.3.2" });
    expect(calls).toEqual([["version"]]);
  });

  it("falls back to `--version` when `version` is not understood", async () => {
    const { run, calls } = scripted({
      version: { code: 2, output: "unknown command" },
      "--version": { code: 0, output: "gentle-ai 4.0.0\n" },
    });
    expect(await readInstallVersion("/bin/gentle-ai", "gentle-ai", run)).toEqual({
      version: "4.0.0",
    });
    expect(calls).toEqual([["version"], ["--version"]]);
  });

  it("does not trust the version printed by a command that failed", async () => {
    const { run } = scripted({
      version: { code: 1, output: "engram 9.9.9" },
      "--version": { code: 1, output: "engram 9.9.9" },
    });
    expect(await readInstallVersion("/bin/engram", "engram", run)).toEqual({ error: "exit 1" });
  });

  it("reports a binary that cannot start without retrying", async () => {
    const calls: string[][] = [];
    const run = async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return { code: null, output: "", timedOut: false, error: "spawn EACCES" };
    };
    expect(await readInstallVersion("/bin/engram", "engram", run)).toEqual({
      error: "spawn EACCES",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a timeout and an output without a version", async () => {
    const hang = async () => ({ code: null, output: "", timedOut: true });
    expect(await readInstallVersion("/bin/engram", "engram", hang)).toEqual({
      error: "timed out",
    });
    const odd = scripted({
      version: { code: 0, output: "hello" },
      "--version": { code: 0, output: "hello" },
    });
    expect(await readInstallVersion("/bin/engram", "engram", odd.run)).toEqual({
      error: "no version in the output",
    });
  });
});

describe("running a version command with limits", () => {
  const node = process.execPath;

  it("captures the output and the exit code", async () => {
    const result = await runCapped(node, ["-e", "console.log('engram 3.3.2')"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("engram 3.3.2");
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr too and reports a non-zero exit", async () => {
    const result = await runCapped(node, ["-e", "console.error('bad'); process.exit(3)"]);
    expect(result.code).toBe(3);
    expect(result.output).toContain("bad");
  });

  it("caps the output at 4 KiB, keeping the start", async () => {
    const result = await runCapped(node, ["-e", "process.stdout.write('v'.repeat(20000))"]);
    expect(result.output.length).toBe(4096);
    expect(result.output.startsWith("vvv")).toBe(true);
  });

  it("kills a command that outlives its timeout", async () => {
    const started = Date.now();
    const result = await runCapped(node, ["-e", "setTimeout(() => {}, 60000)"], {
      timeoutMs: 400,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports a binary that does not exist instead of throwing", async () => {
    const result = await runCapped(`${node}.does-not-exist`, ["version"]);
    expect(result.code).toBeNull();
    expect(result.error).toBeTruthy();
  });
});
