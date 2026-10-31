// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the drift test compares the literal source text of a script
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGRAM_VERSION } from "../src/memory-config.js";
import { engramAsset, findChecksum, sha256Hex } from "../src/tools/release.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("the Engram release asset of each platform", () => {
  it.each([
    ["win32", "x64", "engram_3.6.0_windows_amd64.zip", "engram.exe"],
    ["win32", "arm64", "engram_3.6.0_windows_arm64.zip", "engram.exe"],
    ["linux", "x64", "engram_3.6.0_linux_amd64.tar.gz", "engram"],
    ["linux", "arm64", "engram_3.6.0_linux_arm64.tar.gz", "engram"],
    ["darwin", "arm64", "engram_3.6.0_darwin_arm64.tar.gz", "engram"],
    ["darwin", "x64", "engram_3.6.0_darwin_amd64.tar.gz", "engram"],
  ])("names %s/%s %s", (platform, arch, name, binary) => {
    const asset = engramAsset("3.6.0", platform, arch);
    expect(asset).toMatchObject({ name, binary });
    const base = "https://github.com/Gentleman-Programming/engram/releases/download/v3.6.0";
    expect(asset?.url).toBe(`${base}/${name}`);
    expect(asset?.checksumsUrl).toBe(`${base}/checksums.txt`);
  });

  it.each([
    ["freebsd", "x64"],
    ["linux", "ia32"],
    ["win32", "mips"],
  ])("has no asset for %s/%s", (platform, arch) => {
    expect(engramAsset("3.6.0", platform, arch)).toBeUndefined();
  });
});

describe("finding the checksum of an asset in checksums.txt", () => {
  const name = "engram_3.6.0_windows_amd64.zip";

  it("takes the line that names exactly that asset", () => {
    const text = `${SHA_B}  engram_3.6.0_linux_amd64.tar.gz\n${SHA_A}  ${name}\n`;
    expect(findChecksum(text, name)).toEqual({ ok: true, sha256: SHA_A });
  });

  it("accepts CRLF, a binary-mode asterisk and upper-case digits", () => {
    const text = `${SHA_B}  other.zip\r\n${SHA_A.toUpperCase()} *${name}\r\n`;
    expect(findChecksum(text, name)).toEqual({ ok: true, sha256: SHA_A });
  });

  it("fails when the asset has no line, even if another name contains it", () => {
    const text = `${SHA_A}  ${name}.sig\n${SHA_B}  x_${name}\n`;
    expect(findChecksum(text, name)).toMatchObject({ ok: false });
  });

  it("fails on a line whose digest is not 64 hex characters", () => {
    expect(findChecksum(`${"a".repeat(63)}  ${name}\n`, name)).toMatchObject({ ok: false });
    expect(findChecksum(`${"z".repeat(64)}  ${name}\n`, name)).toMatchObject({ ok: false });
  });

  it("fails when the same asset appears with two different digests", () => {
    const text = `${SHA_A}  ${name}\n${SHA_B}  ${name}\n`;
    const result = findChecksum(text, name);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("more than one");
  });

  it("accepts the same asset listed twice with the same digest", () => {
    expect(findChecksum(`${SHA_A}  ${name}\n${SHA_A}  ${name}\n`, name)).toEqual({
      ok: true,
      sha256: SHA_A,
    });
  });

  it("fails on an empty file", () => {
    expect(findChecksum("", name)).toMatchObject({ ok: false });
  });
});

describe("hashing", () => {
  it("is the SHA-256 in lower-case hex", () => {
    const bytes = Buffer.from("engram");
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

// scripts/install-engram.mjs is the developer's installer; HARIL's own ensure must download the same thing.
describe("drift between npm run memory:install and haril tools ensure", () => {
  const script = readFileSync(
    join(fileURLToPath(new URL("../../..", import.meta.url)), "scripts", "install-engram.mjs"),
    "utf8",
  );

  it("pins the same Engram version", () => {
    expect(/^const version = "(\d+\.\d+\.\d+)";$/m.exec(script)?.[1]).toBe(ENGRAM_VERSION);
  });

  it("names the asset and the checksum file the same way", () => {
    expect(script).toContain('{ win32: "windows", linux: "linux", darwin: "darwin" }');
    expect(script).toContain('{ x64: "amd64", arm64: "arm64" }');
    expect(script).toContain(
      '`engram_${version}_${os}_${arch}.${os === "windows" ? "zip" : "tar.gz"}`',
    );
    expect(script).toContain("`${base}/checksums.txt`");
    expect(script).toContain(
      "`https://github.com/Gentleman-Programming/engram/releases/download/v${version}`",
    );
    const asset = engramAsset(ENGRAM_VERSION, "win32", "x64");
    expect(asset?.name).toBe(`engram_${ENGRAM_VERSION}_windows_amd64.zip`);
    expect(asset?.checksumsUrl.endsWith("/checksums.txt")).toBe(true);
  });

  it("installs under vendor/engram/<version> and registers the same MCP server", () => {
    expect(script).toContain('"vendor",\n  "engram",\n  version,');
    expect(script).toContain('args: ["mcp", "--tools=agent"]');
    expect(script).toContain('ENGRAM_PROJECT: "haril"');
    expect(script).toContain('ENGRAM_STARTUP_POLICY: "deny"');
    expect(script).toContain('ENGRAM_NO_UPDATE_CHECK: "1"');
  });
});
