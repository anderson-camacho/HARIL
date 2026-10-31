import { localized, type UiLocale } from "./locale.js";

// The time range the ACT tab filters the recent events by, for the session: how it becomes the flags of `haril events`,
// the words that name it in the tab, and how what the «Rango…» dialog collects becomes one range. Times are epoch
// milliseconds, as the CLI's are.

export type ActivityRange =
  | { readonly kind: "all" }
  // The last hour and the last day count back from the moment the events are read, so «Actualizar» moves them on.
  | { readonly kind: "hour" }
  | { readonly kind: "day" }
  // A range the user typed: fixed instants, the end open (now) when `to` is missing.
  | { readonly kind: "custom"; readonly from: number; readonly to?: number };

export const ALL_RANGE: ActivityRange = { kind: "all" };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: HOUR_MS,
  d: DAY_MS,
  w: 604_800_000,
};

// "90s", "15m", "2h", "7d" or "1w", or null. The twin of parseDuration in apps/haril/src/commands/usage-format.ts: the
// console bundles into one file and imports no workspace package, so the CLI's rule is repeated here.
export function parseDuration(text: string): number | null {
  const match = /^(\d{1,9})([smhdw])$/.exec(text.trim());
  if (match === null) return null;
  return Number(match[1]) * (UNIT_MS[match[2] as string] as number);
}

// An ISO 8601 date or time (a date alone is midnight UTC), or epoch milliseconds; null when neither, or when it is a
// moment no date can hold (the CLI would take 16 digits, but this one is handed back to it as an ISO time).
export function parseInstant(text: string): number | null {
  const trimmed = text.trim();
  let value: number;
  if (/^\d{1,16}$/.test(trimmed)) value = Number(trimmed);
  else if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) value = Date.parse(trimmed);
  else return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

// The flags `haril events` gets for a range (after --project and --limit).
export function rangeFlags(range: ActivityRange): string[] {
  switch (range.kind) {
    case "all":
      return [];
    case "hour":
      return ["--since", "1h"];
    case "day":
      return ["--since", "1d"];
    case "custom":
      return [
        "--from",
        new Date(range.from).toISOString(),
        ...(range.to === undefined ? [] : ["--to", new Date(range.to).toISOString()]),
      ];
  }
}

const two = (value: number): string => String(value).padStart(2, "0");

// "20:12" on the local clock.
export function clockText(ms: number): string {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

// "30/10 08:00" ("10/30 08:00" in English) on the local clock.
function stamp(ms: number, locale: UiLocale): string {
  const date = new Date(ms);
  const day = two(date.getDate());
  const month = two(date.getMonth() + 1);
  return `${locale === "es" ? `${day}/${month}` : `${month}/${day}`} ${clockText(ms)}`;
}

// The range in words, as the Filtro card prints it. `at` is the moment the events were read: the last hour and the
// last day are said from it.
export function describeRange(range: ActivityRange, at: number, locale: UiLocale): string {
  const say = (english: string, spanish: string): string => localized(locale, english, spanish);
  switch (range.kind) {
    case "all":
      return say("All", "Todo");
    case "hour":
      return say(
        `Last hour (since ${clockText(at - HOUR_MS)})`,
        `Última hora (desde ${clockText(at - HOUR_MS)})`,
      );
    case "day":
      return say(
        `Last day (since ${stamp(at - DAY_MS, locale)})`,
        `Último día (desde ${stamp(at - DAY_MS, locale)})`,
      );
    case "custom": {
      const end = range.to === undefined ? say("now", "ahora") : stamp(range.to, locale);
      return `${say("Range", "Rango")}: ${stamp(range.from, locale)} → ${end}`;
    }
  }
}

export type RangeInput =
  | { readonly ok: true; readonly range: ActivityRange }
  | { readonly ok: false; readonly reason: string };

// A date as the Filtro card prints it, on the local clock: «29/10 08:00» («10/29 08:00» in English), «29/10» for midnight,
// and «29/10/2025 08:00» with a year (the year of `now` when there is none). Null for anything else, and for a date
// the calendar does not have (31/04 would roll over to 01/05, so it is checked by reading the date back).
function parseStamp(text: string, now: number, locale: UiLocale): number | null {
  const match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?$/.exec(text.trim());
  if (match === null) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const day = locale === "es" ? first : second;
  const month = locale === "es" ? second : first;
  const year = match[3] === undefined ? new Date(now).getFullYear() : Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const date = new Date(year, month - 1, day, hour, minute);
  const readBack =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;
  return readBack ? date.getTime() : null;
}

// A moment the user typed: a duration is that long before `now`; anything else must be an instant, ISO or as the card
// writes it.
function moment(text: string, now: number, locale: UiLocale): number | null {
  const duration = parseDuration(text);
  return duration === null ? (parseInstant(text) ?? parseStamp(text, now, locale)) : now - duration;
}

// The two ends of a range as one range. An empty end is now. Anything that is not a duration or an instant, or an end
// that is not after the start, is refused with a sentence that names the end and the forms that are accepted.
export function parseRange(
  fromText: string,
  toText: string,
  now: number,
  locale: UiLocale,
): RangeInput {
  const say = (english: string, spanish: string): string => localized(locale, english, spanish);
  const invalid = (english: string, spanish: string): RangeInput => ({
    ok: false,
    reason: say(
      `"${english}" is not valid: use 3h, 2d or a date such as 10/29 08:00`,
      `«${spanish}» no es válido: usa 3h, 2d o una fecha como 29/10 08:00`,
    ),
  });
  const from = moment(fromText, now, locale);
  if (from === null) return invalid("From", "Desde");
  const to = toText.trim() === "" ? undefined : moment(toText, now, locale);
  if (to === null) return invalid("To", "Hasta");
  if (to !== undefined && from >= to) {
    return {
      ok: false,
      reason: say('"From" must be before "To"', "«Desde» debe ser anterior a «Hasta»"),
    };
  }
  return { ok: true, range: { kind: "custom", from, ...(to === undefined ? {} : { to }) } };
}

// What the «Rango…» dialog collects, in one answer: «3h» or «2d» (the last N, until now), or «desde .. hasta» with two
// instants (ISO, or as the card writes them), where an empty «hasta» is now («desde ..»). The dots may touch the
// instants. More than one « .. » is refused.
export function parseRangeText(text: string, now: number, locale: UiLocale): RangeInput {
  const parts = text.split("..");
  if (parts.length > 2) {
    return {
      ok: false,
      reason: localized(
        locale,
        'Too many " .. ": use 3h, 2d or "from .. to"',
        "Demasiados « .. »: usa 3h, 2d o «desde .. hasta»",
      ),
    };
  }
  return parseRange(parts[0] ?? "", parts[1] ?? "", now, locale);
}
