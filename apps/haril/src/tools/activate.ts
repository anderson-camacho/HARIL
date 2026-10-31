import { join } from "node:path";
import { compareVersions, versionParts } from "../version-compare.js";
import type { EnsureFs } from "./fs.js";
import { errorCode, errorText } from "./fs.js";
import { isInside } from "./paths.js";

// Puts a verified binary where the runtime looks for it, <vendor>/engram/<version>/, in one rename: the copy is staged
// in a sibling folder first, so the installed one is never half written, and an existing folder is moved aside and
// put back if the last step fails.

export interface ActivateInput {
  readonly vendorRoot: string;
  readonly version: string;
  readonly binary: string;
  // The verified binary to copy.
  readonly source: string;
  readonly pid: number;
  readonly now: number;
}

export type ActivateResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly inUse: boolean; readonly message: string };

const IN_USE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

const IN_USE_MESSAGE = "Engram is in use: stop the runtime (haril stop) and retry";

function refusal(error: unknown, what: string): ActivateResult {
  if (IN_USE_CODES.has(errorCode(error) ?? "")) {
    return { ok: false, inUse: true, message: IN_USE_MESSAGE };
  }
  return { ok: false, inUse: false, message: `${what}: ${errorText(error)}` };
}

function attempt(action: () => void): void {
  try {
    action();
  } catch {
    // Best effort: a leftover folder is cleaned up by the next run.
  }
}

export function activateCopy(input: ActivateInput, fs: EnsureFs): ActivateResult {
  const { vendorRoot, version, binary, source } = input;
  const finalDir = join(vendorRoot, version);
  const stage = join(vendorRoot, `${version}.tmp-${input.pid}`);
  const aside = join(vendorRoot, `${version}.old-${input.now}`);

  try {
    fs.mkdir(vendorRoot);
    // A staging folder of an earlier run that died is not trusted: it is rebuilt.
    fs.remove(stage);
    fs.mkdir(stage);
    const staged = join(stage, binary);
    fs.copyFile(source, staged);
    fs.chmod(staged, 0o755);
  } catch (error) {
    attempt(() => fs.remove(stage));
    return refusal(error, "could not stage the new copy");
  }

  let movedAside = false;
  if (fs.exists(finalDir)) {
    try {
      fs.rename(finalDir, aside);
      movedAside = true;
    } catch (error) {
      attempt(() => fs.remove(stage));
      return refusal(error, "could not move the current copy aside");
    }
  }
  try {
    fs.rename(stage, finalDir);
  } catch (error) {
    if (movedAside) attempt(() => fs.rename(aside, finalDir));
    attempt(() => fs.remove(stage));
    return refusal(error, "could not activate the new copy");
  }
  if (movedAside) attempt(() => fs.remove(aside));
  return { ok: true, path: join(finalDir, binary) };
}

export interface PruneInput {
  readonly vendorRoot: string;
  readonly pin: string;
  // Binaries still in use: the folder that holds one of them stays.
  readonly keep?: readonly string[];
  // The platform whose path rules compare them; the machine's own when absent.
  readonly platform?: string;
}

// Removes what an update leaves behind: versions older than the one before the pin (that one stays for a rollback),
// and the staging and moved-aside folders of earlier runs. Newer versions and anything else are not touched. It is
// best effort and returns the names it removed.
export function pruneVendor(input: PruneInput, fs: EnsureFs): string[] {
  const { vendorRoot, pin } = input;
  let names: string[];
  try {
    names = fs.readDir(vendorRoot);
  } catch {
    return [];
  }
  const platform = input.platform ?? process.platform;
  const kept = (name: string) =>
    (input.keep ?? []).some((path) => isInside(path, join(vendorRoot, name), platform));

  const older = names
    .filter((name) => versionParts(name) !== null && compareVersions(name, pin) < 0)
    .sort((a, b) => compareVersions(b, a));
  const leftovers = names.filter((name) => /^\d+\.\d+\.\d+\.(?:old|tmp)-/.test(name));
  // The newest older version is the rollback; everything below it goes.
  const doomed = [...older.slice(1), ...leftovers].filter((name) => !kept(name));

  const removed: string[] = [];
  for (const name of doomed) {
    try {
      fs.remove(join(vendorRoot, name));
      removed.push(name);
    } catch {
      // Still in use or locked: it stays until the next run.
    }
  }
  return removed;
}
