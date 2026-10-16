import { describe, expect, it } from "vitest";
import { resolveDataDir } from "../src/data-dir.js";

// Precedence (M1-D8): --data-dir flag > HARIL_HOME > platform default.
const WIN_HOME = "C:\\Users\\tester";

describe("resolveDataDir", () => {
  it("the flag wins over HARIL_HOME and the platform default", () => {
    const result = resolveDataDir({
      flag: "D:\\scratch\\data",
      env: { HARIL_HOME: "E:\\other" },
      platform: "win32",
      homeDir: WIN_HOME,
    });
    expect(result).toEqual({ dataDir: "D:\\scratch\\data", source: "flag" });
  });

  it("HARIL_HOME wins over the platform default", () => {
    const result = resolveDataDir({
      env: { HARIL_HOME: "/tmp/haril-test" },
      platform: "linux",
      homeDir: "/home/tester",
    });
    expect(result).toEqual({ dataDir: "/tmp/haril-test", source: "HARIL_HOME" });
  });

  it("an empty HARIL_HOME is ignored", () => {
    const result = resolveDataDir({
      env: { HARIL_HOME: "" },
      platform: "linux",
      homeDir: "/home/tester",
    });
    expect(result.source).toBe("platform-default");
  });

  it("win32 defaults to %LOCALAPPDATA%\\HARIL\\data", () => {
    const result = resolveDataDir({
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      platform: "win32",
      homeDir: WIN_HOME,
    });
    expect(result).toEqual({
      dataDir: "C:\\Users\\tester\\AppData\\Local\\HARIL\\data",
      source: "platform-default",
    });
  });

  it("win32 without LOCALAPPDATA falls back to the profile's AppData\\Local", () => {
    const result = resolveDataDir({ env: {}, platform: "win32", homeDir: WIN_HOME });
    expect(result.dataDir).toBe("C:\\Users\\tester\\AppData\\Local\\HARIL\\data");
  });

  it("other platforms default to ~/.local/share/haril/data", () => {
    const result = resolveDataDir({ env: {}, platform: "linux", homeDir: "/home/tester" });
    expect(result).toEqual({
      dataDir: "/home/tester/.local/share/haril/data",
      source: "platform-default",
    });
  });

  it("other platforms respect XDG_DATA_HOME: $XDG_DATA_HOME/haril/data", () => {
    const result = resolveDataDir({
      env: { XDG_DATA_HOME: "/srv/xdg" },
      platform: "linux",
      homeDir: "/home/tester",
    });
    expect(result).toEqual({ dataDir: "/srv/xdg/haril/data", source: "platform-default" });
  });

  it("an empty XDG_DATA_HOME is ignored", () => {
    const result = resolveDataDir({
      env: { XDG_DATA_HOME: "" },
      platform: "linux",
      homeDir: "/home/tester",
    });
    expect(result.dataDir).toBe("/home/tester/.local/share/haril/data");
  });
});
