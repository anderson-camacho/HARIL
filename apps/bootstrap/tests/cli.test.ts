import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import {
  createFakeExec,
  createFakeFetch,
  createMemoryFs,
  RELEASE,
  shasumsFor,
  ZIP_BYTES,
  ZIP_NAME,
} from "./fakes.js";

// The command line: help, usage errors and the install-runtime report (one line per step, or JSON).
function harness() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
  };
}

describe("haril-bootstrap command line", () => {
  it("prints help and exits 0 for --help", async () => {
    const { io, out } = harness();
    expect(await runCli(["--help"], io, host())).toBe(0);
    expect(out.join("\n")).toContain("install-runtime [--root <dir>] [--json]");
  });

  it("exits 1 with usage for an unknown command or option", async () => {
    const unknown = harness();
    expect(await runCli(["launch"], unknown.io, host())).toBe(1);
    expect(unknown.err.join("\n")).toContain("usage:");

    const option = harness();
    expect(await runCli(["install-runtime", "--force"], option.io, host())).toBe(1);
    expect(option.err.join("\n")).toContain("--force");
  });

  it("prints one line per step for install-runtime and exits 0 on success", async () => {
    const fs = createMemoryFs();
    const { io, out } = harness();
    const exitCode = await runCli(
      ["install-runtime", "--root", "C:\\HARIL"],
      io,
      host({
        fs,
        exec: createFakeExec(fs, win32),
        fetch: createFakeFetch({
          [`${RELEASE}SHASUMS256.txt`]: shasumsFor(ZIP_BYTES),
          [`${RELEASE}${ZIP_NAME}`]: ZIP_BYTES,
        }),
      }),
    );
    expect(exitCode).toBe(0);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^node\s+ok\s/);
    expect(out[1]).toMatch(/^pi\s+ok\s/);
    expect(out[2]).toMatch(/^manifest\s+ok\s/);
  });

  it("prints a JSON report with --json and exits 1 when a step fails", async () => {
    const fs = createMemoryFs();
    const { io, out } = harness();
    const exitCode = await runCli(
      ["install-runtime", "--root", "C:\\HARIL", "--json"],
      io,
      host({
        fs,
        exec: createFakeExec(fs, win32),
        fetch: createFakeFetch({}),
      }),
    );
    expect(exitCode).toBe(1);
    const report = JSON.parse(out.join("\n")) as {
      ok: boolean;
      root: string;
      steps: { name: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.root).toBe("C:\\HARIL");
    expect(report.steps.map((step) => step.name)).toEqual(["node", "pi", "manifest"]);
  });
});

function host(overrides: Partial<Parameters<typeof runCli>[2]> = {}): Parameters<typeof runCli>[2] {
  const fs = createMemoryFs();
  return {
    platform: "win32",
    arch: "x64",
    env: {},
    homeDir: "C:\\Users\\tester",
    cwd: "C:\\work",
    fs,
    exec: createFakeExec(fs, win32),
    fetch: createFakeFetch({}),
    now: () => "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}
