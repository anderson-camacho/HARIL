import { readFileSync, writeFileSync } from "node:fs";
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

  it("ends the list with how to read a plan (LD-T7c)", () => {
    propose();
    const out = fresh();
    expect(run(["approvals"], out.io, sb.host)).toBe(0);
    expect(out.out.at(-1)).toBe("haril approvals show <id> to read a plan");
  });
});

// LD-T7c: approving from the CLI was blind (a count and a model). `approvals show` prints the plan the way the shell's
// plan review does, every field the runtime applies; --json prints the approval with its plan for machines.
describe("haril approvals show", () => {
  function shown(id: string, args: string[] = [], host = sb.host): Harness {
    const out = fresh();
    expect(run(["approvals", "show", id, ...args], out.io, host)).toBe(0);
    return out;
  }

  it("prints the header and every field of every task of a requested plan", () => {
    const id = propose();
    const lines = shown(id).out;
    expect(lines[0]).toBe(`approval ${id}`);
    expect(lines[1]).toBe("project demo, kind plan, status requested, model none, 4 tasks");
    expect(lines[2]).toMatch(/^requested by cli at \d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(lines.join("\n")).not.toContain("decided");
    expect(lines).toEqual(
      expect.arrayContaining([
        "1. survey-readme: Survey the README structure",
        "   agent developer-block, depends on: none",
        "   description: List the headings of README.md and note where a new section fits.",
        "   writes: none; reads: README.md",
        "   kind work, priority 0, attempts 2, timeout 120000 ms",
        "   budget: 20000 tokens, 120000 ms wall time, 0 cost micros",
        "   requires: none; context: none",
        "   acceptance: none",
        "3. insert-section: Insert the section into README.md",
        "   agent developer-block, depends on: draft-section",
        "   writes: README.md; reads: README.md",
      ]),
    );
  });

  it("--json prints the approval with its plan", () => {
    const id = propose();
    const view = parseJson<Record<string, unknown>>(shown(id, ["--json"]).out);
    expect(view).toMatchObject({
      approvalId: id,
      projectSlug: "demo",
      kind: "plan",
      status: "requested",
      tasks: 4,
      model: null,
      requestedBy: "cli",
      decidedBy: null,
      reason: null,
    });
    expect(view.plan).toEqual(JSON.parse(readFileSync(EXAMPLE_VALID, "utf8")));
  });

  it("shows the decision of a decided plan, in text and in JSON", () => {
    const id = propose();
    expect(run(["deny", id, "--reason", "not now"], fresh().io, operator())).toBe(0);
    const text = shown(id).out;
    expect(text[1]).toBe("project demo, kind plan, status denied, model none, 4 tasks");
    expect(text[3]).toMatch(/^decided by tester at \d{4}-\d\d-\d\dT[\d:.]+Z: not now$/);
    expect(parseJson(shown(id, ["--json"]).out)).toMatchObject({
      status: "denied",
      decidedBy: "tester",
      reason: "not now",
    });
  });

  it("exits 2 for an unknown id, and with usage without one", () => {
    propose();
    const missing = fresh();
    expect(run(["approvals", "show", "missing"], missing.io, sb.host)).toBe(2);
    expect(missing.err.join("\n")).toContain('no approval with id "missing"');
    const bare = fresh();
    expect(run(["approvals", "show"], bare.io, sb.host)).toBe(2);
    expect(bare.err.join("\n")).toContain("usage: haril approvals show <approvalId>");
  });

  // Control sequences (clear screen, OSC 52 clipboard), a right-to-left override and tag characters in a plan's goal
  // and description show as "?" in text, so an approver reads what the screen draws; JSON keeps them for machines.
  it("shows hostile text in a plan as ? in text and keeps it intact in JSON", () => {
    const goal = "Survey\x1b]52;c;ZmFrZS1jbGlw\x07 the\u{202E}README\u{E0041}\u{E007F}";
    const description = "Read it\x1b[2J.\nThen report\u{200B} back.";
    const plan = JSON.parse(readFileSync(EXAMPLE_VALID, "utf8")) as {
      tasks: { goal: string; description: string }[];
    };
    const [first] = plan.tasks;
    if (first === undefined) throw new Error("the example plan has no task");
    first.goal = goal;
    first.description = description;
    const file = join(sb.root, "hostile-plan.json");
    writeFileSync(file, JSON.stringify(plan), "utf8");
    const id = propose(file);

    const text = shown(id).out.join("\n");
    expect(text).toContain("1. survey-readme: Survey?]52;c;ZmFrZS1jbGlw? the?README??");
    expect(text).toContain("   description: Read it?[2J.\n     Then report? back.");
    for (const hidden of ["\x1b", "\x07", "\u{202E}", "\u{E0041}", "\u{E007F}", "\u{200B}"]) {
      expect(text).not.toContain(hidden);
    }
    const json = parseJson<{ plan: { tasks: { goal: string; description: string }[] } }>(
      shown(id, ["--json"]).out,
    );
    expect(json.plan.tasks[0]).toMatchObject({ goal, description });
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
