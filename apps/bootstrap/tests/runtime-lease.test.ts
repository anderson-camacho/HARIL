import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { realFs } from "../src/real.js";

// Criterion 15 (M3-T6b): uninstall refuses while a runtime holds an active, unexpired lease whose pid is alive.
// It only reads haril.db and never touches data/, config/, logs/, runtime/, vendor/ or a project's .haril/.

let root: string;
const KEPT = ["data", "config", "logs", "runtime", "vendor", join(".haril")];
const DEAD_PID = 2_000_000_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-uninstall-"));
  for (const entry of KEPT) {
    mkdirSync(join(root, entry), { recursive: true });
    writeFileSync(join(root, entry, "keep.txt"), "must survive");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLease(dataDir: string, pid: number, expiresAt: number, status = "active"): void {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "haril.db"));
  db.exec(
    "CREATE TABLE runtime_leases (runtime_epoch INTEGER PRIMARY KEY, status TEXT NOT NULL, pid INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO runtime_leases (status, pid, expires_at) VALUES (?, ?, ?)").run(
    status,
    pid,
    expiresAt,
  );
  db.close();
}

async function uninstall(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  // Uninstall never runs a process or fetches; any call here would be a bug.
  const notUsed = async (): Promise<never> => {
    throw new Error("uninstall must not run processes or fetch");
  };
  const exitCode = await runCli(
    ["uninstall", "--root", root],
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    {
      platform: process.platform,
      arch: "x64",
      env,
      homeDir: root,
      cwd: root,
      fs: realFs,
      exec: { run: notUsed },
      fetch: { get: notUsed },
      now: () => "2026-10-16T00:00:00.000Z",
    },
  );
  return { exitCode, out, err };
}

function expectKept(): void {
  for (const entry of KEPT) {
    expect(existsSync(join(root, entry, "keep.txt")), `${entry} was touched`).toBe(true);
  }
}

describe("uninstall and the active runtime lease (criterion 15)", () => {
  it("refuses with exit 2 while a live runtime holds an unexpired lease", async () => {
    writeLease(join(root, "data"), process.pid, Date.now() + 60_000);
    const result = await uninstall();
    expect(result.exitCode).toBe(2);
    expect(result.err.join("\n")).toMatch(/runtime is active/);
    expect(existsSync(join(root, "data", "haril.db"))).toBe(true);
    expectKept();
  });

  it("uses HARIL_HOME as the data directory when it is set", async () => {
    const home = join(root, "custom-home");
    writeLease(home, process.pid, Date.now() + 60_000);
    const result = await uninstall({ HARIL_HOME: home });
    expect(result.exitCode).toBe(2);
    expectKept();
  });

  it("proceeds when the lease has expired", async () => {
    writeLease(join(root, "data"), process.pid, Date.now() - 1_000);
    const result = await uninstall();
    expect(result.exitCode).toBe(0);
    expectKept();
  });

  it("proceeds when the lease holder is no longer alive", async () => {
    writeLease(join(root, "data"), DEAD_PID, Date.now() + 60_000);
    const result = await uninstall();
    expect(result.exitCode).toBe(0);
    expectKept();
  });

  it("proceeds when the lease was released", async () => {
    writeLease(join(root, "data"), process.pid, Date.now() + 60_000, "released");
    const result = await uninstall();
    expect(result.exitCode).toBe(0);
    expectKept();
  });

  it("proceeds when there is no store yet", async () => {
    const result = await uninstall();
    expect(result.exitCode).toBe(0);
    expectKept();
  });
});
