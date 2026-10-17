import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkEngramDataDir,
  checkEngramPort,
  type EngramDataDirInput,
  engramDataDirOf,
  type GuardFs,
  pickEngramPort,
  RESERVED_PORTS,
} from "../src/index.js";

// The guards that run before `engram serve` is launched (ADR-0008 D5, T3; MEMORY.md 11.2; memory.md 9.4 point 2):
// ENGRAM_DATA_DIR is absolute, local, HARIL's own <data>/memory/engram and never ~/.engram or inside it, case
// variants, trailing separators, 8.3 short names and junctions included; ENGRAM_PORT is explicit, free, never 0 and
// never 7437. The corpus runs on a fake file system with Windows paths, so it means the same on every CI runner, and
// a real junction (a symlink on POSIX) proves the canonical check on this machine. Nothing here touches the real
// ~/.engram: the home directory is always a fixture.

const HOME = "C:\\Users\\fake-user";
const USER_ENGRAM = `${HOME}\\.engram`;
const HARIL_DATA = "C:\\haril\\data";
const OWNED = `${HARIL_DATA}\\memory\\engram`;

// realpath of a fake Windows volume: the identity, except the aliases given (a short name, a junction).
function fakeFs(aliases: Readonly<Record<string, string>> = {}): GuardFs & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    realpath(path) {
      calls.push(path);
      const hit = Object.entries(aliases).find(
        ([alias]) => path.toLowerCase() === alias.toLowerCase(),
      );
      return hit === undefined ? path : hit[1];
    },
  };
}

function windows(candidate: string, overrides: Partial<EngramDataDirInput> = {}) {
  return checkEngramDataDir({
    candidate,
    harilDataDir: HARIL_DATA,
    homeDir: HOME,
    env: {},
    platform: "win32",
    fs: fakeFs(),
    ...overrides,
  });
}

describe("the ENGRAM_DATA_DIR guard (ADR-0008 T3 corpus)", () => {
  it("accepts only HARIL's own <data>/memory/engram, in any case", () => {
    expect(engramDataDirOf(HARIL_DATA, "win32")).toBe(OWNED);
    expect(windows(OWNED)).toEqual({ ok: true, dataDir: OWNED });
    expect(windows("c:\\HARIL\\Data\\memory\\ENGRAM\\")).toMatchObject({ ok: true });
    expect(windows("C:/haril/data/memory/engram")).toMatchObject({ ok: true });
  });

  it("refuses every path that resolves to ~/.engram or inside it", () => {
    const corpus: readonly (readonly [string, string, GuardFs?])[] = [
      ["~/.engram itself", USER_ENGRAM],
      ["another case", "c:\\users\\FAKE-USER\\.ENGRAM"],
      ["a trailing separator", `${USER_ENGRAM}\\`],
      ["forward slashes", "C:/Users/fake-user/.engram"],
      ["a dot segment", `${HOME}\\Documents\\..\\.engram`],
      ["a subdirectory", `${USER_ENGRAM}\\haril\\memory\\engram`],
      [
        "an 8.3 short name",
        "C:\\Users\\FAKE-U~1\\.engram",
        fakeFs({ "C:\\Users\\FAKE-U~1": HOME }),
      ],
      ["a junction into it", OWNED, fakeFs({ "C:\\haril\\data\\memory": `${USER_ENGRAM}\\data` })],
    ];
    for (const [label, candidate, fs] of corpus) {
      const result = windows(candidate, fs === undefined ? {} : { fs });
      expect(result, label).toMatchObject({ ok: false, reason: "user_engram" });
    }
  });

  it("refuses an empty, relative or non-local path, and one HARIL does not own", () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ["empty", "", "empty"],
      ["only spaces", "   ", "empty"],
      ["relative", "data\\memory\\engram", "relative"],
      ["drive-relative", "\\haril\\data\\memory\\engram", "relative"],
      ["a drive without a root", "C:haril\\data", "relative"],
      ["a UNC share", "\\\\server\\share\\memory\\engram", "not_local"],
      ["an extended-length path", "\\\\?\\C:\\haril\\data\\memory\\engram", "not_local"],
      ["a device path", "\\\\.\\C:\\haril\\data\\memory\\engram", "not_local"],
      ["a WSL path", "\\\\wsl$\\Ubuntu\\home\\fake\\engram", "not_local"],
      ["another directory", "C:\\elsewhere\\engram", "not_owned"],
      ["HARIL's data root itself", HARIL_DATA, "not_owned"],
    ];
    for (const [label, candidate, reason] of cases) {
      expect(windows(candidate), label).toMatchObject({ ok: false, reason });
    }
    const oneDrive = windows(OWNED, { env: { OneDrive: "C:\\haril" } });
    expect(oneDrive).toMatchObject({ ok: false, reason: "not_local" });
  });

  it("never resolves a path inside ~/.engram, even to refuse it", () => {
    const fs = fakeFs({ "C:\\haril\\data\\memory": USER_ENGRAM });
    expect(windows(OWNED, { fs })).toMatchObject({ ok: false, reason: "user_engram" });
    expect(windows(`${USER_ENGRAM}\\deep\\er`, { fs })).toMatchObject({ reason: "user_engram" });
    const inside = fs.calls.filter((path) =>
      path.toLowerCase().startsWith(`${USER_ENGRAM}\\`.toLowerCase()),
    );
    expect(inside).toEqual([]);
  });
});

describe("the ENGRAM_DATA_DIR guard on this machine's file system", () => {
  let root = "";

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "haril-engram-guard-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a junction (a symlink on POSIX) from HARIL's data dir into ~/.engram and leaves ~/.engram untouched", () => {
    const home = join(root, "home");
    const userEngram = join(home, ".engram");
    mkdirSync(userEngram, { recursive: true });
    const harilData = join(root, "haril", "data");
    mkdirSync(harilData, { recursive: true });
    symlinkSync(userEngram, join(harilData, "memory"), "junction");
    const calls: string[] = [];
    const fs: GuardFs = {
      realpath(path) {
        calls.push(path);
        return realpathSync.native(path);
      },
    };
    const result = checkEngramDataDir({
      candidate: engramDataDirOf(harilData),
      harilDataDir: harilData,
      homeDir: home,
      env: {},
      fs,
    });
    expect(result).toMatchObject({ ok: false, reason: "user_engram" });
    expect(calls.filter((path) => path.startsWith(`${userEngram}${sep}`))).toEqual([]);
    expect(readdirSync(userEngram)).toEqual([]);
  });

  it("refuses HARIL's data dir when ~/.engram is itself a link to the place it lives in", () => {
    const store = join(root, "engram-store");
    mkdirSync(join(store, "data"), { recursive: true });
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    symlinkSync(store, join(home, ".engram"), "junction");
    const harilData = join(store, "data");
    const result = checkEngramDataDir({
      candidate: engramDataDirOf(harilData),
      harilDataDir: harilData,
      homeDir: home,
      env: {},
    });
    expect(result).toMatchObject({ ok: false, reason: "user_engram" });
  });

  it("accepts HARIL's own directory before it exists", () => {
    const harilData = join(root, "haril", "data");
    mkdirSync(harilData, { recursive: true });
    const candidate = engramDataDirOf(harilData);
    expect(
      checkEngramDataDir({
        candidate,
        harilDataDir: harilData,
        homeDir: join(root, "home"),
        env: {},
      }),
    ).toEqual({ ok: true, dataDir: candidate });
  });
});

describe("the ENGRAM_PORT guard", () => {
  let busy: Server | undefined;

  afterEach(async () => {
    const server = busy;
    busy = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses 7437 and the other reserved ports without binding or contacting them", async () => {
    expect(RESERVED_PORTS).toContain(7437);
    const probed: number[] = [];
    const probe = {
      isFree: async (port: number) => {
        probed.push(port);
        return true;
      },
    };
    for (const port of RESERVED_PORTS) {
      expect(await checkEngramPort(port, probe), String(port)).toMatchObject({
        ok: false,
        reason: "reserved",
      });
    }
    expect(probed).toEqual([]);
  });

  it("refuses 0, a fraction and a port out of range", async () => {
    for (const port of [0, -1, 1.5, 65_536, Number.NaN]) {
      expect(await checkEngramPort(port), String(port)).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("refuses a loopback port already in use and accepts a free one it picked", async () => {
    const server = createServer();
    busy = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const taken = typeof address === "object" && address !== null ? address.port : 0;
    expect(await checkEngramPort(taken)).toMatchObject({ ok: false, reason: "in_use" });
    const picked = await pickEngramPort();
    expect(RESERVED_PORTS).not.toContain(picked);
    expect(await checkEngramPort(picked)).toEqual({ ok: true, port: picked });
  });
});
