import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

// The filesystem operations of installing a tool, behind one small interface so a test can make a single step fail
// (a rename that reports EBUSY) while everything else is real. All of them are synchronous and throw on failure.

interface EnsureStat {
  readonly mtimeMs: number;
  readonly size: number;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
  // Hard links to the file: more than one means the name is shared with another path.
  readonly links: number;
}

export interface EnsureFs {
  exists(path: string): boolean;
  // Creates the folder and its parents, owner-only where the platform has modes.
  mkdir(path: string): void;
  readText(path: string): string;
  // Creates a new file and fails when the path exists (the `wx` flag).
  writeNew(path: string, data: string | Uint8Array, mode: number): void;
  copyFile(from: string, to: string): void;
  rename(from: string, to: string): void;
  // Deletes a file or a folder with its content; a missing path is not an error.
  remove(path: string): void;
  readDir(path: string): string[];
  // Describes the path itself, a link not followed.
  stat(path: string): EnsureStat;
  // The canonical form of a path that exists: links, junctions and 8.3 names resolved.
  realpath(path: string): string;
  chmod(path: string, mode: number): void;
}

export const nodeEnsureFs: EnsureFs = {
  exists: (path) => existsSync(path),
  mkdir: (path) => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  },
  readText: (path) => readFileSync(path, "utf8"),
  writeNew: (path, data, mode) => writeFileSync(path, data, { flag: "wx", mode }),
  copyFile: (from, to) => copyFileSync(from, to),
  rename: (from, to) => renameSync(from, to),
  // Windows reports EBUSY or EPERM for a moment while a scanner or a closing process still holds a file.
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }),
  readDir: (path) => readdirSync(path),
  stat: (path) => {
    const stat = lstatSync(path);
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      isFile: stat.isFile(),
      isSymlink: stat.isSymbolicLink(),
      links: stat.nlink,
    };
  },
  realpath: (path) => realpathSync.native(path),
  chmod: (path, mode) => chmodSync(path, mode),
};

export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}
