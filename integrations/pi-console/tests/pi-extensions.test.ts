import { describe, expect, it } from "vitest";
import { decodePiExtensionPackages, extensionStatusText } from "../src/pi-extensions.js";

describe("configured Pi packages are distinct from visual dock slots", () => {
  it("decodes only HARIL-private package entries with explicit state", () => {
    expect(
      decodePiExtensionPackages({
        scope: "haril-private-pi-agent",
        installedOrLoaded: "unknown",
        packages: [
          { source: "git:github.com/CinloDev/pi-youtube-player", extensions: "enabled" },
          { source: "npm:other", extensions: "disabled" },
          { source: "npm:custom", extensions: "filtered" },
        ],
      }),
    ).toEqual([
      { source: "git:github.com/CinloDev/pi-youtube-player", extensions: "enabled" },
      { source: "npm:other", extensions: "disabled" },
      { source: "npm:custom", extensions: "filtered" },
    ]);
    expect(extensionStatusText("disabled")).toContain("deshabilitadas");
  });

  it("never treats arbitrary status reports, dock labels or malformed entries as Pi packages", () => {
    expect(
      decodePiExtensionPackages({ scope: "dock-preferences-only", plugins: [] }),
    ).toBeUndefined();
    expect(
      decodePiExtensionPackages({ scope: "haril-private-pi-agent", packages: ["git"] }),
    ).toBeUndefined();
    expect(
      decodePiExtensionPackages({
        scope: "haril-private-pi-agent",
        packages: [{ source: "", extensions: "enabled" }],
      }),
    ).toBeUndefined();
  });
});
