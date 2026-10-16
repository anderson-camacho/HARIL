import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// `haril plan import` (M1-T4): validates the plan (schema and graph) and queues plan.submit only when valid.
const EXAMPLE_VALID = fileURLToPath(new URL("../../../examples/plan.valid.json", import.meta.url));
const EXAMPLE_CYCLE = fileURLToPath(new URL("../../../examples/plan.cycle.json", import.meta.url));

let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
  h = harness();
  const init = harness();
  run(["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--yes"], init.io, sb.host);
});

afterEach(() => {
  sb.cleanup();
});

function queued(): { type: string; args: Record<string, unknown> }[] {
  const status = harness();
  run(["status", "--json"], status.io, sb.host);
  return parseJson<{ queuedCommands: { type: string; args: Record<string, unknown> }[] }>(
    status.out,
  ).queuedCommands;
}

describe("haril plan import", () => {
  it("validates the example plan and queues plan.submit with the plan payload", () => {
    expect(run(["plan", "import", EXAMPLE_VALID], h.io, sb.host)).toBe(0);
    expect(h.out.join("\n")).toContain("applied by `haril start`");
    const [command] = queued();
    expect(command?.type).toBe("plan.submit");
    const payload = (command?.args ?? {}) as { plan?: { tasks: unknown[] } };
    expect(payload.plan?.tasks).toHaveLength(4);
  });

  it("rejects a cycle with exit 1, prints the issue and queues nothing", () => {
    expect(run(["plan", "import", EXAMPLE_CYCLE], h.io, sb.host)).toBe(1);
    expect(h.out.join("\n")).toContain("[cycle]");
    expect(queued()).toHaveLength(0);
  });

  it("rejects a schema error with exit 1 and queues nothing", () => {
    const dir = join(sb.root, "plans");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks: [{ localId: "a" }] }));
    expect(run(["plan", "import", file], h.io, sb.host)).toBe(1);
    expect(h.out.join("\n")).toContain("INVALID");
    expect(queued()).toHaveLength(0);
  });

  it("exits 2 when the file cannot be read", () => {
    expect(run(["plan", "import", join(sb.root, "missing.json")], h.io, sb.host)).toBe(2);
    expect(queued()).toHaveLength(0);
  });

  it("exits 2 with usage when the file argument is missing", () => {
    expect(run(["plan", "import"], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("usage");
  });
});
