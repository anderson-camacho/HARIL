import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExecPort, FetchPort, FsPort } from "./ports.js";

// Real adapters for the composition root (main.ts). Tests never use these.

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export const realFs: FsPort = {
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  readText: (path) => readFile(path, "utf8"),
  readBytes: async (path) => new Uint8Array(await readFile(path)),
  readDir: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
    })),
  writeFile: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  },
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true });
  },
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { recursive: true, force: true }),
};

// Runs the file directly, never through a shell. A child that cannot start reports exit code 1.
export const realExec: ExecPort = {
  run: (file, args, options) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        {
          env: { ...options.env },
          timeout: options.timeoutMs,
          windowsHide: true,
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          const code = typeof error.code === "number" ? error.code : 1;
          resolve({ exitCode: code, stdout, stderr: stderr || error.message });
        },
      );
    }),
};

export const realFetch: FetchPort = {
  get: async (url, timeoutMs) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return new Uint8Array(await response.arrayBuffer());
  },
};
