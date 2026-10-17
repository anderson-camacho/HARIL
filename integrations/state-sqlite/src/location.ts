import type { StoreGate } from "@haril/core/ports";

// Data root location gate (ST-01, INV-13). A data root on OneDrive, a UNC share or a WSL file system is refused:
// the SQLite file locks and the sync engines of those locations corrupt or lose WAL state. Pure: it reads the path
// and the injected environment only, so the open can run it before anything is created on disk.
const ONEDRIVE_VARIABLES = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const;

type Env = Readonly<Record<string, string | undefined>>;

export function checkDataLocation(dataDir: string, env: Env): StoreGate {
  const path = toBackslashes(dataDir);
  const wsl = /^\\\\(wsl\$|wsl\.localhost)(\\|$)/i.test(path);
  if (wsl) return refused("a WSL file system (\\\\wsl$)", dataDir);
  if (path.startsWith("\\\\")) return refused("a UNC network share", dataDir);
  for (const name of ONEDRIVE_VARIABLES) {
    const root = env[name];
    if (root === undefined || root === "") continue;
    if (isInside(path, toBackslashes(root))) {
      return refused(`inside ${name} (${root})`, dataDir);
    }
  }
  return {
    name: "location",
    status: "ok",
    detail: "data root is local and outside OneDrive",
  };
}

// Removes the extended-length prefix of a local path (\\?\C:\...) so the checks see the drive form; \\?\UNC\ is a share.
function toBackslashes(path: string): string {
  const slashed = path.replace(/\//g, "\\");
  if (/^\\\\\?\\UNC\\/i.test(slashed)) return `\\\\${slashed.slice("\\\\?\\UNC\\".length)}`;
  if (slashed.startsWith("\\\\?\\")) return slashed.slice("\\\\?\\".length);
  return slashed;
}

// Compares at a path-segment boundary, case-insensitively: C:\OneDrive2 is not inside C:\OneDrive.
function isInside(path: string, root: string): boolean {
  const base = root.replace(/\\+$/, "").toLowerCase();
  if (base === "") return false;
  const candidate = path.toLowerCase();
  return candidate === base || candidate.startsWith(`${base}\\`);
}

function refused(kind: string, dataDir: string): StoreGate {
  return {
    name: "location",
    status: "error",
    detail: `data root ${dataDir} is ${kind}. Remedy: move the data directory to a local disk outside OneDrive (INV-13).`,
  };
}
