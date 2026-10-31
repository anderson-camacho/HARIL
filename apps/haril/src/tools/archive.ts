import { join } from "node:path";
import type { EnsureFs } from "./fs.js";
import { errorText } from "./fs.js";
import type { ExecFn } from "./system.js";

// Takes one file out of a release archive. The list of entries is judged before anything is extracted, and only the
// expected binary is asked for, so an entry that climbs out of the folder (zip-slip) never reaches the disk.

const LISTING_CAP = 256 * 1024;
const TAR_TIMEOUT_MS = 60_000;
const MAX_BINARY_BYTES = 150 * 1024 * 1024;

// The tar HARIL runs: Windows 10 and later ship a bsdtar that reads zip as well as tar.gz, and it is named by its
// path under %SystemRoot%, never found on PATH. Elsewhere it is the system's `tar`.
export function tarCommand(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return `${root}\\System32\\tar.exe`;
}

function hasControlCharacter(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// Why an entry name cannot be extracted safely, or undefined when it can.
function unsafeEntry(name: string): string | undefined {
  if (name === "") return "an empty name";
  if (hasControlCharacter(name)) return "control characters in the name";
  if (name.startsWith("/") || name.startsWith("\\")) return "an absolute path";
  if (/^[A-Za-z]:/.test(name)) return "a drive path";
  if (name.split(/[\\/]+/).includes("..")) return "a parent-directory step";
  return undefined;
}

export type ListingCheck =
  | { readonly ok: true; readonly entry: string }
  | { readonly ok: false; readonly reason: string };

// Judges the output of `tar -tf`: every entry must be safe, and the binary must appear exactly once at the root. The
// entry is returned as the archive spells it (`engram` or `./engram`), which is what extraction has to be asked for.
export function checkArchiveListing(listing: string, binary: string): ListingCheck {
  const lines = listing.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return { ok: false, reason: "the archive is empty" };
  const matches: string[] = [];
  for (const line of lines) {
    const problem = unsafeEntry(line);
    if (problem !== undefined) {
      return {
        ok: false,
        reason: `the archive has an unsafe entry (${problem}): ${line.slice(0, 80)}`,
      };
    }
    if (line.replace(/^(\.\/)+/, "") === binary) matches.push(line);
  }
  const [entry, ...others] = matches;
  if (entry === undefined) return { ok: false, reason: `the archive has no ${binary} at its root` };
  if (others.length > 0)
    return { ok: false, reason: `${binary} appears more than once in the archive` };
  return { ok: true, entry };
}

export interface ExtractInput {
  readonly archive: string;
  readonly destDir: string;
  readonly binary: string;
  readonly tar: string;
}

export type ExtractResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export async function extractBinary(
  input: ExtractInput,
  exec: ExecFn,
  fs: EnsureFs,
): Promise<ExtractResult> {
  const { archive, destDir, binary, tar } = input;
  const listed = await exec(tar, ["-tf", archive], {
    timeoutMs: TAR_TIMEOUT_MS,
    capBytes: LISTING_CAP,
  });
  if (listed.error !== undefined)
    return { ok: false, reason: `could not run tar: ${listed.error}` };
  if (listed.timedOut) return { ok: false, reason: "tar timed out reading the archive" };
  if (listed.code !== 0) {
    return {
      ok: false,
      reason: `tar could not read the archive (exit ${listed.code ?? "unknown"})`,
    };
  }
  if (listed.output.length >= LISTING_CAP) {
    return { ok: false, reason: "the archive lists too many entries" };
  }
  const checked = checkArchiveListing(listed.output, binary);
  if (!checked.ok) return checked;

  const extracted = await exec(tar, ["-xf", archive, "-C", destDir, checked.entry], {
    timeoutMs: TAR_TIMEOUT_MS,
  });
  if (extracted.error !== undefined || extracted.timedOut || extracted.code !== 0) {
    return { ok: false, reason: `tar could not extract ${binary}` };
  }

  const path = join(destDir, binary);
  try {
    const stat = fs.stat(path);
    if (stat.isSymlink) return { ok: false, reason: `${binary} in the archive is a symbolic link` };
    if (!stat.isFile) return { ok: false, reason: `${binary} in the archive is not a file` };
    if (stat.links > 1) return { ok: false, reason: `${binary} in the archive is a hard link` };
    if (stat.size === 0 || stat.size > MAX_BINARY_BYTES) {
      return { ok: false, reason: `${binary} in the archive has an unusable size (${stat.size})` };
    }
    fs.chmod(path, 0o755);
  } catch (error) {
    return { ok: false, reason: `${binary} was not extracted: ${errorText(error)}` };
  }
  return { ok: true, path };
}
