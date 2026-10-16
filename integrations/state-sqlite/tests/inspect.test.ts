import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectStore, openStore } from "../src/index.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds } from "./support.js";

// inspectStore backs `haril doctor`: it must describe the store without creating anything.
let dir = "";

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

describe("inspectStore (read-only)", () => {
  it("reports not initialized and creates nothing when the database is missing", () => {
    const target = join(dir, "not-yet");
    const report = inspectStore({ dataDir: target });
    expect(report.initialized).toBe(false);
    expect(report.schemaVersion).toBeNull();
    expect(report.dbPath).toBe(join(target, "haril.db"));
    expect(report.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(target)).toBe(false);
  });

  it("reports the schema version of an initialized database", () => {
    openStore({ dataDir: dir, clock: fixedClock(), ids: sequentialIds() }).close();
    const report = inspectStore({ dataDir: dir });
    expect(report.initialized).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.error).toBeUndefined();
    expect(report.gates.every((gate) => gate.status !== "error")).toBe(true);
  });

  it("reports an error gate for a SQLite below 3.51.3 without touching the database", () => {
    const report = inspectStore({ dataDir: dir, runtime: { sqliteVersion: "3.50.7" } });
    expect(report.gates.find((gate) => gate.name === "sqlite")?.status).toBe("error");
  });
});
