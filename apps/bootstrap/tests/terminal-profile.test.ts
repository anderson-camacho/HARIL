import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { TERMINAL_PROFILE_GUID } from "../src/terminal-profile.js";
import { createFakeExec, createFakeFetch, createMemoryFs, type MemoryFs } from "./fakes.js";

// `terminal-profile`: the Windows Terminal fragment and its optional shader, written and removed on a memory fs.
const ROOT = "C:\\HARIL";
const LAUNCHER = "C:\\HARIL\\bin\\haril.cmd";
const FRAGMENT =
  "C:\\Users\\tester\\AppData\\Local\\Microsoft\\Windows Terminal\\Fragments\\HARIL\\haril.json";
const SHADER = "C:\\HARIL\\terminal\\haril-crt.hlsl";
const SETTINGS =
  "C:\\Users\\tester\\AppData\\Local\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json";
const OTHER = { guid: "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}", name: "Windows PowerShell" };
const REFERENCE = { guid: TERMINAL_PROFILE_GUID, hidden: false, name: "HARIL", source: "HARIL" };

function text(fs: MemoryFs, path: string): string {
  return new TextDecoder().decode(fs.files.get(path));
}

function harness(fs: MemoryFs = createMemoryFs(), platform = "win32") {
  const out: string[] = [];
  const err: string[] = [];
  const host: Parameters<typeof runCli>[2] = {
    platform,
    arch: "x64",
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    homeDir: "C:\\Users\\tester",
    cwd: "C:\\work",
    fs,
    exec: createFakeExec(fs, win32),
    fetch: createFakeFetch({}),
    now: () => "2026-10-31T00:00:00.000Z",
  };
  const run = (args: readonly string[]) =>
    runCli(
      ["terminal-profile", "--root", ROOT, ...args],
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      host,
    );
  return { fs, out, err, run };
}

function installed(): MemoryFs {
  const fs = createMemoryFs();
  fs.files.set(LAUNCHER, new TextEncoder().encode("@echo off"));
  return fs;
}

function fragment(fs: MemoryFs): { profiles: Record<string, unknown>[] } {
  const bytes = fs.files.get(FRAGMENT);
  if (bytes === undefined) throw new Error("fragment not written");
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("haril-bootstrap terminal-profile", () => {
  it("writes the fragment and the soft CRT shader by default", async () => {
    const { fs, out, run } = harness(installed());
    expect(await run([])).toBe(0);

    const [profile] = fragment(fs).profiles;
    expect(profile).toEqual({
      guid: TERMINAL_PROFILE_GUID,
      name: "HARIL",
      commandline: `"${LAUNCHER}"`,
      startingDirectory: "%USERPROFILE%",
      tabTitle: "HARIL",
      "experimental.pixelShaderPath": SHADER,
    });
    const shader = new TextDecoder().decode(fs.files.get(SHADER));
    expect(shader).toContain("float4 main(PSInput pin) : SV_TARGET");
    // Reading Time would make Windows Terminal redraw every frame.
    expect(shader).not.toMatch(/\bTime\s*[/*%+-]/);
    expect(out.join("\n")).toContain("pick the HARIL profile");
  });

  it("is idempotent: a second run skips both files", async () => {
    const { out, run } = harness(installed());
    await run([]);
    out.length = 0;
    expect(await run([])).toBe(0);
    expect(out.filter((line) => line.includes("skipped"))).toHaveLength(2);
  });

  it("--shader none drops the shader setting and the file a previous run wrote", async () => {
    const { fs, run } = harness(installed());
    await run([]);
    expect(await run(["--shader", "none"])).toBe(0);
    expect(fragment(fs).profiles[0]).not.toHaveProperty("experimental.pixelShaderPath");
    expect(fs.files.has(SHADER)).toBe(false);
  });

  it("fails without writing anything when HARIL is not installed", async () => {
    const { fs, err, run } = harness();
    expect(await run([])).toBe(1);
    expect(err.join("\n")).toContain("run haril-bootstrap install first");
    expect(fs.files.size).toBe(0);
  });

  it("refuses on platforms other than Windows", async () => {
    const { err, run } = harness(installed(), "linux");
    expect(await run([])).toBe(1);
    expect(err.join("\n")).toContain("Windows only");
  });

  it("rejects an unknown shader name", async () => {
    const { err, run } = harness(installed());
    expect(await run(["--shader", "balatro"])).toBe(1);
    expect(err.join("\n")).toContain("crt, none");
  });

  it("--remove deletes only the fragment and the shader", async () => {
    const { fs, out, run } = harness(installed());
    await run([]);
    expect(await run(["--remove"])).toBe(0);
    expect(fs.files.has(FRAGMENT)).toBe(false);
    expect(fs.files.has(SHADER)).toBe(false);
    expect(fs.files.has(LAUNCHER)).toBe(true);
    expect(out.join("\n")).toContain("removed 2 entries");

    out.length = 0;
    expect(await run(["--remove"])).toBe(0);
    expect(out.join("\n")).toContain("nothing to remove");
  });

  it("--remove drops only the reference entry Windows Terminal added, keeping a backup", async () => {
    const { fs, run } = harness(installed());
    await run([]);
    const original = JSON.stringify({ profiles: { defaults: {}, list: [OTHER, REFERENCE] } });
    fs.files.set(SETTINGS, new TextEncoder().encode(original));

    expect(await run(["--remove"])).toBe(0);
    expect(JSON.parse(text(fs, SETTINGS))).toEqual({ profiles: { defaults: {}, list: [OTHER] } });
    expect(text(fs, `${SETTINGS}.haril-backup`)).toBe(original);
  });

  it("--remove leaves settings with comments or HARIL as default profile for a manual edit", async () => {
    for (const original of [
      `// comment\n${JSON.stringify({ profiles: [REFERENCE] })}`,
      JSON.stringify({ defaultProfile: TERMINAL_PROFILE_GUID, profiles: [REFERENCE] }),
    ]) {
      const { fs, out, run } = harness(installed());
      fs.files.set(SETTINGS, new TextEncoder().encode(original));
      expect(await run(["--remove"])).toBe(0);
      expect(text(fs, SETTINGS)).toBe(original);
      expect(fs.files.has(`${SETTINGS}.haril-backup`)).toBe(false);
      expect(out.join("\n")).toContain(`manual    remove the profile ${TERMINAL_PROFILE_GUID}`);
    }
  });
});
