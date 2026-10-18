import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, run } from "../src/cli.js";

// Real filesystem: doctor must describe an existing store and must not create a missing one.
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-doctor-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: () => {
      throw new Error("not used");
    },
  };
  return { io, out, err };
}

// Node 24.21 keeps the Node check at "ok", so the exit code depends only on the store.
// The gateway probe is faked: this file covers the store, doctor-gateway.test.ts covers the gateway.
const host = (dataDir: string) => ({
  nodeVersion: "v24.21.0",
  platform: "linux",
  arch: "x64",
  homeDir: root,
  env: { HARIL_HOME: dataDir },
  providerProbe: async () => [
    {
      id: "cliproxy",
      url: "http://127.0.0.1:1/v1",
      key: "set" as const,
      status: "ok" as const,
      detail: "reachable, 0 models",
      models: [],
    },
  ],
});

describe("doctor with the real store inspection", () => {
  it("reports not initialized and creates neither the directory nor the database", async () => {
    const dataDir = join(root, "fresh", "data");
    const { io, out } = harness();
    expect(await run(["doctor"], io, host(dataDir))).toBe(0);
    expect(out.join("\n")).toContain("not initialized");
    expect(existsSync(dataDir)).toBe(false);
  });

  it("reports the schema of an initialized store (exit 0)", async () => {
    const dataDir = join(root, "data");
    let n = 0;
    openStore({
      dataDir,
      clock: { now: () => 1, schedule: () => () => undefined },
      ids: { next: () => `id-${++n}` },
      rules: {
        canTransition,
        checkPlan: checkPlanSubmission,
        checkAcceptance,
        checkTaskKind,
        canonicalJson,
      },
    }).close();

    const { io, out } = harness();
    expect(await run(["doctor", "--json"], io, host(dataDir))).toBe(0);
    const report = JSON.parse(out.join("\n")) as {
      status: string;
      store: { initialized: boolean; schemaVersion: number; status: string };
    };
    expect(report.store).toMatchObject({ initialized: true, schemaVersion: 13, status: "ok" });
    expect(report.status).toBe("ok");
  });
});
