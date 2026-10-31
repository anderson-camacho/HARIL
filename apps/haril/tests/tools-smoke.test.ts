import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engramSmoke, type SmokeInput } from "../src/tools/smoke.js";

// The fake `engram` executable of the memory-engram tests: `node fake-engram.mjs serve`. It answers like Engram 3.4.0.
const FAKE = fileURLToPath(
  new URL("../../../integrations/memory-engram/testing/fake-engram.mjs", import.meta.url),
);

describe("the real health smoke of a candidate Engram", () => {
  let work: string;
  let children: ChildProcess[];
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "haril-smoke-"));
    children = [];
  });
  afterEach(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
  });

  function input(scenario: string, over: Partial<SmokeInput> = {}): SmokeInput {
    return {
      binary: { path: process.execPath, leadingArgs: [FAKE, `--scenario=${scenario}`] },
      version: "3.4.0",
      workDir: work,
      homeDir: work,
      env: process.env,
      platform: process.platform,
      readinessMs: 8000,
      spawn: (command, args, options) => {
        const child = spawn(command, [...args], options);
        children.push(child);
        return child;
      },
      ...over,
    };
  }

  const stopped = async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && children.some((child) => child.exitCode === null)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return children.every((child) => child.exitCode !== null || child.signalCode !== null);
  };

  it("passes when the serve proves its identity and answers a real read", async () => {
    const result = await engramSmoke(input("ok"));
    expect(result).toEqual({ ok: true });
  }, 30000);

  it("stops the process it started and deletes its temporary data dir after success", async () => {
    await engramSmoke(input("ok"));
    expect(children).toHaveLength(1);
    expect(await stopped()).toBe(true);
    expect(existsSync(join(work, "data"))).toBe(false);
  }, 30000);

  it("fails, stops the process and cleans up when the serve is another instance", async () => {
    const result = await engramSmoke(input("wrong_instance"));
    expect(result).toMatchObject({ ok: false });
    expect(await stopped()).toBe(true);
    expect(existsSync(join(work, "data"))).toBe(false);
  }, 30000);

  it("fails when the serve exits before it is ready", async () => {
    const result = await engramSmoke(input("exit0"));
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("exited");
    expect(existsSync(join(work, "data"))).toBe(false);
  }, 30000);

  it("fails with a readiness deadline and kills a serve that never listens", async () => {
    const result = await engramSmoke(input("never_ready", { readinessMs: 600 }));
    expect(result).toMatchObject({ ok: false });
    expect(await stopped()).toBe(true);
    expect(existsSync(join(work, "data"))).toBe(false);
  }, 30000);

  it("fails when health is not active with a real read, naming the state", async () => {
    // The adapter pinned to 3.6.0 asks the fake (which is 3.4.0) for a version it is not.
    const result = await engramSmoke(input("ok", { version: "3.6.0" }));
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("degraded");
    expect(await stopped()).toBe(true);
    expect(existsSync(join(work, "data"))).toBe(false);
  }, 30000);

  it("fails without launching anything when the binary does not exist", async () => {
    const result = await engramSmoke(
      input("ok", { binary: { path: join(work, "nowhere", "engram") } }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(children).toHaveLength(0);
  }, 30000);

  it("never leaves anything but the caller's own folder behind", async () => {
    await engramSmoke(input("ok"));
    expect(readdirSync(work)).toEqual([]);
  }, 30000);
});
