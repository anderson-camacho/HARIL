import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
} from "./helpers.js";

// `haril status` (M1-T4): read-only; never creates the database.
let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
  h = harness();
});

afterEach(() => {
  sb.cleanup();
});

interface StatusJson {
  initialized: boolean;
  dataDir: string;
  projects: { projectId: string; slug: string; rootPath: string }[];
  tasks: { total: number; byState: Record<string, number> };
  taskList: unknown[];
  queuedCommands: { commandId: string; type: string; projectId: string | null; args: unknown }[];
  runtime: { status: string };
}

describe("haril status", () => {
  it("on a missing database says not initialized and creates neither directory nor file", () => {
    expect(run(["status"], h.io, sb.host)).toBe(0);
    expect(h.out.join("\n")).toContain("not initialized");
    expect(existsSync(sb.dataDir)).toBe(false);

    const json = harness();
    expect(run(["status", "--json"], json.io, sb.host)).toBe(0);
    expect(parseJson<{ initialized: boolean }>(json.out).initialized).toBe(false);
    expect(existsSync(join(sb.dataDir, "haril.db"))).toBe(false);
  });

  it("prints the JSON shape: projects, task counts by state, task list, queue and runtime", () => {
    run(
      ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--yes"],
      harness().io,
      sb.host,
    );
    run(["task", "add", "Write README"], harness().io, sb.host);

    expect(run(["status", "--json"], h.io, sb.host)).toBe(0);
    const status = parseJson<StatusJson>(h.out);
    expect(Object.keys(status).sort()).toEqual(
      [
        "dataDir",
        "initialized",
        "projects",
        "queuedCommands",
        "runtime",
        "taskList",
        "tasks",
      ].sort(),
    );
    expect(status.initialized).toBe(true);
    expect(status.projects).toHaveLength(1);
    expect(status.projects[0]).toMatchObject({ slug: "demo", rootPath: projectRoot(sb, "demo") });
    expect(status.tasks.total).toBe(0);
    expect(status.tasks.byState).toEqual({
      pending: 0,
      ready: 0,
      running: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    });
    expect(status.taskList).toEqual([]);
    expect(status.queuedCommands.map((command) => command.type)).toEqual(["task.create"]);
    expect(status.runtime).toEqual({ status: "none" });
  });

  it("prints a text summary with the queued command and the runtime state", () => {
    run(
      ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--yes"],
      harness().io,
      sb.host,
    );
    run(["task", "add", "Write README"], harness().io, sb.host);

    expect(run(["status"], h.io, sb.host)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("demo");
    expect(text).toContain("task.create");
    expect(text).toContain("runtime");
    expect(text).toContain("none");
  });

  it("with --project shows only that project's queue", () => {
    run(
      ["project", "init", projectRoot(sb, "alpha"), "--name", "Alpha", "--yes"],
      harness().io,
      sb.host,
    );
    run(
      ["project", "init", projectRoot(sb, "beta"), "--name", "Beta", "--yes"],
      harness().io,
      sb.host,
    );
    run(["task", "add", "For alpha", "--project", "alpha"], harness().io, sb.host);

    const json = harness();
    expect(run(["status", "--json", "--project", "beta"], json.io, sb.host)).toBe(0);
    const status = parseJson<StatusJson>(json.out);
    expect(status.projects.map((project) => project.slug)).toEqual(["beta"]);
    expect(status.queuedCommands).toEqual([]);
  });

  it("exits 2 for an unknown --project", () => {
    run(
      ["project", "init", projectRoot(sb, "alpha"), "--name", "Alpha", "--yes"],
      harness().io,
      sb.host,
    );
    expect(run(["status", "--project", "ghost"], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("ghost");
  });
});
