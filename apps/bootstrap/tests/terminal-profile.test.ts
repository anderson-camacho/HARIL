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

function fragment(fs: MemoryFs): {
  profiles: Record<string, unknown>[];
  schemes: Record<string, unknown>[];
} {
  const bytes = fs.files.get(FRAGMENT);
  if (bytes === undefined) throw new Error("fragment not written");
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("haril-bootstrap terminal-profile", () => {
  it("writes the fragment and the soft CRT shader by default", async () => {
    const { fs, out, run } = harness(installed());
    expect(await run([])).toBe(0);

    const { profiles, schemes } = fragment(fs);
    const [profile] = profiles;
    expect(profile).toEqual({
      guid: TERMINAL_PROFILE_GUID,
      name: "HARIL",
      commandline: `"${LAUNCHER}"`,
      startingDirectory: "%USERPROFILE%",
      tabTitle: "HARIL",
      colorScheme: "HARIL Future",
      cursorShape: "filledBox",
      "experimental.pixelShaderPath": SHADER,
      backgroundImage: "C:\\HARIL\\terminal\\haril-background.png",
      backgroundImageOpacity: 0.35,
      backgroundImageStretchMode: "uniformToFill",
    });
    // The profile names a scheme that the same fragment defines.
    expect(schemes.map((scheme) => scheme.name)).toEqual(["HARIL Future"]);
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
    expect(out.filter((line) => line.includes("skipped"))).toHaveLength(3);
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
    expect(out.join("\n")).toContain("removed 3 entries");

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

describe("the blue look of the HARIL profile", () => {
  const FONTS = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\Windows\\Fonts";

  async function install(fs: MemoryFs) {
    await fs.writeFile(LAUNCHER, new TextEncoder().encode("launcher"));
    const { run } = harness(fs);
    await run([]);
    return JSON.parse(text(fs, FRAGMENT));
  }

  it("ships the scheme in the fragment and names it with a filled cursor", async () => {
    const fragment = await install(createMemoryFs());
    const profile = fragment.profiles[0];
    expect(profile.cursorShape).toBe("filledBox");
    expect(profile.colorScheme).toBe("HARIL Future");
    expect(profile.font).toBeUndefined();
    expect(profile.backgroundImage).toBe("C:\\HARIL\\terminal\\haril-background.png");
    expect(fragment.profiles).toHaveLength(1);
    expect(fragment.schemes[0]).toMatchObject({
      name: "HARIL Future",
      background: "#07172C",
      cursorColor: "#5EC2FF",
    });
  });

  it("uses a Nerd Font only when one is installed", async () => {
    const fs = createMemoryFs();
    await fs.writeFile(
      win32.join(FONTS, "JetBrainsMonoNerdFont-Regular.ttf"),
      new TextEncoder().encode("font"),
    );
    const fragment = await install(fs);
    expect(fragment.profiles[0].font).toEqual({ face: "JetBrainsMono Nerd Font" });
  });

  it("writes the same default image on every run and removes it with the profile", async () => {
    const png = "C:\\HARIL\\terminal\\haril-background.png";
    const fs = installed();
    const { run, out } = harness(fs);
    await run([]);
    const first = fs.files.get(png);
    expect(first?.slice(0, 4)).toEqual(Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
    await run([]);
    expect(fs.files.get(png)).toEqual(first);
    expect(out.join("\n")).toContain("background");
    await run(["--remove"]);
    expect(fs.files.has(png)).toBe(false);
  });

  it("uses a valid picture of the user's, and turns the image off with none", async () => {
    const image = "C:\\pictures\\space.jpg";
    const fs = installed();
    fs.files.set(image, new TextEncoder().encode("picture"));
    const { run } = harness(fs);
    expect(
      await run([
        "--background-image",
        image,
        "--background-opacity",
        "0.5",
        "--background-stretch",
        "fill",
      ]),
    ).toBe(0);
    expect(fragment(fs).profiles[0]).toMatchObject({
      backgroundImage: image,
      backgroundImageOpacity: 0.5,
      backgroundImageStretchMode: "fill",
    });
    expect(fs.files.has(image)).toBe(true);
    expect(await run(["--background-image", "none"])).toBe(0);
    expect(fragment(fs).profiles[0]).not.toHaveProperty("backgroundImage");
    expect(fs.files.has("C:\\HARIL\\terminal\\haril-background.png")).toBe(false);
  });

  it("keeps the default and warns when the picture cannot be used", async () => {
    const fs = installed();
    fs.files.set("C:\\pictures\\notes.txt", new TextEncoder().encode("text"));
    const { run, err } = harness(fs);
    for (const bad of ["space.png", "C:\\pictures\\missing.png", "C:\\pictures\\notes.txt"]) {
      expect(await run(["--background-image", bad])).toBe(0);
      expect(fragment(fs).profiles[0]?.backgroundImage).toBe(
        "C:\\HARIL\\terminal\\haril-background.png",
      );
    }
    expect(err.join("\n")).toContain("keeping the default image");
    expect(await run(["--background-opacity", "2"])).not.toBe(0);
  });
});
