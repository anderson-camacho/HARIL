import { describe, expect, it } from "vitest";
import {
  ALL_RANGE,
  describeRange,
  parseDuration,
  parseInstant,
  parseRange,
  parseRangeText,
  rangeFlags,
} from "../src/activity-range.js";

// The time range the ACT tab filters the events by: the flags `haril events` gets, the words that name it in the card,
// and the two answers the «Rango…» dialog collects. `parseDuration` and `parseInstant` are the console's copy of the
// CLI's (apps/haril/src/commands/usage-format.ts), which the console may not import; the cases below are the CLI's.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 30, 20, 12, 0);

const two = (value: number): string => String(value).padStart(2, "0");
// The local clock time and date the card prints, built here from the Date getters and not from the code under test.
const clock = (ms: number): string =>
  `${two(new Date(ms).getHours())}:${two(new Date(ms).getMinutes())}`;
const dayEs = (ms: number): string =>
  `${two(new Date(ms).getDate())}/${two(new Date(ms).getMonth() + 1)}`;
const dayEn = (ms: number): string =>
  `${two(new Date(ms).getMonth() + 1)}/${two(new Date(ms).getDate())}`;

describe("parseDuration", () => {
  it.each([
    ["90s", 90_000],
    ["15m", 900_000],
    ["2h", 2 * HOUR],
    ["7d", 7 * 86_400_000],
    ["1w", 604_800_000],
    [" 3h ", 3 * HOUR],
    ["0h", 0],
  ])("reads %s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["", "h", "3", "3x", "-3h", "3 h", "1.5h", "1234567890h", "yesterday", "2026-10-30"])(
    "does not read %j",
    (text) => {
      expect(parseDuration(text)).toBeNull();
    },
  );
});

describe("parseInstant", () => {
  it("reads an ISO date or time (a date alone is midnight UTC) and epoch milliseconds", () => {
    expect(parseInstant("2026-10-30")).toBe(Date.UTC(2026, 9, 30));
    expect(parseInstant("2026-10-30T08:00:00Z")).toBe(Date.UTC(2026, 9, 30, 8));
    expect(parseInstant("2026-10-30T08:00:00+02:00")).toBe(Date.UTC(2026, 9, 30, 6));
    expect(parseInstant(String(NOW))).toBe(NOW);
    expect(parseInstant(`  ${NOW} `)).toBe(NOW);
  });

  it("does not read what is neither, or a moment that no date can hold", () => {
    for (const text of [
      "",
      "yesterday",
      "30/10",
      "12:00",
      "2026-13-45",
      "2026-10-30T25:99",
      "3h",
    ]) {
      expect(parseInstant(text), text).toBeNull();
    }
    // 16 digits is epoch milliseconds for the CLI, but no calendar date: it could not be handed back as an ISO time.
    expect(parseInstant("9999999999999999")).toBeNull();
  });
});

describe("rangeFlags", () => {
  it("is what each range asks `haril events` for", () => {
    expect(rangeFlags(ALL_RANGE)).toEqual([]);
    expect(rangeFlags({ kind: "hour" })).toEqual(["--since", "1h"]);
    expect(rangeFlags({ kind: "day" })).toEqual(["--since", "1d"]);
  });

  it("gives a custom range as ISO instants, with --to only when it has an end", () => {
    const from = Date.UTC(2026, 9, 30, 8);
    const to = Date.UTC(2026, 9, 30, 12);
    expect(rangeFlags({ kind: "custom", from })).toEqual(["--from", "2026-10-30T08:00:00.000Z"]);
    expect(rangeFlags({ kind: "custom", from, to })).toEqual([
      "--from",
      "2026-10-30T08:00:00.000Z",
      "--to",
      "2026-10-30T12:00:00.000Z",
    ]);
  });
});

describe("describeRange", () => {
  it("names the last hour with the time it starts at", () => {
    expect(describeRange({ kind: "hour" }, NOW, "es")).toBe(
      `Última hora (desde ${clock(NOW - HOUR)})`,
    );
    expect(describeRange({ kind: "hour" }, NOW, "en")).toBe(
      `Last hour (since ${clock(NOW - HOUR)})`,
    );
  });

  it("names the last day with the date and time it starts at, the date as the language writes it", () => {
    const since = NOW - 24 * HOUR;
    expect(describeRange({ kind: "day" }, NOW, "es")).toBe(
      `Último día (desde ${dayEs(since)} ${clock(since)})`,
    );
    expect(describeRange({ kind: "day" }, NOW, "en")).toBe(
      `Last day (since ${dayEn(since)} ${clock(since)})`,
    );
  });

  it("names a custom range by its two ends, and an open end as now", () => {
    const from = Date.UTC(2026, 9, 30, 8);
    const to = Date.UTC(2026, 9, 30, 12);
    expect(describeRange({ kind: "custom", from, to }, NOW, "es")).toBe(
      `Rango: ${dayEs(from)} ${clock(from)} → ${dayEs(to)} ${clock(to)}`,
    );
    expect(describeRange({ kind: "custom", from }, NOW, "es")).toBe(
      `Rango: ${dayEs(from)} ${clock(from)} → ahora`,
    );
    expect(describeRange({ kind: "custom", from, to }, NOW, "en")).toBe(
      `Range: ${dayEn(from)} ${clock(from)} → ${dayEn(to)} ${clock(to)}`,
    );
    expect(describeRange({ kind: "custom", from }, NOW, "en")).toBe(
      `Range: ${dayEn(from)} ${clock(from)} → now`,
    );
  });

  it("names every event «Todo» / «All»", () => {
    expect(describeRange(ALL_RANGE, NOW, "es")).toBe("Todo");
    expect(describeRange(ALL_RANGE, NOW, "en")).toBe("All");
  });

  it("fits a card's 33 columns in the longest case", () => {
    const from = Date.UTC(2026, 11, 31, 23, 59);
    const to = Date.UTC(2026, 11, 31, 23, 59);
    expect(
      Array.from(describeRange({ kind: "custom", from, to }, NOW, "es")).length,
    ).toBeLessThanOrEqual(33);
    expect(
      Array.from(describeRange({ kind: "custom", from, to }, NOW, "en")).length,
    ).toBeLessThanOrEqual(33);
  });
});

describe("parseRange (what the «Rango…» dialog collected)", () => {
  it("reads a duration as that long before now, and an empty end as now", () => {
    expect(parseRange("3h", "", NOW, "es")).toEqual({
      ok: true,
      range: { kind: "custom", from: NOW - 3 * HOUR },
    });
    expect(parseRange("2d", "  ", NOW, "es")).toEqual({
      ok: true,
      range: { kind: "custom", from: NOW - 2 * 86_400_000 },
    });
  });

  it("reads durations at both ends", () => {
    expect(parseRange("3h", "1h", NOW, "es")).toEqual({
      ok: true,
      range: { kind: "custom", from: NOW - 3 * HOUR, to: NOW - HOUR },
    });
  });

  it("reads instants at both ends, and an instant next to a duration", () => {
    expect(parseRange("2026-10-30T08:00:00Z", "2026-10-30T12:00:00Z", NOW, "es")).toEqual({
      ok: true,
      range: { kind: "custom", from: Date.UTC(2026, 9, 30, 8), to: Date.UTC(2026, 9, 30, 12) },
    });
    expect(parseRange("2026-10-30T08:00:00Z", "1h", NOW, "es")).toEqual({
      ok: true,
      range: { kind: "custom", from: Date.UTC(2026, 9, 30, 8), to: NOW - HOUR },
    });
  });

  it.each([
    ["ayer", "", "Desde"],
    ["", "", "Desde"],
    ["3h", "mañana", "Hasta"],
    ["31/04", "", "Desde"],
    ["9999999999999999", "", "Desde"],
  ])("refuses %j / %j and says which end is wrong", (from, to, end) => {
    const result = parseRange(from, to, NOW, "es");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(`«${end}»`);
      expect(result.reason).toContain("3h");
    }
  });

  it("refuses an end that is not after the start", () => {
    for (const [from, to] of [
      ["1h", "3h"],
      ["2h", "2h"],
      ["2026-10-30T12:00:00Z", "2026-10-30T08:00:00Z"],
    ] as const) {
      const result = parseRange(from, to, NOW, "es");
      expect(result.ok, `${from} → ${to}`).toBe(false);
      if (!result.ok) expect(result.reason).toContain("anterior");
    }
  });

  it("says the same in English", () => {
    const wrong = parseRange("yesterday", "", NOW, "en");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain('"From"');
    const reversed = parseRange("1h", "3h", NOW, "en");
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.reason).toContain("before");
  });

  it("names the forms it accepts, with a date written as the card writes it in that language", () => {
    const es = parseRange("ayer", "", NOW, "es");
    const en = parseRange("yesterday", "", NOW, "en");
    expect(es.ok ? "" : es.reason).toBe(
      "«Desde» no es válido: usa 3h, 2d o una fecha como 29/10 08:00",
    );
    expect(en.ok ? "" : en.reason).toBe(
      '"From" is not valid: use 3h, 2d or a date such as 10/29 08:00',
    );
  });
});

// A date written the way the Filtro card prints it: «29/10 08:00» («10/29 08:00» in English), on the local clock.
describe("a date as the card writes it", () => {
  const local = (month: number, day: number, hour = 0, minute = 0, year = 2026): number =>
    new Date(year, month - 1, day, hour, minute).getTime();
  const from = (text: string, locale: "es" | "en" = "es") => {
    const result = parseRange(text, "", NOW, locale);
    return result.ok && result.range.kind === "custom" ? result.range.from : result;
  };

  it("reads day/month and the time in Spanish, month/day in English, on the local clock", () => {
    expect(from("29/10 08:00")).toBe(local(10, 29, 8, 0));
    expect(from("29/10 8:05")).toBe(local(10, 29, 8, 5));
    expect(from("10/29 08:00", "en")).toBe(local(10, 29, 8, 0));
    expect(from("  29/10   23:59 ")).toBe(local(10, 29, 23, 59));
  });

  it("reads a date alone as midnight, and takes the year of now unless one is given", () => {
    expect(from("29/10")).toBe(local(10, 29));
    expect(from("9/1")).toBe(local(1, 9));
    expect(from("29/10/2025 08:00")).toBe(local(10, 29, 8, 0, 2025));
    expect(from("10/29/2025", "en")).toBe(local(10, 29, 0, 0, 2025));
  });

  it.each([
    "31/04 08:00",
    "29/13",
    "00/10",
    "29/00",
    "29/10 24:00",
    "29/10 08:60",
    "29/10 8",
    "29-10 08:00",
    "29/10/25",
    "29/10 08:00 pm",
  ])("does not read %j", (text) => {
    const result = parseRange(text, "", NOW, "es");
    expect(result.ok, text).toBe(false);
  });

  it("does not read the Spanish order in English, nor the English order in Spanish, when it is impossible", () => {
    // 29 is no month.
    expect(parseRange("29/10", "", NOW, "en").ok).toBe(false);
    expect(parseRange("10/29", "", NOW, "es").ok).toBe(false);
  });
});

// The single answer of the «Rango…» dialog: «3h», «2d» or «desde .. hasta».
describe("parseRangeText (what the «Rango…» dialog collects)", () => {
  const range = (text: string, locale: "es" | "en" = "es") => parseRangeText(text, NOW, locale);

  it("reads a duration as the last N, until now", () => {
    expect(range("3h")).toEqual({ ok: true, range: { kind: "custom", from: NOW - 3 * HOUR } });
    expect(range(" 2d ")).toEqual({
      ok: true,
      range: { kind: "custom", from: NOW - 2 * 86_400_000 },
    });
  });

  it("reads two instants separated by « .. », ISO or as the card writes them", () => {
    expect(range("2026-10-30T08:00:00Z .. 2026-10-30T12:00:00Z")).toEqual({
      ok: true,
      range: { kind: "custom", from: Date.UTC(2026, 9, 30, 8), to: Date.UTC(2026, 9, 30, 12) },
    });
    expect(range("29/10 08:00 .. 29/10 12:00")).toEqual({
      ok: true,
      range: {
        kind: "custom",
        from: new Date(2026, 9, 29, 8).getTime(),
        to: new Date(2026, 9, 29, 12).getTime(),
      },
    });
    expect(range("10/29 08:00 .. 10/29 12:00", "en")).toEqual(range("29/10 08:00 .. 29/10 12:00"));
  });

  it("reads an empty end as now, with or without a space before the dots", () => {
    const open = {
      ok: true,
      range: { kind: "custom", from: new Date(2026, 9, 29, 8).getTime() },
    };
    expect(range("29/10 08:00 ..")).toEqual(open);
    expect(range("29/10 08:00..")).toEqual(open);
    expect(range("29/10 08:00 ..  ")).toEqual(open);
    expect(range("3h ..")).toEqual({ ok: true, range: { kind: "custom", from: NOW - 3 * HOUR } });
  });

  it("reads durations at both ends and tolerates no spaces around the dots", () => {
    const both = { ok: true, range: { kind: "custom", from: NOW - 3 * HOUR, to: NOW - HOUR } };
    expect(range("3h .. 1h")).toEqual(both);
    expect(range("3h..1h")).toEqual(both);
  });

  it.each([
    ["ayer", "«Desde»"],
    ["", "«Desde»"],
    [".. 1h", "«Desde»"],
    ["3h .. mañana", "«Hasta»"],
    ["3h .. 1h .. 30m", "Demasiados"],
  ])("refuses %j and says what is wrong", (text, words) => {
    const result = range(text);
    expect(result.ok, text).toBe(false);
    if (!result.ok) expect(result.reason).toContain(words);
  });

  it("says too many dots in English too", () => {
    const result = range("3h .. 1h .. 30m", "en");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Too many");
  });

  it("refuses an end that is not after the start", () => {
    for (const text of ["1h .. 3h", "2h .. 2h", "2026-10-30T12:00:00Z .. 2026-10-30T08:00:00Z"]) {
      const result = range(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.reason).toContain("anterior");
    }
  });
});
