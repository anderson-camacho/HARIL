import { createHash } from "node:crypto";
import type { PlatformPath } from "node:path";
import type {
  ExecOptions,
  ExecPort,
  ExecResult,
  FetchPort,
  FsPort,
  InstallDeps,
} from "../src/index.js";

// Hermetic doubles for the injectable ports. Nothing here touches the disk or the network.

const encoder = new TextEncoder();

function underneath(key: string, dir: string): boolean {
  return key.startsWith(`${dir}\\`) || key.startsWith(`${dir}/`);
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

export interface MemoryFs extends FsPort {
  readonly files: Map<string, Uint8Array>;
  readonly dirs: Set<string>;
}

export function createMemoryFs(): MemoryFs {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const has = (path: string): boolean =>
    files.has(path) ||
    dirs.has(path) ||
    [...files.keys()].some((key) => underneath(key, path)) ||
    [...dirs].some((key) => underneath(key, path));
  return {
    files,
    dirs,
    exists: async (path) => has(path),
    readText: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw enoent(path);
      return new TextDecoder().decode(bytes);
    },
    readBytes: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw enoent(path);
      return bytes;
    },
    writeFile: async (path, data) => {
      files.set(path, typeof data === "string" ? encoder.encode(data) : data);
    },
    mkdirp: async (path) => {
      dirs.add(path);
    },
    rename: async (from, to) => {
      const move = (key: string): string => to + key.slice(from.length);
      for (const [key, bytes] of [...files]) {
        if (key === from || underneath(key, from)) {
          files.delete(key);
          files.set(move(key), bytes);
        }
      }
      for (const key of [...dirs]) {
        if (key === from || underneath(key, from)) {
          dirs.delete(key);
          dirs.add(move(key));
        }
      }
    },
    remove: async (path) => {
      for (const key of [...files.keys()])
        if (key === path || underneath(key, path)) files.delete(key);
      for (const key of [...dirs]) if (key === path || underneath(key, path)) dirs.delete(key);
    },
  };
}

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
}

export interface FakeExec extends ExecPort {
  readonly calls: ExecCall[];
  // Exit code of the bundled npm install; the default simulates a successful install of Pi 1.2.0.
  npmExitCode: number;
}

// Simulates the binaries the installer runs: tar extracts a fake Node tree, node --version reports the
// pinned version, and npm-cli.js writes the Pi package. The path separator follows the platform ops.
export function createFakeExec(fs: MemoryFs, ops: PlatformPath): FakeExec {
  const calls: ExecCall[] = [];
  const fake: FakeExec = {
    calls,
    npmExitCode: 0,
    run: async (file, args, options): Promise<ExecResult> => {
      calls.push({ file, args, options });
      if (file.endsWith("tar.exe") || file === "tar") return extract(fs, ops, args);
      if (args[0] === "--version") {
        return fs.files.has(file)
          ? { exitCode: 0, stdout: "v24.22.0\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "missing" };
      }
      if (args[0]?.endsWith("npm-cli.js") === true && args.includes("install")) {
        if (fake.npmExitCode !== 0)
          return { exitCode: fake.npmExitCode, stdout: "", stderr: "boom" };
        const prefix = args[args.indexOf("--prefix") + 1] ?? "";
        const pkgDir = ops.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
        fs.files.set(
          ops.join(pkgDir, "package.json"),
          encoder.encode(
            JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.0" }),
          ),
        );
        fs.files.set(ops.join(pkgDir, "dist", "bundle", "cli.js"), encoder.encode("// cli"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 127, stdout: "", stderr: `unexpected ${file}` };
    },
  };
  return fake;
}

function extract(fs: MemoryFs, ops: PlatformPath, args: readonly string[]): ExecResult {
  const archive = args[args.indexOf("-xf") + 1] ?? "";
  const target = args[args.indexOf("-C") + 1] ?? "";
  if (!fs.files.has(archive)) return { exitCode: 1, stdout: "", stderr: "no archive" };
  const archiveName = archive.split(/[\\/]/).at(-1) ?? "";
  const dirName = archiveName.replace(/\.(zip|tar\.xz|tar\.gz)$/, "");
  const binary = archiveName.includes("-win-") ? "node.exe" : "bin/node";
  const root = ops.join(target, dirName);
  fs.files.set(ops.join(root, ...binary.split("/")), encoder.encode("fake node"));
  fs.files.set(
    ops.join(root, "node_modules", "npm", "bin", "npm-cli.js"),
    encoder.encode("// npm"),
  );
  fs.files.set(
    ops.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    encoder.encode("// npm"),
  );
  return { exitCode: 0, stdout: "", stderr: "" };
}

export interface FakeFetch extends FetchPort {
  readonly calls: string[];
}

// `failures` makes the first N calls for a URL reject, to exercise the single retry.
export function createFakeFetch(
  responses: Readonly<Record<string, Uint8Array>>,
  failures: Readonly<Record<string, number>> = {},
): FakeFetch {
  const calls: string[] = [];
  const remaining: Record<string, number> = { ...failures };
  return {
    calls,
    get: async (url) => {
      calls.push(url);
      const pending = remaining[url] ?? 0;
      if (pending > 0) {
        remaining[url] = pending - 1;
        throw new Error(`network error for ${url}`);
      }
      const bytes = responses[url];
      if (bytes === undefined) throw new Error(`HTTP 404 for ${url}`);
      return bytes;
    },
  };
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const ZIP_NAME = "node-v24.22.0-win-x64.zip";
export const ZIP_BYTES = encoder.encode("zip bytes of the fake archive");
export const RELEASE = "https://nodejs.org/dist/v24.22.0/";
const NOW = "2026-10-16T00:00:00.000Z";

export function shasumsFor(bytes: Uint8Array, name = ZIP_NAME): Uint8Array {
  return encoder.encode(`${sha256Of(bytes)}  ${name}\n`);
}

export function installDeps(
  overrides: Partial<InstallDeps> & Pick<InstallDeps, "fs" | "exec" | "fetch">,
): InstallDeps {
  return {
    root: "C:\\HARIL",
    platform: "win32",
    arch: "x64",
    env: { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", HARIL_CLIPROXYAPI_KEY: "secret-key-7f" },
    now: () => NOW,
    ...overrides,
  };
}
