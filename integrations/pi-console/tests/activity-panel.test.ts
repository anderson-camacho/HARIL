import { describe, expect, it } from "vitest";
import { type ActivityHost, createActivityPanel } from "../src/activity-panel.js";
import { ALL_RANGE } from "../src/activity-range.js";
import { ACTIVITY_ACTIONS } from "../src/activity-view.js";
import type { CliResult } from "../src/cli.js";

// What the console does for the ACT tab besides drawing it: it holds the range for the session, reloads the events
// when a button changes it, asks for a range of its own in two questions, and says what went wrong in a notice. The
// host here is a fake: nothing runs a command or opens a dialog.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 30, 20, 15, 0);

const events = (count: number): string =>
  JSON.stringify(
    Array.from({ length: count }, (_unused, index) => ({
      seq: index + 1,
      type: index % 2 === 0 ? "task.started" : "task.failed",
      time: new Date(NOW - (count - index) * 60_000).toISOString(),
    })),
  );

const ok = (stdout: string): CliResult => ({ ok: true, code: 0, stdout, stderr: "" });

interface Setup {
  readonly host: ActivityHost;
  readonly runs: (readonly string[])[];
  readonly notes: [string, string | undefined][];
  readonly asked: [string, string | undefined][];
  readonly repaints: { count: number };
  // The answers the next dialogs give, in order; undefined is a cancelled question.
  answers: (string | undefined)[];
  // What each command answers, in order (the last one repeats).
  replies: (CliResult | Promise<CliResult> | Error)[];
  slug: string | undefined;
  locale: "es" | "en";
  hasUi: boolean;
  // Replaces the queue of answers: the dialog waits on this instead.
  input: ((title: string, placeholder?: string) => Promise<string | undefined>) | undefined;
}

function setup(): Setup {
  const state: Setup = {
    runs: [],
    notes: [],
    asked: [],
    repaints: { count: 0 },
    answers: [],
    replies: [ok(events(2))],
    slug: "demo",
    locale: "es",
    hasUi: true,
    input: undefined,
    host: undefined as unknown as ActivityHost,
  };
  let reply = 0;
  const host: ActivityHost = {
    run: async (args) => {
      state.runs.push(args);
      const next = state.replies[Math.min(reply++, state.replies.length - 1)];
      if (next instanceof Error) throw next;
      return await (next as CliResult | Promise<CliResult>);
    },
    locale: () => state.locale,
    projectSlug: () => state.slug,
    now: () => NOW,
    ui: () =>
      state.hasUi
        ? {
            input: async (title, placeholder) => {
              state.asked.push([title, placeholder]);
              return state.input === undefined
                ? state.answers.shift()
                : await state.input(title, placeholder);
            },
            notify: (message, level) => state.notes.push([message, level]),
          }
        : undefined,
    repaint: () => {
      state.repaints.count++;
    },
  };
  Object.assign(state, { host });
  return state;
}

const open = (state: Setup) => createActivityPanel(state.host);

const text = (details: { lines: readonly string[] } | undefined): string =>
  (details?.lines ?? []).join("\n");

describe("loading the tab", () => {
  it("asks for the project's newest events in every range, and draws them", async () => {
    const state = setup();
    const panel = open(state);
    const details = await panel.load();
    expect(state.runs).toEqual([["events", "--project", "demo", "--limit", "50", "--json"]]);
    expect(panel.range()).toEqual(ALL_RANGE);
    expect(details.id).toBe("activity");
    expect(text(details)).toContain("Actividad · 2");
    expect(text(details)).toContain("Todo");
    expect(panel.busy()).toBe(false);
    // What was loaded is what the tab draws again when only its state changes.
    expect(panel.view()).toEqual(details);
  });

  it("has no view before a load", () => {
    expect(open(setup()).view()).toBeUndefined();
  });

  it("runs nothing for a folder that is no project, and says so", async () => {
    const state = setup();
    state.slug = undefined;
    const details = await open(state).load();
    expect(state.runs).toEqual([]);
    expect(text(details)).toContain("Sin proyecto registrado");
  });

  it("shows a failed command inside the tab and does not throw", async () => {
    const state = setup();
    state.replies = [{ ok: false, code: 2, stdout: "", stderr: "haril: store not initialized\n" }];
    const details = await open(state).load();
    expect(text(details)).toContain("Actividad · no disponible");
    expect(text(details)).toContain("store not initialized");
    state.replies = [new Error("spawn EPERM")];
    const rejected = await open(state).load();
    expect(text(rejected)).toContain("spawn EPERM");
  });
});

describe("the buttons that choose a range", () => {
  it.each([
    [ACTIVITY_ACTIONS.hour, { kind: "hour" }, ["--since", "1h"], "Última hora"],
    [ACTIVITY_ACTIONS.day, { kind: "day" }, ["--since", "1d"], "Último día"],
  ] as const)(
    "%s keeps the range and asks the command for it",
    async (action, range, flags, words) => {
      const state = setup();
      const panel = open(state);
      await panel.load();
      state.runs.length = 0;
      await panel.act(action);
      expect(panel.range()).toEqual(range);
      expect(state.runs).toEqual([
        ["events", "--project", "demo", "--limit", "50", ...flags, "--json"],
      ]);
      expect(text(panel.view())).toContain(words);
    },
  );

  it("«Todo» goes back to every event", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    await panel.act(ACTIVITY_ACTIONS.hour);
    state.runs.length = 0;
    await panel.act(ACTIVITY_ACTIONS.all);
    expect(panel.range()).toEqual(ALL_RANGE);
    expect(state.runs).toEqual([["events", "--project", "demo", "--limit", "50", "--json"]]);
  });

  it("«Actualizar» reads again with the range it has", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    await panel.act(ACTIVITY_ACTIONS.day);
    state.runs.length = 0;
    await panel.act(ACTIVITY_ACTIONS.refresh);
    expect(state.runs).toEqual([
      ["events", "--project", "demo", "--limit", "50", "--since", "1d", "--json"],
    ]);
    expect(panel.range()).toEqual({ kind: "day" });
  });

  it("shows «Cargando…» while the events are read, and the buttons and the new events after", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    let release: ((value: CliResult) => void) | undefined;
    state.replies = [new Promise<CliResult>((resolve) => (release = resolve))];
    state.repaints.count = 0;
    const acting = panel.act(ACTIVITY_ACTIONS.hour);
    // The tab was drawn again at once, busy, with the events it already had.
    expect(state.repaints.count).toBe(1);
    expect(panel.busy()).toBe(true);
    expect(text(panel.view())).toContain("… Cargando…");
    expect(text(panel.view())).not.toContain("▸ Rango…");
    expect(text(panel.view())).toContain("Actividad · 2");
    release?.(ok(events(3)));
    await acting;
    expect(panel.busy()).toBe(false);
    expect(state.repaints.count).toBe(2);
    expect(text(panel.view())).toContain("▸ Rango…");
    expect(text(panel.view())).not.toContain("Cargando");
    expect(text(panel.view())).toContain("Actividad · 3");
  });

  it("shows a failure of the reload inside the tab, with the buttons back, and does not throw", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.replies = [
      { ok: false, code: 2, stdout: "", stderr: "haril: --since takes a duration\n" },
    ];
    await panel.act(ACTIVITY_ACTIONS.hour);
    expect(panel.busy()).toBe(false);
    expect(text(panel.view())).toContain("Actividad · no disponible");
    expect(text(panel.view())).toContain("--since takes a duration");
    expect(text(panel.view())).toContain("▸ Última hora");
    state.replies = [new Error("boom")];
    await expect(panel.act(ACTIVITY_ACTIONS.refresh)).resolves.toBeUndefined();
    expect(panel.busy()).toBe(false);
  });

  it("lets the latest read win when two are in flight", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    let slow: ((value: CliResult) => void) | undefined;
    state.replies = [new Promise<CliResult>((resolve) => (slow = resolve)), ok(events(5))];
    const first = panel.act(ACTIVITY_ACTIONS.hour);
    await panel.act(ACTIVITY_ACTIONS.day);
    slow?.(ok(events(1)));
    await first;
    expect(panel.range()).toEqual({ kind: "day" });
    expect(text(panel.view())).toContain("Actividad · 5");
    expect(panel.busy()).toBe(false);
  });

  it("ignores an action it does not know", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    await panel.act("tools:ensure");
    expect(state.runs).toEqual([]);
    expect(state.repaints.count).toBe(0);
  });
});

describe("«Rango…»", () => {
  it("asks twice, from and to, and filters by the instants it was given", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.answers = ["2026-10-30T08:00:00Z", "2026-10-30T12:00:00Z"];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.asked).toHaveLength(2);
    expect(state.asked[0]?.[0]).toBe("Actividad · desde (3h, 2d o fecha ISO)");
    expect(state.asked[1]?.[0]).toBe("Actividad · hasta (vacío = ahora)");
    expect(state.runs).toEqual([
      [
        "events",
        "--project",
        "demo",
        "--limit",
        "50",
        "--from",
        "2026-10-30T08:00:00.000Z",
        "--to",
        "2026-10-30T12:00:00.000Z",
        "--json",
      ],
    ]);
    expect(panel.range()).toEqual({
      kind: "custom",
      from: Date.UTC(2026, 9, 30, 8),
      to: Date.UTC(2026, 9, 30, 12),
    });
    expect(text(panel.view())).toContain("Rango: ");
  });

  it("takes durations, counted back from now, and an empty end as now", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.answers = ["3h", ""];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs).toEqual([
      [
        "events",
        "--project",
        "demo",
        "--limit",
        "50",
        "--from",
        new Date(NOW - 3 * HOUR).toISOString(),
        "--json",
      ],
    ]);
    expect(panel.range()).toEqual({ kind: "custom", from: NOW - 3 * HOUR });
    expect(text(panel.view())).toContain("→ ahora");
    state.answers = ["2d", "1h"];
    state.runs.length = 0;
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs[0]?.slice(5)).toEqual([
      "--from",
      new Date(NOW - 48 * HOUR).toISOString(),
      "--to",
      new Date(NOW - HOUR).toISOString(),
      "--json",
    ]);
  });

  it("asks in English when the interface is in English", async () => {
    const state = setup();
    state.locale = "en";
    const panel = open(state);
    await panel.load();
    state.answers = ["3h", ""];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.asked.map(([title]) => title)).toEqual([
      "Activity · from (3h, 2d or an ISO date)",
      "Activity · to (empty = now)",
    ]);
    expect(text(panel.view())).toContain("→ now");
  });

  it.each([
    ["not a time", ["ayer", ""], "«Desde»"],
    ["an end that is not a time", ["3h", "mañana"], "«Hasta»"],
    ["an end before the start", ["1h", "3h"], "anterior"],
  ])("leaves the range as it was and says why when it gets %s", async (_name, answers, words) => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    await panel.act(ACTIVITY_ACTIONS.hour);
    state.runs.length = 0;
    state.repaints.count = 0;
    state.answers = [...answers];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs).toEqual([]);
    expect(state.repaints.count).toBe(0);
    expect(panel.range()).toEqual({ kind: "hour" });
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]?.[1]).toBe("warning");
    expect(state.notes[0]?.[0]).toContain(words);
  });

  it.each([
    ["is cancelled at the first question", [undefined]],
    ["is left empty", ["", "1h"]],
    ["is only blanks", ["   ", "1h"]],
    ["is cancelled at the second question", ["3h", undefined]],
  ])("changes nothing, and says nothing, when the dialog %s", async (_name, answers) => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.answers = [...answers];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs).toEqual([]);
    expect(state.notes).toEqual([]);
    expect(panel.range()).toEqual(ALL_RANGE);
  });

  it("opens one dialog even if the button is pressed twice", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    let answer: ((value: string | undefined) => void) | undefined;
    state.input = () => new Promise<string | undefined>((resolve) => (answer = resolve));
    const first = panel.act(ACTIVITY_ACTIONS.range);
    await panel.act(ACTIVITY_ACTIONS.range);
    // The second press found the dialog open and asked nothing.
    expect(state.asked).toHaveLength(1);
    answer?.(undefined);
    await first;
    expect(panel.range()).toEqual(ALL_RANGE);
    // Once it is closed, the button opens it again.
    state.input = undefined;
    state.answers = [undefined];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.asked).toHaveLength(2);
  });

  it("does nothing without a session to ask in", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.hasUi = false;
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs).toEqual([]);
  });
});

describe("the range belongs to the session", () => {
  it("goes back to every event when the session ends, and drops what was still being read", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    await panel.act(ACTIVITY_ACTIONS.day);
    let slow: ((value: CliResult) => void) | undefined;
    state.replies = [new Promise<CliResult>((resolve) => (slow = resolve))];
    const reading = panel.act(ACTIVITY_ACTIONS.refresh);
    panel.reset();
    expect(panel.range()).toEqual(ALL_RANGE);
    expect(panel.view()).toBeUndefined();
    expect(panel.busy()).toBe(false);
    slow?.(ok(events(4)));
    await reading;
    expect(panel.view()).toBeUndefined();
    expect(panel.busy()).toBe(false);
  });

  it("drops an answer to a dialog that was open when the session ended", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    let answer: ((value: string | undefined) => void) | undefined;
    state.input = () => new Promise<string | undefined>((resolve) => (answer = resolve));
    const asking = panel.act(ACTIVITY_ACTIONS.range);
    panel.reset();
    answer?.("yesterday");
    await asking;
    expect(state.runs).toEqual([]);
    expect(state.notes).toEqual([]);
    expect(panel.range()).toEqual(ALL_RANGE);
  });
});
