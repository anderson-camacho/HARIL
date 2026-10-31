import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { Clock } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
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

// `haril events --since | --from | --to`: the time range of the event log, with the same parsing as `haril usage log`.
// Five events one hour apart for the project "demo"; "now" is two hours after the last one.
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);
const RULES = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

let sb: Sandbox;
let h: Harness;
let now: number;

function clockAt(): Clock {
  return { now: () => now, schedule: () => () => undefined };
}

// Events at T0, T0+1h, ... T0+4h, named e0..e4 by their aggregate id.
function seed(): void {
  let counter = 0;
  const store = openStore({
    dataDir: sb.dataDir,
    clock: clockAt(),
    ids: { next: () => `seed-${String(++counter).padStart(4, "0")}` },
    rules: RULES,
  });
  try {
    now = T0 - HOUR;
    const projectId = store.projects.register({
      slug: "demo",
      name: "Demo",
      rootPath: projectRoot(sb, "demo"),
    }).projectId;
    for (let index = 0; index < 5; index++) {
      store.events.append({
        aggregateType: "task",
        aggregateId: `e${index}`,
        type: index % 2 === 0 ? "task.failed" : "task.completed",
        actorKind: "system",
        actorId: "test",
        payload: {},
        projectId,
        ts: T0 + index * HOUR,
      });
    }
  } finally {
    store.close();
  }
  now = T0 + 6 * HOUR;
}

beforeEach(() => {
  sb = makeSandbox();
  now = T0 + 6 * HOUR;
  sb = { ...sb, host: { ...sb.host, clock: clockAt() } };
});

afterEach(() => {
  sb.cleanup();
});

async function invoke(args: string[]): Promise<number> {
  h = harness();
  return await run(args, h.io, sb.host);
}

// The aggregate ids (e0..e4) of the events `haril events` printed, oldest first, project registration left out.
async function listed(args: string[]): Promise<string[]> {
  expect(await invoke(["events", "--project", "demo", "--json", ...args])).toBe(0);
  return parseJson<{ aggregateId: string }[]>(h.out)
    .map((event) => event.aggregateId)
    .filter((id) => /^e\d$/.test(id));
}

describe("haril events time range", () => {
  it("--since is measured back from the injected clock", async () => {
    seed();
    // now = T0 + 6h: the last 3h start at T0 + 3h, so only e3 (T0+3h, inclusive) and e4.
    expect(await listed(["--since", "3h"])).toEqual(["e3", "e4"]);
    expect(await listed(["--since", "2h"])).toEqual(["e4"]);
    expect(await listed(["--since", "90m"])).toEqual([]);
    expect(await listed(["--since", "1d"])).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    now = T0 + 4 * HOUR + 30 * 60_000;
    expect(await listed(["--since", "1h"])).toEqual(["e4"]);
  });

  it("--from is inclusive and --to exclusive, as ISO times or epoch milliseconds", async () => {
    seed();
    expect(await listed(["--from", "2026-10-30T09:00:00Z"])).toEqual(["e1", "e2", "e3", "e4"]);
    expect(await listed(["--to", "2026-10-30T11:00:00Z"])).toEqual(["e0", "e1", "e2"]);
    expect(await listed(["--from", "2026-10-30T09:00:00Z", "--to", String(T0 + 3 * HOUR)])).toEqual(
      ["e1", "e2"],
    );
  });

  it("combines the range with --limit, which keeps the newest events in the range", async () => {
    seed();
    expect(await listed(["--from", String(T0 + HOUR), "--limit", "2"])).toEqual(["e3", "e4"]);
  });

  it("applies to the text output too, and leaves the JSON shape as it was", async () => {
    seed();
    expect(await invoke(["events", "--project", "demo", "--from", String(T0 + 4 * HOUR)])).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toMatch(/^\d+ 2026-10-30T12:00:00\.000Z task\.failed task:e4 -$/);
    expect(await invoke(["events", "--project", "demo", "--since", "3h", "--json"])).toBe(0);
    const [first] = parseJson<Record<string, unknown>[]>(h.out);
    expect(Object.keys(first ?? {})).toEqual([
      "seq",
      "time",
      "type",
      "aggregateType",
      "aggregateId",
      "projectId",
      "taskId",
      "runId",
      "payload",
    ]);
  });

  it("an empty range prints nothing and exits 0; JSON prints an empty array", async () => {
    seed();
    expect(await invoke(["events", "--project", "demo", "--from", "2027-01-01"])).toBe(0);
    expect(h.out).toEqual([]);
    expect(await invoke(["events", "--project", "demo", "--from", "2027-01-01", "--json"])).toBe(0);
    expect(parseJson(h.out)).toEqual([]);
  });

  it("refuses --since with --from or --to, a bad value and a reversed range with exit 2", async () => {
    seed();
    for (const args of [
      ["--since", "2h", "--from", "2026-10-30"],
      ["--since", "2h", "--to", "2026-10-30"],
      ["--since", "2x"],
      ["--since", "yesterday"],
      ["--from", "yesterday"],
      ["--to", "soon"],
      ["--from", "2026-10-30T10:00:00Z", "--to", "2026-10-30T09:00:00Z"],
      ["--from", "2026-10-30T10:00:00Z", "--to", "2026-10-30T10:00:00Z"],
    ]) {
      expect(await invoke(["events", ...args]), args.join(" ")).toBe(2);
      expect(h.err.join("\n"), args.join(" ")).toMatch(/^haril: /);
      expect(h.out).toEqual([]);
    }
  });

  it("names the problem so the caller can show it", async () => {
    seed();
    await invoke(["events", "--since", "2h", "--from", "2026-10-30"]);
    expect(h.err.join("\n")).toContain("either --since or --from/--to");
    await invoke(["events", "--from", "2026-10-30T10:00:00Z", "--to", "2026-10-30T09:00:00Z"]);
    expect(h.err.join("\n")).toContain("--from must be before --to");
  });

  it("does not take --before, which only `haril usage` knows", async () => {
    seed();
    expect(await invoke(["events", "--before", "2026-10-30"])).toBe(2);
    expect(h.err.join("\n")).toContain('unknown option "--before"');
  });

  it("the help text lists the range flags", async () => {
    expect(await invoke(["help"])).toBe(0);
    const help = h.out.join("\n");
    expect(help).toContain("haril events [--project <slug>]");
    expect(help).toContain("[--since <duration> | --from <time> --to <time>]");
  });
});
