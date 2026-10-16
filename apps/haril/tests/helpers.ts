import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo, HostInfo } from "../src/cli.js";

// Hermetic sandbox for command tests: a temporary HARIL data directory and project root, real SQLite.
export interface Sandbox {
  readonly root: string;
  readonly dataDir: string;
  readonly host: HostInfo;
  readonly cleanup: () => void;
}

export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "haril-cli-"));
  const dataDir = join(root, "data");
  const host: HostInfo = {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: root,
    cwd: root,
    env: { HARIL_HOME: dataDir },
  };
  return { root, dataDir, host, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A project root is a plain directory; `project init` creates `.haril/` inside it.
export function projectRoot(sandbox: Sandbox, name: string): string {
  const dir = join(sandbox.root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface Harness {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

// Captures every output line; files are read from the real filesystem.
export function harness(): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: (path) => readFileSync(path, "utf8"),
  };
  return { io, out, err };
}

// Parses the single JSON document printed by a `--json` run.
export function parseJson<T = unknown>(lines: readonly string[]): T {
  return JSON.parse(lines.join("\n")) as T;
}
