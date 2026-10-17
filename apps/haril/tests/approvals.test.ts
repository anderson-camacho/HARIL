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

// Approvals from the CLI (LD-T3, ARCH 4.3, 9.5): `plan propose` creates a requested approval, `approvals` lists them,
// `approve` and `deny` decide it once, and `run` applies a granted plan as a plan.submit. A decision is a declaration:
// decidedBy is the OS user name the CLI reports.
const EXAMPLE_VALID = fileURLToPath(new URL("../../../examples/plan.valid.json", import.meta.url));
const EXAMPLE_CYCLE = fileURLToPath(new URL("../../../examples/plan.cycle.json", import.meta.url));

let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
  const init = harness();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    init.io,
    sb.host,
  );
});

afterEach(() => {
  sb.cleanup();
});

// The host of the operator: the decision is recorded under this user name.
function operator() {
  return { ...sb.host, user: "tester" };
}

function fresh(): Harness {
  h = harness();
  return h;
}

// Proposes a plan file with --json and returns the approval id it printed.
function propose(file: string = EXAMPLE_VALID): string {
  const out = fresh();
  expect(run(["plan", "propose", file, "--json"], out.io, sb.host)).toBe(0);
  return parseJson<{ approvalId: string }>(out.out).approvalId;
}

interface ApprovalRow {
  readonly approvalId: string;
  readonly projectSlug: string;
  readonly kind: string;
  readonly status: string;
  readonly tasks: number;
  readonly model: string | null;
  readonly decidedBy: string | null;
  readonly reason: string | null;
  readonly appliedAt: number | null;
}

function listed(args: string[] = []): ApprovalRow[] {
  const out = fresh();
  expect(run(["approvals", "--json", ...args], out.io, sb.host)).toBe(0);
  return parseJson<ApprovalRow[]>(out.out);
}

function taskCount(): number {
  const out = fresh();
  run(["status", "--json"], out.io, sb.host);
  return parseJson<{ taskList: unknown[] }>(out.out).taskList.length;
}

describe("haril plan propose", () => {
  it("creates a pending approval for a valid plan and does not queue anything", () => {
    const out = fresh();
    expect(run(["plan", "propose", EXAMPLE_VALID], out.io, sb.host)).toBe(0);
    expect(out.out.join("\n")).toContain("pending");
    // A plan from the terminal names no model (LD-T7a): its tasks are created without one.
    expect(listed()).toMatchObject([
      { kind: "plan", status: "requested", tasks: 4, projectSlug: "demo", model: null },
    ]);
    expect(taskCount()).toBe(0);
  });

  it("rejects an invalid plan with exit 1, prints the issue and creates no approval", () => {
    const out = fresh();
    expect(run(["plan", "propose", EXAMPLE_CYCLE], out.io, sb.host)).toBe(1);
    expect(out.out.join("\n")).toContain("[cycle]");
    expect(listed()).toEqual([]);
  });

  it("exits 2 with usage when the file argument is missing", () => {
    expect(run(["plan", "propose"], fresh().io, sb.host)).toBe(2);
  });

  it("proposing the same plan twice gives the same pending approval", () => {
    expect(propose()).toBe(propose());
    expect(listed()).toHaveLength(1);
  });
});

describe("haril approvals", () => {
  it("prints a line per pending approval, and says so when there are none", () => {
    const empty = fresh();
    expect(run(["approvals"], empty.io, sb.host)).toBe(0);
    expect(empty.out.join("\n")).toContain("no pending approvals");

    const id = propose();
    const out = fresh();
    expect(run(["approvals"], out.io, sb.host)).toBe(0);
    const text = out.out.join("\n");
    expect(text).toContain(id);
    expect(text).toContain("demo");
    expect(text).toContain("plan");
    expect(text).toContain("model none");
  });

  it("exits 2 for an unknown project slug", () => {
    expect(run(["approvals", "--project", "nope"], fresh().io, sb.host)).toBe(2);
  });
});

describe("haril approve and haril deny", () => {
  it("approve records the decision, its reason and the operator, and run creates the plan's tasks", async () => {
    const id = propose();
    const out = fresh();
    expect(await run(["approve", id, "--reason", "looks right"], out.io, operator())).toBe(0);
    expect(listed(["--all"])[0]).toMatchObject({ decidedBy: "tester", reason: "looks right" });

    await run(["run"], fresh().io, sb.host);
    expect(taskCount()).toBe(4);
    expect(listed(["--all"])[0]?.appliedAt).not.toBeNull();
  });

  it("deny records the decision and run creates nothing", async () => {
    const id = propose();
    const out = fresh();
    expect(await run(["deny", id, "--reason", "not now"], out.io, operator())).toBe(0);
    expect(listed(["--all"])[0]).toMatchObject({ status: "denied", decidedBy: "tester" });

    await run(["run"], fresh().io, sb.host);
    expect(taskCount()).toBe(0);
    expect(listed(["--all"])[0]?.appliedAt).not.toBeNull();
  });

  it("a second decision is a conflict with exit 2", () => {
    const id = propose();
    expect(run(["deny", id], fresh().io, operator())).toBe(0);
    const out = fresh();
    expect(run(["approve", id], out.io, operator())).toBe(2);
    expect(out.err.join("\n")).toContain("was already denied");
  });

  it("an unknown approval id exits 2", () => {
    const out = fresh();
    expect(run(["approve", "missing"], out.io, operator())).toBe(2);
    expect(out.err.join("\n")).toContain("no approval");
  });

  it("without an id it exits 2 with usage", () => {
    const out = fresh();
    expect(run(["approve"], out.io, operator())).toBe(2);
    expect(out.err.join("\n")).toContain("usage");
  });
});
