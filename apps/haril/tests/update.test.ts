import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    env: { HARIL_RUNTIME_DIR: root, HARIL_SOURCE_DIR: source },
  };
  // The real installer writes the record of what it installed, and update verifies it.
  install = vi.fn(async (_script: string, _root: string, _source: string): Promise<number> => {
    const manifest = JSON.parse(
      readFileSync(join(source, "apps", "haril", "package.json"), "utf8"),
    ) as { version: string };
    const record = JSON.parse(readFileSync(join(root, "app", "current.json"), "utf8")) as object;
    writeFileSync(
      join(root, "app", "current.json"),
      JSON.stringify({ ...record, version: manifest.version }),
    );
    return 0;
  });
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
    verifyBinary: vi.fn(async () => true),
    install,
    confirm,
    checkoutMain,
    toolVersions: async () => ({ engram: "1.2.3", "gentle-ai": null }),
    writeLog: () => "/logs/update.log",
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

  it("repairs a missing managed Matrix dependency even if the core version is current", async () => {
    manifest("0.21.0");
    writeFileSync(join(source, "scripts", "install-visual-tools.mjs"), "// fixture\n");
    expect(await update(["--check"], io, host, services)).toBe(0);
    expect(out.join(" ")).toContain("Matrix dependency needs repair");
    expect(install).not.toHaveBeenCalled();

    // The repair only counts once the tools verify: here the installer put them in place.
    const before = services.exists;
    services = {
      ...services,
      exists: (path) => before(path) || install.mock.calls.length > 0,
    };
    expect(await update(["--yes"], io, host, services)).toBe(0);
    expect(install).toHaveBeenCalledOnce();
    expect(out.join(" ")).toContain("dependencias reparadas");

    install.mockClear();
    host = { ...host, env: { ...host.env, HARIL_AUTO_INSTALL_VISUALS: "off" } };
    expect(await update(["--yes"], io, host, services)).toBe(0);
    expect(install).not.toHaveBeenCalled();
  });

  it("checks executable health even if the installed HARIL version is current", async () => {
    manifest("0.21.0");
    writeFileSync(join(source, "scripts", "install-visual-tools.mjs"), "// fixture\n");
    host = { ...host, platform: process.platform };
    const uv = join(root, "tools", "uv", process.platform === "win32" ? "uv.exe" : "uv");
    const tte = join(root, "tools", "bin", process.platform === "win32" ? "tte.exe" : "tte");
    mkdirSync(join(root, "tools", "uv"), { recursive: true });
    mkdirSync(join(root, "tools", "bin"), { recursive: true });
    writeFileSync(uv, "uv fixture");
    writeFileSync(tte, "tte fixture");
    services = {
      ...services,
      // Broken until the installer ran.
      verifyBinary: vi.fn(async (path) => path !== tte || install.mock.calls.length > 0),
    };

    expect(await update(["--check"], io, host, services)).toBe(0);
    expect(out.join(" ")).toContain("Matrix dependency needs repair (Matrix)");
    expect(install).not.toHaveBeenCalled();
    expect(await update(["--yes"], io, host, services)).toBe(0);
    expect(install).toHaveBeenCalledOnce();
  });

  it("does not reinstall verified tools when the selected version is current", async () => {
    manifest("0.21.0");
    writeFileSync(join(source, "scripts", "install-visual-tools.mjs"), "// fixture\n");
    host = { ...host, platform: process.platform };
    for (const path of [
      join(root, "tools", "uv", process.platform === "win32" ? "uv.exe" : "uv"),
      join(root, "tools", "bin", process.platform === "win32" ? "tte.exe" : "tte"),
    ]) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "version fixture");
    }
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

  describe("the install log", () => {
    const all = () => out.join("\n");

    it("says ✓ only after verifying the installed version", async () => {
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(0);
      expect(all()).toContain("ok: HARIL");
      expect(all()).toContain("Instalado y verificado");
    });

    it("fails when the installer says yes but the version did not change", async () => {
      install.mockResolvedValue(0);
      const restored: string[] = [];
      services = { ...services, restore: () => void restored.push("yes") };
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(1);
      expect(all()).toContain("fallo: HARIL");
      expect(restored).toEqual(["yes"]);
      expect(all()).toContain("se restauró la versión anterior");
      expect(all()).not.toContain("ok: HARIL");
    });

    it("rolls back and keeps going when HARIL fails midway", async () => {
      install.mockResolvedValue(3);
      const restored: unknown[] = [];
      services = {
        ...services,
        snapshot: () => [{ path: "x", bytes: Buffer.from("y") }],
        restore: (_root, snapshot) => void restored.push(snapshot.length),
      };
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(1);
      expect(restored).toEqual([1]);
      expect(all()).toContain("ok: Engram 1.2.3");
      expect(all()).toContain("Qué hacer:");
    });

    it("gives no ✓ to a repair whose tool still fails its verification", async () => {
      manifest("0.21.0");
      writeFileSync(join(source, "scripts", "install-visual-tools.mjs"), "// fixture\n");
      const verifyBinary = vi.fn(async () => false);
      services = { ...services, verifyBinary };
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(1);
      expect(install).toHaveBeenCalledOnce();
      expect(all()).toContain("fallo: HARIL");
      expect(all()).toContain("Matrix");
      expect(all()).not.toContain("ok: HARIL");
      expect(all()).not.toContain("dependencias reparadas");
    });

    it("gives its ✓ once the repaired tools verify", async () => {
      manifest("0.21.0");
      writeFileSync(join(source, "scripts", "install-visual-tools.mjs"), "// fixture\n");
      const before = services.exists;
      services = {
        ...services,
        exists: (path) => before(path) || install.mock.calls.length > 0,
        verifyBinary: vi.fn(async () => install.mock.calls.length > 0),
      };
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(0);
      expect(all()).toContain("ok: HARIL");
    });

    it("takes the launchers back and removes the ones the failed install added", async () => {
      const bin = join(root, "bin");
      mkdirSync(join(bin, "folder"), { recursive: true });
      writeFileSync(join(bin, "haril"), "old launcher");
      install.mockImplementation(async () => {
        writeFileSync(join(bin, "haril"), "new launcher");
        writeFileSync(join(bin, "added"), "new file");
        writeFileSync(join(root, "app", "current.json"), JSON.stringify({ version: "0.21.1" }));
        return 3;
      });
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(1);
      expect(readFileSync(join(bin, "haril"), "utf8")).toBe("old launcher");
      expect(existsSync(join(bin, "added"))).toBe(false);
      expect(existsSync(join(bin, "folder"))).toBe(true);
      expect(JSON.parse(readFileSync(join(root, "app", "current.json"), "utf8")).version).toBe(
        "0.21.0",
      );
      expect(all()).toContain("se restauró la versión anterior");
    });

    it("says the rollback was partial when it could not put everything back", async () => {
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "haril"), "old launcher");
      install.mockImplementation(async () => {
        rmSync(bin, { recursive: true });
        writeFileSync(bin, "a file where the folder was");
        return 3;
      });
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(1);
      expect(all()).not.toContain("se restauró la versión anterior");
      expect(all()).toContain("parcial");
      expect(all()).toContain("haril");
    });

    it("does not claim a rollback when the record still names the new version", async () => {
      install.mockImplementation(async () => {
        writeFileSync(join(root, "app", "current.json"), JSON.stringify({ version: "0.21.1" }));
        return 3;
      });
      services = { ...services, restore: () => undefined };
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(1);
      expect(all()).not.toContain("se restauró la versión anterior");
      expect(all()).toContain("parcial");
    });

    it("says what the rollback does not cover", async () => {
      install.mockResolvedValue(3);
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(1);
      expect(all()).toContain("no se deshace");
    });

    it("never gives a ✓ to what HARIL does not manage", async () => {
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(0);
      for (const name of ["Skills", "MCP", "Plantillas"]) {
        expect(all()).toContain(`fuera: ${name}: No lo gestiona HARIL`);
      }
      expect(all()).not.toContain("ok: Skills");
      expect(all()).toContain("aviso: Gentle AI");
      expect(all()).toContain("haril tools update gentle-ai");
    });

    it("gives the log path, and draws the frame on a terminal", async () => {
      expect(await update(["--yes", "--from", source], io, host, services)).toBe(0);
      expect(all()).toContain("Registro: /logs/update.log");
      out.length = 0;
      writeFileSync(join(root, "app", "current.json"), JSON.stringify({ version: "0.21.0" }));
      expect(
        await update(["--yes", "--from", source], io, { ...host, interactive: true }, services),
      ).toBe(0);
      expect(all()).toContain("╭─");
      expect(all()).toContain("$ ");
      expect(all()).toContain("100%");
    });
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

  it("uses GitHub main by default, without requiring a local repository", async () => {
    host = { ...host, cwd: sandbox, env: { HARIL_RUNTIME_DIR: root } };
    expect(await update(["--check"], io, host, services)).toBe(0);
    expect(checkoutMain).toHaveBeenCalledOnce();
    expect(out.join(" ")).toContain("GitHub main: 0.21.1");
    expect(install).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("installs GitHub main with the simple update --yes command", async () => {
    host = { ...host, cwd: sandbox, env: { HARIL_RUNTIME_DIR: root } };
    expect(await update(["--yes"], io, host, services)).toBe(0);
    expect(checkoutMain).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(join(source, "scripts", "install.mjs"), root, source);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports GitHub failures clearly and never starts the installer", async () => {
    host = { ...host, cwd: sandbox, env: { HARIL_RUNTIME_DIR: root } };
    checkoutMain.mockRejectedValue(new Error("git timed out after 90s"));
    expect(await update(["--yes"], io, host, services)).toBe(1);
    expect(err.join(" ")).toContain("git timed out");
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
