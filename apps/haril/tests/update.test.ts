import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UpdateServices, update } from "../src/commands/update.js";
import type { CliIo, HostInfo } from "../src/context.js";

let sandbox: string;
let source: string;
let root: string;
let host: HostInfo;
let out: string[];
let err: string[];
let io: CliIo;
let install = vi.fn(async (_script: string, _root: string, _source: string): Promise<number> => 0);
let confirm = vi.fn(async (): Promise<boolean> => true);
let runtime: { state: "none" | "active" | "unknown"; detail?: string };
let checkoutMain = vi.fn(async () => ({ source: "", revision: "", cleanup: () => undefined }));
let cleanup = vi.fn();
let services: UpdateServices;

function manifest(version: string): void {
  writeFileSync(join(source, "apps", "haril", "package.json"), JSON.stringify({ version }));
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "haril-update-"));
  source = join(sandbox, "checkout");
  root = join(sandbox, "installed");
  mkdirSync(join(source, "apps", "haril"), { recursive: true });
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(source, "scripts", "install.mjs"), "// harmless fixture\n");
  manifest("0.21.1");
  writeFileSync(join(root, "app", "current.json"), JSON.stringify({ version: "0.21.0" }));
  out = [];
  err = [];
  io = { out: (line) => out.push(line), err: (line) => err.push(line), readFile: () => "" };
  host = {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: sandbox,
    cwd: source,
    env: { HARIL_RUNTIME_DIR: root },
  };
  install = vi.fn(async (_script: string, _root: string, _source: string): Promise<number> => 0);
  confirm = vi.fn(async () => true);
  runtime = { state: "none" };
  cleanup = vi.fn();
  checkoutMain = vi.fn(async () => ({ source, revision: "a".repeat(40), cleanup }));
  services = {
    readText: (path) => readFileSync(path, "utf8"),
    exists: (path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    },
    activeRuntime: () => runtime,
    install,
    confirm,
    checkoutMain,
  };
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("haril update (local verified source only)", () => {
  it("--check compares versions without executing the installer", async () => {
    expect(await update(["--check"], io, host, services)).toBe(0);
    expect(out.join(" ")).toContain("0.21.0; local source: 0.21.1");
    expect(out.join(" ")).toContain("installed files were not changed");
    expect(install).not.toHaveBeenCalled();
  });

  it("--yes invokes the repository installer only when a newer source is present", async () => {
    expect(await update(["--yes", "--from", source], io, host, services)).toBe(0);
    expect(install).toHaveBeenCalledWith(join(source, "scripts", "install.mjs"), root, source);
  });

  it("refuses to update while a runtime is active or its state is unknown", async () => {
    runtime = { state: "active", detail: "pid 123" };
    expect(await update(["--yes"], io, host, services)).toBe(2);
    expect(err.join(" ")).toContain("runtime is active");
    runtime = { state: "unknown", detail: "database is locked" };
    expect(await update(["--yes"], io, host, services)).toBe(2);
    expect(err.join(" ")).toContain("could not be checked");
    expect(install).not.toHaveBeenCalled();
  });

  it("does not perform a downgrade or reinstall an equal version", async () => {
    manifest("0.20.9");
    expect(await update(["--yes"], io, host, services)).toBe(2);
    manifest("0.21.0");
    expect(await update(["--yes"], io, host, services)).toBe(0);
    expect(out.join(" ")).toContain("already at");
    expect(install).not.toHaveBeenCalled();
  });

  it("requires confirmation for interactive updates and --yes otherwise", async () => {
    expect(await update([], io, host, services)).toBe(2);
    expect(install).not.toHaveBeenCalled();
    expect(await update([], io, { ...host, interactive: true }, services)).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
  });

  it("does not install when the interactive user declines", async () => {
    confirm.mockResolvedValue(false);
    expect(await update([], io, { ...host, interactive: true }, services)).toBe(0);
    expect(out.join(" ")).toContain("cancelled");
    expect(install).not.toHaveBeenCalled();
  });

  it("reports an installer failure and does not claim success", async () => {
    install.mockResolvedValue(1);
    expect(await update(["--yes"], io, host, services)).toBe(1);
    expect(err.join(" ")).toContain("installer failed");
    expect(out.join(" ")).not.toContain("completed");
  });

  it("refuses an absent source and missing install record", async () => {
    expect(await update(["--check", "--from", join(sandbox, "missing")], io, host, services)).toBe(
      2,
    );
    rmSync(join(root, "app", "current.json"));
    expect(await update(["--check"], io, host, services)).toBe(2);
    expect(install).not.toHaveBeenCalled();
  });

  it("checks pinned GitHub main without installing or touching the local checkout", async () => {
    expect(await update(["--main", "--check"], io, host, services)).toBe(0);
    expect(checkoutMain).toHaveBeenCalledOnce();
    expect(out.join(" ")).toContain("GitHub main: 0.21.1");
    expect(out.join(" ")).toContain("a".repeat(40));
    expect(install).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("installs from isolated GitHub main only after opt-in and cleans its checkout", async () => {
    expect(await update(["--main", "--yes"], io, host, services)).toBe(0);
    expect(install).toHaveBeenCalledWith(join(source, "scripts", "install.mjs"), root, source);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(out.join(" ")).toContain("GitHub main");
  });

  it("rejects combining --main and --from without cloning", async () => {
    expect(await update(["--main", "--from", source], io, host, services)).toBe(2);
    expect(checkoutMain).not.toHaveBeenCalled();
  });

  it("refuses unsupported flags and incomplete --from values", async () => {
    expect(await update(["--rollback"], io, host, services)).toBe(2);
    expect(await update(["--from"], io, host, services)).toBe(2);
    expect(install).not.toHaveBeenCalled();
  });
});
