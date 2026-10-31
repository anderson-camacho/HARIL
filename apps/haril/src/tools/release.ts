import { createHash } from "node:crypto";

// Where the official Engram release is and how its files are named. scripts/install-engram.mjs (the developer's
// installer) must keep downloading the same thing; a test reads its text to catch a drift.

const REPOSITORY = "Gentleman-Programming/engram";

const OS_NAMES = new Map([
  ["win32", "windows"],
  ["linux", "linux"],
  ["darwin", "darwin"],
]);
const ARCH_NAMES = new Map([
  ["x64", "amd64"],
  ["arm64", "arm64"],
]);

export interface EngramAsset {
  // engram_<version>_<os>_<arch>.<zip|tar.gz>
  readonly name: string;
  readonly url: string;
  readonly checksumsUrl: string;
  // The one file taken from the archive, found at its root.
  readonly binary: string;
}

// The release asset for a platform, or undefined when the release has none for it.
export function engramAsset(
  version: string,
  platform: string,
  arch: string,
): EngramAsset | undefined {
  const os = OS_NAMES.get(platform);
  const cpu = ARCH_NAMES.get(arch);
  if (os === undefined || cpu === undefined) return undefined;
  const name = `engram_${version}_${os}_${cpu}.${os === "windows" ? "zip" : "tar.gz"}`;
  const base = `https://github.com/${REPOSITORY}/releases/download/v${version}`;
  return {
    name,
    url: `${base}/${name}`,
    checksumsUrl: `${base}/checksums.txt`,
    binary: os === "windows" ? "engram.exe" : "engram",
  };
}

export type ChecksumLookup =
  | { readonly ok: true; readonly sha256: string }
  | { readonly ok: false; readonly reason: string };

// The SHA-256 that checksums.txt ("<hex>  <name>", sha256sum style, `*` for binary mode) gives for exactly that asset.
export function findChecksum(text: string, name: string): ChecksumLookup {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (match?.[2] === name && match[1] !== undefined) found.add(match[1].toLowerCase());
  }
  const [first, ...others] = found;
  if (first === undefined) return { ok: false, reason: `no valid line for ${name}` };
  if (others.length > 0) return { ok: false, reason: `more than one digest for ${name}` };
  return { ok: true, sha256: first };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
