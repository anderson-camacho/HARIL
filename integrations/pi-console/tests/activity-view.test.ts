import { describe, expect, it, vi } from "vitest";
import { type ActivityRange, ALL_RANGE, clockText } from "../src/activity-range.js";
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_LIMIT,
  type ActivityData,
  type ActivityEvent,
  activityArgs,
  activityRows,
  loadActivity,
  parseEvents,
} from "../src/activity-view.js";
import { NOT_LAUNCHED } from "../src/cli.js";
import { CARD_CONTENT_WIDTH, RAIL_BODY_WIDTH } from "../src/rail-metrics.js";
import { flatView, railHitAt, railRows } from "../src/rail-view.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The ACT tab: what it asks `haril events` for, what it reads from the answer, and the cards it makes of it.

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 30, 20, 15, 0);

function event(seq: number, type: string, minutesAgo: number): ActivityEvent {
  return { seq, type, at: NOW - minutesAgo * MINUTE };
}

const loaded = (events: readonly ActivityEvent[]): ActivityData => ({
  kind: "events",
  events,
  loadedAt: NOW,
});

const LOADED_AT = { loadedAt: NOW };

describe("activityArgs", () => {
  it("asks for the project's newest 50 events as JSON, and adds the range's flags before --json", () => {
    expect(ACTIVITY_LIMIT).toBe(50);
    expect(activityArgs("demo", ALL_RANGE)).toEqual([
      "events",
      "--project",
      "demo",
      "--limit",
      "50",
      "--json",
    ]);
    expect(activityArgs("demo", { kind: "hour" })).toEqual([
      "events",
      "--project",
      "demo",
      "--limit",
      "50",
      "--since",
      "1h",
      "--json",
    ]);
    expect(activityArgs("demo", { kind: "day" }).slice(5)).toEqual(["--since", "1d", "--json"]);
    const custom: ActivityRange = { kind: "custom", from: Date.UTC(2026, 9, 30, 8), to: NOW };
    expect(activityArgs("demo", custom).slice(5)).toEqual([
      "--from",
      "2026-10-30T08:00:00.000Z",
      "--to",
      "2026-10-30T20:15:00.000Z",
      "--json",
    ]);
  });
});

describe("parseEvents", () => {
  const row = (seq: unknown, type: unknown, time: unknown = "2026-10-30T20:12:00.000Z") => ({
    seq,
    type,
    time,
    aggregateType: "task",
    aggregateId: "t1",
    projectId: "p",
    taskId: null,
    runId: null,
    payload: {},
  });

  it("reads the events as `haril events --json` prints them, oldest first, with the time as milliseconds", () => {
    expect(
      parseEvents(
        JSON.stringify([row(1, "task.created"), row(2, "task.failed", "2026-10-30T20:13:00Z")]),
      ),
    ).toEqual([
      { seq: 1, type: "task.created", at: Date.UTC(2026, 9, 30, 20, 12) },
      { seq: 2, type: "task.failed", at: Date.UTC(2026, 9, 30, 20, 13) },
    ]);
    expect(parseEvents("[]")).toEqual([]);
  });

  it("skips an entry that is not an event and keeps one whose time it cannot read", () => {
    expect(
      parseEvents(JSON.stringify([row("1", "x"), row(2, 7), null, "text", row(3, "ok", "never")])),
    ).toEqual([{ seq: 3, type: "ok", at: undefined }]);
  });

  it("shows control characters of a type as the terminal would, never raw", () => {
    const [first] =
      parseEvents(JSON.stringify([row(1, "task.\u001b[31mred\u001b[0m\u0007")])) ?? [];
    expect(first?.type).toBe("task.red?");
  });

  it("has no answer for text that is not a JSON list", () => {
    for (const text of ["", "not json", "{}", '{"events":[]}', "null", "42"]) {
      expect(parseEvents(text), text).toBeUndefined();
    }
  });
});

describe("loadActivity", () => {
  const answer = (stdout: string, ok = true, stderr = "") => ({ ok, stdout, stderr });
  const list = JSON.stringify([
    { seq: 1, type: "task.created", time: "2026-10-30T20:00:00Z" },
    { seq: 2, type: "task.failed", time: "2026-10-30T20:10:00Z" },
  ]);

  it("runs the command for the project and range, and stamps the moment it read", async () => {
    const read = vi.fn(async (_args: readonly string[]) => answer(list));
    const data = await loadActivity(read, "demo", { kind: "hour" }, () => NOW, "es");
    expect(read).toHaveBeenCalledWith(activityArgs("demo", { kind: "hour" }));
    expect(data).toEqual({
      kind: "events",
      events: [
        { seq: 1, type: "task.created", at: Date.UTC(2026, 9, 30, 20, 0) },
        { seq: 2, type: "task.failed", at: Date.UTC(2026, 9, 30, 20, 10) },
      ],
      loadedAt: NOW,
    });
  });

  it("runs nothing when the folder is not a registered project", async () => {
    const read = vi.fn(async (_args: readonly string[]) => answer(list));
    expect(await loadActivity(read, undefined, ALL_RANGE, () => NOW, "es")).toEqual({
      kind: "none",
      ...LOADED_AT,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("takes the document when there is one, whatever the exit code", async () => {
    const data = await loadActivity(
      async () => answer(list, false, "warning"),
      "demo",
      ALL_RANGE,
      () => NOW,
      "es",
    );
    expect(data.kind).toBe("events");
  });

  it("says why there is no document: the lines the command wrote, plain, at most three", async () => {
    const data = await loadActivity(
      async () =>
        answer("", false, "\u001b[31mharil: store not initialized\u001b[0m\nsecond line\n"),
      "demo",
      ALL_RANGE,
      () => NOW,
      "es",
    );
    expect(data).toEqual({
      kind: "failed",
      reason: "haril: store not initialized\nsecond line",
      ...LOADED_AT,
    });
  });

  it("falls back to a sentence in the language when the command printed neither", async () => {
    const es = await loadActivity(
      async () => answer("", false),
      "demo",
      ALL_RANGE,
      () => NOW,
      "es",
    );
    expect(es).toMatchObject({ kind: "failed", reason: "Respuesta no válida de haril." });
    const en = await loadActivity(
      async () => answer("garbage"),
      "demo",
      ALL_RANGE,
      () => NOW,
      "en",
    );
    expect(en).toMatchObject({ kind: "failed", reason: "Invalid answer from haril." });
  });

  it("never rejects: a command that cannot run is a failed tab", async () => {
    const data = await loadActivity(
      async () => {
        throw new Error("spawn EPERM");
      },
      "demo",
      ALL_RANGE,
      () => NOW,
      "es",
    );
    expect(data).toEqual({ kind: "failed", reason: "spawn EPERM", ...LOADED_AT });
  });
});

describe("the cards of the tab", () => {
  const titles = (cards: { title: string }[]) => cards.map((card) => card.title);

  it("are the filter, the actions and the activity, in that order, with the count in the last title", () => {
    const { status, cards } = activityRows(
      loaded([
        event(373, "workflow.failed", 9),
        event(374, "task.cancelled", 5),
        event(375, "watchdog.closed", 3),
      ]),
      { locale: "es", range: ALL_RANGE, busy: false },
    );
    expect(status).toBe("Actividad");
    expect(titles(cards)).toEqual(["", "Actividad · 3"]);
    const english = activityRows(loaded([event(1, "a.b", 1)]), {
      locale: "en",
      range: ALL_RANGE,
      busy: false,
    });
    expect(english.status).toBe("Activity");
    expect(titles(english.cards)).toEqual(["", "Activity · 1"]);
  });

  it("name the range in words and the moment the events were read", () => {
    const filter = (range: ActivityRange, locale: "es" | "en" = "es") =>
      activityRows(loaded([]), { locale, range, busy: false }).cards[0]?.rows;
    expect(filter(ALL_RANGE)).toEqual(["Todo", `Actualizado ${clockText(NOW)}`]);
    expect(filter({ kind: "hour" })).toEqual([
      `Última hora (desde ${clockText(NOW - 60 * MINUTE)})`,
      `Actualizado ${clockText(NOW)}`,
    ]);
    expect(filter(ALL_RANGE, "en")).toEqual(["All", `Updated ${clockText(NOW)}`]);
  });

  it("list the newest event first, as «#seq type · age», with the age said in the language", () => {
    const events = [
      event(373, "workflow.failed", 130),
      event(374, "task.cancelled", 5),
      event(375, "watchdog.closed", 3),
    ];
    const es = activityRows(loaded(events), { locale: "es", range: ALL_RANGE, busy: false });
    expect(es.cards[1]?.rows).toEqual([
      "#375 watchdog.closed · hace 3 min",
      "#374 task.cancelled · hace 5 min",
      "#373 workflow.failed · hace 2 h",
    ]);
    const en = activityRows(loaded(events), { locale: "en", range: ALL_RANGE, busy: false });
    expect(en.cards[1]?.rows).toEqual([
      "#375 watchdog.closed · 3 min ago",
      "#374 task.cancelled · 5 min ago",
      "#373 workflow.failed · 2 h ago",
    ]);
  });

  it("say seconds and days too, and leave the age out of an event whose time is unknown", () => {
    const events: ActivityEvent[] = [
      { seq: 1, type: "a.b", at: NOW - 3 * 86_400_000 },
      { seq: 2, type: "a.b", at: NOW - 12_000 },
      { seq: 3, type: "a.b", at: undefined },
    ];
    const rows = activityRows(loaded(events), { locale: "es", range: ALL_RANGE, busy: false })
      .cards[1]?.rows;
    expect(rows).toEqual(["#3 a.b", "#2 a.b · hace 12 s", "#1 a.b · hace 3 d"]);
  });

  it("cut the type of an event that is too long, never its age, within the card's content", () => {
    const type = "workflow.node.verification.completed.with.a.very.long.name";
    const rows =
      activityRows(loaded([event(12345, type, 3)]), { locale: "es", range: ALL_RANGE, busy: false })
        .cards[1]?.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endsWith(" · hace 3 min")).toBe(true);
    expect(rows[0]).toContain("…");
    expect(rows[0]?.startsWith("#12345 workflow.no")).toBe(true);
    expect(textWidth(rows[0] ?? "")).toBe(CARD_CONTENT_WIDTH);
  });

  it("tint the events that went wrong and leave the others in the text tone", () => {
    const { cards } = activityRows(
      loaded([
        event(1, "task.started", 9),
        event(2, "workflow.failed", 8),
        event(3, "task.cancelled", 7),
        event(4, "gateway.error", 6),
        event(5, "watchdog.closed", 5),
      ]),
      { locale: "es", range: ALL_RANGE, busy: false },
    );
    // Newest first: 5 closed, 4 error, 3 cancelled, 2 failed, 1 started.
    expect(cards[1]?.tones).toEqual([undefined, "error", "error", "error", undefined]);
  });

  it("say so when there is nothing in the range, and keep the filter and the actions", () => {
    const es = activityRows(loaded([]), { locale: "es", range: { kind: "hour" }, busy: false });
    expect(titles(es.cards)).toEqual(["", "Actividad · 0"]);
    expect(es.cards[1]?.rows).toEqual(["Sin eventos en este rango."]);
    const en = activityRows(loaded([]), { locale: "en", range: ALL_RANGE, busy: false });
    expect(en.cards[1]?.rows).toEqual(["No events in this range."]);
  });

  it("note that only the newest 50 are shown when the list is as long as the limit", () => {
    const fifty = Array.from({ length: 50 }, (_unused, index) =>
      event(index + 1, "task.started", index),
    );
    const capped = activityRows(loaded(fifty), { locale: "es", range: ALL_RANGE, busy: false });
    expect(capped.cards[1]?.title).toBe("Actividad · 50");
    expect(capped.cards[1]?.rows).toHaveLength(51);
    expect(capped.cards[1]?.rows.at(-1)).toBe("Mostrando los últimos 50.");
    const english = activityRows(loaded(fifty), { locale: "en", range: ALL_RANGE, busy: false });
    expect(english.cards[1]?.rows.at(-1)).toBe("Showing the latest 50.");
    const forty = activityRows(loaded(fifty.slice(0, 49)), {
      locale: "es",
      range: ALL_RANGE,
      busy: false,
    });
    expect(forty.cards[1]?.rows.some((row) => row.startsWith("Mostrando"))).toBe(false);
  });

  it("show why the events could not be read, inside the card, in at most three short rows", () => {
    const reason =
      "haril: store not initialized (run haril project init <path> --name <name> --yes first) and more words to spare";
    const failed: ActivityData = { kind: "failed", reason, ...LOADED_AT };
    const { cards } = activityRows(failed, { locale: "es", range: ALL_RANGE, busy: false });
    expect(titles(cards)).toEqual(["", "Actividad · no disponible"]);
    const rows = cards[1]?.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    expect(rows.join(" ")).toContain("store not initialized");
    const english = activityRows(failed, { locale: "en", range: ALL_RANGE, busy: false });
    expect(english.cards[1]?.title).toBe("Activity · not available");
  });

  it("invite to register the folder when it is no project", () => {
    const none: ActivityData = { kind: "none", ...LOADED_AT };
    const { cards } = activityRows(none, { locale: "es", range: ALL_RANGE, busy: false });
    expect(titles(cards)).toEqual(["", "Actividad"]);
    expect(cards[1]?.rows.join(" ")).toContain("Sin proyecto registrado");
    expect(cards[1]?.rows.join(" ")).toContain("haril project init");
    const english = activityRows(none, { locale: "en", range: ALL_RANGE, busy: false });
    expect(english.cards[1]?.rows.join(" ")).toContain("No project registered");
  });

  it("offer four compact chips and a «Actualizar» button, each with its own action", () => {
    const { cards } = activityRows(loaded([]), { locale: "es", range: ALL_RANGE, busy: false });
    // The chips carry a short word to draw and the full words of the menu entry.
    expect(cards[0]?.chips).toEqual([
      { label: "1h", name: "Última hora", action: ACTIVITY_ACTIONS.hour, active: false },
      { label: "1d", name: "Último día", action: ACTIVITY_ACTIONS.day, active: false },
      { label: "Rango", name: "Rango…", action: ACTIVITY_ACTIONS.range, active: false },
      { label: "Todo", name: "Todo", action: ACTIVITY_ACTIONS.all, active: true },
    ]);
    expect(cards[0]?.buttons).toEqual([{ label: "Actualizar", action: ACTIVITY_ACTIONS.refresh }]);
    const english = activityRows(loaded([]), { locale: "en", range: ALL_RANGE, busy: false });
    expect(english.cards[0]?.chips?.map((chip) => [chip.label, chip.name])).toEqual([
      ["1h", "Last hour"],
      ["1d", "Last day"],
      ["Range", "Range…"],
      ["All", "All"],
    ]);
    expect(english.cards[0]?.buttons?.map((button) => button.label)).toEqual(["Refresh"]);
    expect(Object.values(ACTIVITY_ACTIONS)).toEqual([
      "activity:hour",
      "activity:day",
      "activity:range",
      "activity:all",
      "activity:refresh",
    ]);
  });

  it.each([
    ["every event", ALL_RANGE, "Todo"],
    ["the last hour", { kind: "hour" } as ActivityRange, "1h"],
    ["the last day", { kind: "day" } as ActivityRange, "1d"],
    [
      "a range typed by the user",
      { kind: "custom", from: NOW - 3_600_000 } as ActivityRange,
      "Rango",
    ],
  ])("highlight the chip of the range in force (%s) and no other", (_name, range, label) => {
    const { cards } = activityRows(loaded([]), { locale: "es", range, busy: false });
    const active = cards[0]?.chips
      ?.filter((chip) => chip.active === true)
      .map((chip) => chip.label);
    expect(active).toEqual([label]);
  });

  it("show the «Rango» chip as waiting, and highlighted, while its dialog is open", () => {
    const es = activityRows(loaded([]), {
      locale: "es",
      range: ALL_RANGE,
      busy: false,
      waiting: true,
    });
    expect(es.cards[0]?.chips?.map((chip) => chip.label)).toEqual(["1h", "1d", "Espera", "Todo"]);
    // The dialog is the user's now: the chip is lit, whatever range is in force, and «Todo» is not.
    expect(es.cards[0]?.chips?.filter((chip) => chip.active).map((chip) => chip.action)).toEqual([
      ACTIVITY_ACTIONS.range,
    ]);
    // The words of the menu entry do not change.
    expect(es.cards[0]?.chips?.[2]?.name).toBe("Rango…");
    const en = activityRows(loaded([]), {
      locale: "en",
      range: { kind: "hour" },
      busy: false,
      waiting: true,
    });
    expect(en.cards[0]?.chips?.map((chip) => chip.label)).toEqual(["1h", "1d", "Waiting", "All"]);
    expect(en.cards[0]?.chips?.filter((chip) => chip.active).map((chip) => chip.label)).toEqual([
      "Waiting",
    ]);
  });

  it("keep the chips in the card while only the dialog is open: the «Cargando…» row is for reading", () => {
    const { cards } = activityRows(loaded([]), {
      locale: "es",
      range: ALL_RANGE,
      busy: false,
      waiting: true,
    });
    expect(cards[0]?.buttons).toEqual([{ label: "Actualizar", action: ACTIVITY_ACTIONS.refresh }]);
  });

  it("show «… Cargando…» in place of the buttons while the events are read, and keep what was read", () => {
    const busy = activityRows(loaded([event(1, "task.started", 1)]), {
      locale: "es",
      range: ALL_RANGE,
      busy: true,
    });
    expect(busy.cards[0]?.rows.at(-1)).toBe("… Cargando…");
    expect(busy.cards[0]?.buttons).toBeUndefined();
    expect(busy.cards[0]?.chips).toBeUndefined();
    expect(busy.cards[1]?.rows).toEqual(["#1 task.started · hace 1 min"]);
    const english = activityRows(loaded([]), { locale: "en", range: ALL_RANGE, busy: true });
    expect(english.cards[0]?.rows.at(-1)).toBe("… Loading…");
  });

  it("offer nothing to press when this Pi was not opened by haril", () => {
    const { cards } = activityRows(
      { kind: "failed", reason: NOT_LAUNCHED, ...LOADED_AT },
      { locale: "es", range: ALL_RANGE, busy: false },
    );
    expect(titles(cards)).toEqual(["", "Actividad · no disponible"]);
  });
});

describe("the tab as the right rail draws it", () => {
  const events = Array.from({ length: 50 }, (_unused, index) =>
    event(
      index + 1,
      index % 7 === 0 ? "workflow.node.verification.failed.badly" : "task.started",
      index,
    ),
  );
  const states: [string, ActivityData][] = [
    ["events", loaded(events)],
    ["empty", loaded([])],
    [
      "failed",
      { kind: "failed", reason: "haril: store is locked by another process", ...LOADED_AT },
    ],
    ["none", { kind: "none", ...LOADED_AT }],
  ];

  it.each(states)(
    "draws every row (%s) exactly the rail's width, in Unicode and ASCII, in both languages",
    (_name, data) => {
      for (const locale of ["es", "en"] as const) {
        for (const waiting of [false, true]) {
          const { cards } = activityRows(data, {
            locale,
            range: { kind: "custom", from: NOW - 5 * 3_600_000, to: NOW },
            busy: false,
            waiting,
          });
          for (const ascii of [false, true]) {
            const drawn = railRows({ title: "Actividad", lines: [], cards }, ascii);
            const plain = drawn.rows.map(stripAnsi);
            expect(new Set(plain.map(textWidth)), `${locale} ascii=${ascii}`).toEqual(
              new Set([RAIL_BODY_WIDTH]),
            );
            expect(drawn.hits).toHaveLength(drawn.rows.length);
            if (ascii) expect(plain.join("")).not.toMatch(/[╭╮╰╯─│▸]/u);
          }
        }
      }
    },
  );

  it("draws the four chips on one row of three, the button below, and gives each its columns", () => {
    for (const [locale, words] of [
      ["es", "│ 1h │ │ 1d │ │ Rango │ │ Todo │"],
      ["en", "│ 1h │ │ 1d │ │ Range │ │ All │"],
    ] as const) {
      const { cards } = activityRows(loaded(events.slice(0, 3)), {
        locale,
        range: ALL_RANGE,
        busy: false,
      });
      const drawn = railRows({ title: "Actividad", lines: [], cards }, false);
      const plain = drawn.rows.map(stripAnsi);
      const middle = plain.findIndex((row) => row.includes(words));
      expect(middle, locale).toBeGreaterThan(0);
      // The same cells on the three rows of the chips, a click anywhere on a chip's rows runs its action.
      const chipRows = [drawn.hits[middle - 1], drawn.hits[middle], drawn.hits[middle + 1]];
      const at = (x: number) => chipRows.map((hit) => railHitAt(hit, x));
      // A click's column counts the rail's separator, which a row of the body does not carry.
      const first = (plain[middle]?.indexOf("│ 1h") ?? -2) + 1;
      const run = (offset: number) => at(first + offset);
      expect(run(1), locale).toEqual(Array(3).fill(ACTIVITY_ACTIONS.hour));
      expect(run(8), locale).toEqual(Array(3).fill(ACTIVITY_ACTIONS.day));
      expect(run(16), locale).toEqual(Array(3).fill(ACTIVITY_ACTIONS.range));
      expect(run(27), locale).toEqual(Array(3).fill(ACTIVITY_ACTIONS.all));
      expect(run(6), locale).toEqual(Array(3).fill(undefined));
      // The button under the chips is a whole-row action.
      const refresh = plain.findIndex(
        (row) => row.includes("▸ Refresh") || row.includes("▸ Actualizar"),
      );
      expect(drawn.hits.slice(refresh - 1, refresh + 2), locale).toEqual(
        Array(3).fill(ACTIVITY_ACTIONS.refresh),
      );
      // Nothing else in the card runs anything: the three chip rows and the three of the button.
      expect(drawn.hits.filter((hit) => hit !== undefined)).toHaveLength(6);
    }
  });

  it("is also a flat view whose actions carry the words the keyboard menu reads", () => {
    const { cards } = activityRows(loaded([]), { locale: "es", range: ALL_RANGE, busy: false });
    const { lines, actions } = flatView(cards);
    expect(actions.map((action) => action.label)).toEqual([
      "Última hora",
      "Último día",
      "Rango…",
      "Todo",
      "Actualizar",
    ]);
    for (const action of actions) expect(lines[action.line]).toBe(`▸ ${action.label}`);
  });
});
