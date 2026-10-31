import { describe, expect, it } from "vitest";
import { type ActivityHost, createActivityPanel } from "../src/activity-panel.js";
import { ALL_RANGE } from "../src/activity-range.js";
import { ACTIVITY_ACTIONS } from "../src/activity-view.js";
import type { CliResult } from "../src/cli.js";

// What the console does for the ACT tab besides drawing it: it holds the range for the session, reloads the events
// when a button changes it, asks for a range of its own in one question, and says what went wrong in a notice. The
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

// The words the notice says when the dialog opens: where to type, since Pi draws the box in the editor's place.
const HINT_ES = "Escribe el rango en el cuadro de abajo (Esc cancela).";
const HINT_EN = "Type the range in the box below (Esc cancels).";

const chipsOf = (
  details: { cards?: readonly { chips?: readonly { label: string }[] }[] } | undefined,
) => details?.cards?.[0]?.chips?.map((chip) => chip.label);

describe("«Rango…»", () => {
  it("asks ONE question and filters by the two instants of «desde .. hasta»", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.answers = ["2026-10-30T08:00:00Z .. 2026-10-30T12:00:00Z"];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.asked).toHaveLength(1);
    expect(state.asked[0]?.[0]).toBe("Actividad · rango (ej. 3h, 2d, 29/10 08:00 .. 29/10 12:00)");
    expect(state.asked[0]?.[1]).toBe("3h, 2d, 29/10 08:00 .. 29/10 12:00");
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

  it("reads the dates as the Filtro card writes them", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.answers = ["29/10 08:00 .. 29/10 12:00"];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(panel.range()).toEqual({
      kind: "custom",
      from: new Date(2026, 9, 29, 8).getTime(),
      to: new Date(2026, 9, 29, 12).getTime(),
    });
    expect(state.notes.some(([, level]) => level === "warning")).toBe(false);
  });

  it("takes a duration as the last N, and «desde ..» with nothing after as until now", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.answers = ["3h"];
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
    state.answers = ["2d .. 1h"];
    state.runs.length = 0;
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs[0]?.slice(5)).toEqual([
      "--from",
      new Date(NOW - 48 * HOUR).toISOString(),
      "--to",
      new Date(NOW - HOUR).toISOString(),
      "--json",
    ]);
    state.answers = ["29/10 08:00 .."];
    state.runs.length = 0;
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs[0]?.slice(5)).toEqual([
      "--from",
      new Date(2026, 9, 29, 8).toISOString(),
      "--json",
    ]);
    expect(panel.range()).toEqual({ kind: "custom", from: new Date(2026, 9, 29, 8).getTime() });
  });

  it("asks in English, with the date order of English, when the interface is in English", async () => {
    const state = setup();
    state.locale = "en";
    const panel = open(state);
    await panel.load();
    state.answers = ["10/29 08:00 .."];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.asked).toEqual([
      [
        "Activity · range (e.g. 3h, 2d, 10/29 08:00 .. 10/29 12:00)",
        "3h, 2d, 10/29 08:00 .. 10/29 12:00",
      ],
    ]);
    expect(panel.range()).toEqual({ kind: "custom", from: new Date(2026, 9, 29, 8).getTime() });
    expect(text(panel.view())).toContain("→ now");
    expect(state.notes[0]).toEqual([HINT_EN, "info"]);
  });

  it.each([
    ["not a time", "ayer", "«Desde»"],
    ["an end that is not a time", "3h .. mañana", "«Hasta»"],
    ["an end before the start", "1h .. 3h", "anterior"],
    ["too many dots", "3h .. 1h .. 30m", "Demasiados"],
  ])("leaves the range as it was and warns when it gets %s", async (_name, answer, words) => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    await panel.act(ACTIVITY_ACTIONS.hour);
    state.runs.length = 0;
    state.notes.length = 0;
    state.answers = [answer];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs).toEqual([]);
    expect(panel.range()).toEqual({ kind: "hour" });
    // The notice that says where to type, then the one that says what could not be read.
    expect(state.notes).toHaveLength(2);
    expect(state.notes[0]).toEqual([HINT_ES, "info"]);
    expect(state.notes[1]?.[1]).toBe("warning");
    expect(state.notes[1]?.[0]).toContain(words);
    expect(panel.waiting()).toBe(false);
  });

  it.each([
    ["is cancelled", [undefined]],
    ["is left empty", [""]],
    ["is only blanks", ["   "]],
  ])("changes nothing, and warns of nothing, when the dialog %s", async (_name, answers) => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.notes.length = 0;
    state.answers = [...answers];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs).toEqual([]);
    // Only the notice that said where to type: no warning, no error.
    expect(state.notes).toEqual([[HINT_ES, "info"]]);
    expect(panel.range()).toEqual(ALL_RANGE);
    expect(panel.waiting()).toBe(false);
  });

  it("shows the «Rango» chip as waiting while the dialog is open, and says where to type", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    expect(chipsOf(panel.view())).toEqual(["1h", "1d", "Rango", "Todo"]);
    let answer: ((value: string | undefined) => void) | undefined;
    state.input = () => new Promise<string | undefined>((resolve) => (answer = resolve));
    state.repaints.count = 0;
    state.notes.length = 0;
    const asking = panel.act(ACTIVITY_ACTIONS.range);
    // At once: the tab was drawn again with the chip waiting, and the notice named the box.
    expect(panel.waiting()).toBe(true);
    expect(state.repaints.count).toBe(1);
    expect(chipsOf(panel.view())).toEqual(["1h", "1d", "Espera", "Todo"]);
    expect(state.notes).toEqual([[HINT_ES, "info"]]);
    // Waiting for an answer is not reading the events: the buttons stay.
    expect(panel.busy()).toBe(false);
    expect(text(panel.view())).not.toContain("Cargando");
    answer?.(undefined);
    await asking;
    expect(panel.waiting()).toBe(false);
    expect(state.repaints.count).toBe(2);
    expect(chipsOf(panel.view())).toEqual(["1h", "1d", "Rango", "Todo"]);
  });

  it("tells again where to type when the button is pressed while the dialog is open, and opens no second one", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    let answer: ((value: string | undefined) => void) | undefined;
    state.input = () => new Promise<string | undefined>((resolve) => (answer = resolve));
    state.notes.length = 0;
    const first = panel.act(ACTIVITY_ACTIONS.range);
    await panel.act(ACTIVITY_ACTIONS.range);
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.asked).toHaveLength(1);
    expect(state.notes).toEqual([
      [HINT_ES, "info"],
      [HINT_ES, "info"],
      [HINT_ES, "info"],
    ]);
    expect(panel.waiting()).toBe(true);
    answer?.(undefined);
    await first;
    expect(panel.range()).toEqual(ALL_RANGE);
    // Once it is closed, the button opens it again.
    state.input = undefined;
    state.answers = [undefined];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.asked).toHaveLength(2);
  });

  it("shows an error notice, never silence, when the input dialog rejects", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.notes.length = 0;
    state.input = async () => {
      throw new Error("no editor to host the box");
    };
    await expect(panel.act(ACTIVITY_ACTIONS.range)).resolves.toBeUndefined();
    expect(state.runs).toEqual([]);
    expect(panel.range()).toEqual(ALL_RANGE);
    expect(state.notes).toEqual([
      [HINT_ES, "info"],
      ["No se pudo abrir el cuadro del rango: no editor to host the box", "error"],
    ]);
    // The chip is back, and the button works again.
    expect(panel.waiting()).toBe(false);
    expect(chipsOf(panel.view())).toEqual(["1h", "1d", "Rango", "Todo"]);
    state.input = undefined;
    state.answers = ["1h"];
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(panel.range()).toEqual({ kind: "custom", from: NOW - HOUR });
  });

  it("shows an error notice when the dialog throws before it even asks, and in English", async () => {
    const state = setup();
    state.locale = "en";
    const panel = open(state);
    await panel.load();
    state.notes.length = 0;
    state.input = () => {
      throw new TypeError("ui.input is not a function");
    };
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.notes.at(-1)).toEqual([
      "Could not open the range box: ui.input is not a function",
      "error",
    ]);
    expect(panel.waiting()).toBe(false);
  });

  it("does nothing without a session to ask in", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    state.runs.length = 0;
    state.hasUi = false;
    await panel.act(ACTIVITY_ACTIONS.range);
    expect(state.runs).toEqual([]);
    expect(panel.waiting()).toBe(false);
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
    state.notes.length = 0;
    let answer: ((value: string | undefined) => void) | undefined;
    state.input = () => new Promise<string | undefined>((resolve) => (answer = resolve));
    const asking = panel.act(ACTIVITY_ACTIONS.range);
    panel.reset();
    expect(panel.waiting()).toBe(false);
    answer?.("yesterday");
    await asking;
    expect(state.runs).toEqual([]);
    // Only the notice of the session that opened it: the answer said nothing in the next one.
    expect(state.notes).toEqual([[HINT_ES, "info"]]);
    expect(panel.range()).toEqual(ALL_RANGE);
    expect(panel.waiting()).toBe(false);
  });

  it("does not let a dialog of the ended session close the waiting state of the next one", async () => {
    const state = setup();
    const panel = open(state);
    await panel.load();
    let old: ((value: string | undefined) => void) | undefined;
    state.input = () => new Promise<string | undefined>((resolve) => (old = resolve));
    const first = panel.act(ACTIVITY_ACTIONS.range);
    panel.reset();
    await panel.load();
    let current: ((value: string | undefined) => void) | undefined;
    state.input = () => new Promise<string | undefined>((resolve) => (current = resolve));
    const second = panel.act(ACTIVITY_ACTIONS.range);
    expect(panel.waiting()).toBe(true);
    old?.(undefined);
    await first;
    // The old dialog closing is not the new one closing.
    expect(panel.waiting()).toBe(true);
    current?.(undefined);
    await second;
    expect(panel.waiting()).toBe(false);
  });
});
