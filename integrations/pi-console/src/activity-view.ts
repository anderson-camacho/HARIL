import { type ActivityRange, clockText, describeRange, rangeFlags } from "./activity-range.js";
import { NOT_LAUNCHED } from "./cli.js";
import type { DashboardTone } from "./dashboard-theme.js";
import { localized, type UiLocale } from "./locale.js";
import { ago } from "./orchestration-draw.js";
import { CARD_CONTENT_WIDTH } from "./rail-metrics.js";
import type { DockCard } from "./rail-view.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

// The ACT tab: the project's recent events, filtered by a time range. What it asks `haril events` for, what it keeps of
// the answer, and the cards it makes of it. The console never reads the store: everything goes through the CLI.

// The most events the tab asks for; when the answer is as long as this, the tab says it shows the newest ones.
export const ACTIVITY_LIMIT = 50;

// The id of each button; the console maps them to what they do.
export const ACTIVITY_ACTIONS = {
  hour: "activity:hour",
  day: "activity:day",
  range: "activity:range",
  all: "activity:all",
  refresh: "activity:refresh",
} as const;

// The most rows a failure takes in the card.
const MAX_REASON_LINES = 3;

export interface ActivityEvent {
  readonly seq: number;
  readonly type: string;
  // When it was written, in epoch milliseconds; undefined when the time could not be read.
  readonly at: number | undefined;
}

// What a load found. `loadedAt` is the moment it was made: the last hour, the ages and «Actualizado» are said from it,
// so a view does not change from one frame to the next.
export type ActivityData =
  | {
      readonly kind: "events";
      readonly events: readonly ActivityEvent[];
      readonly loadedAt: number;
    }
  // This folder is not a registered project: there is nothing to ask for.
  | { readonly kind: "none"; readonly loadedAt: number }
  | { readonly kind: "failed"; readonly reason: string; readonly loadedAt: number };

// What a command printed.
export interface EventsAnswer {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ActivityOptions {
  readonly locale: UiLocale;
  readonly range: ActivityRange;
  // The events are being read: the buttons give way to a «Cargando…» row.
  readonly busy: boolean;
}

export interface ActivityRows {
  readonly status: string;
  readonly cards: DockCard[];
}

type Say = (english: string, spanish: string) => string;

// `haril events` for the project, its newest events inside the range, as JSON.
export function activityArgs(slug: string, range: ActivityRange): string[] {
  return [
    "events",
    "--project",
    slug,
    "--limit",
    String(ACTIVITY_LIMIT),
    ...rangeFlags(range),
    "--json",
  ];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// The events of `haril events --json`, oldest first as the command prints them; undefined when the text is not a JSON
// list. An entry that is not an event is skipped, and one whose time cannot be read is kept without it.
export function parseEvents(stdout: string): ActivityEvent[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const events: ActivityEvent[] = [];
  for (const entry of value) {
    const row = record(entry);
    if (row === undefined || typeof row.seq !== "number" || typeof row.type !== "string") continue;
    const at = typeof row.time === "string" ? Date.parse(row.time) : Number.NaN;
    events.push({
      seq: row.seq,
      type: plainText(row.type),
      at: Number.isNaN(at) ? undefined : at,
    });
  }
  return events;
}

// What the command wrote to stderr as plain lines, or undefined when it wrote none.
function reasonOf(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => plainText(line).trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(0, MAX_REASON_LINES);
  return lines.length === 0 ? undefined : lines.join("\n");
}

// The tab's data for a project and range. It never rejects: a command that cannot run, or whose answer is not the list,
// is a failed tab with its reason. The exit code does not decide: a command that printed the list answered.
export async function loadActivity(
  read: (args: readonly string[]) => Promise<EventsAnswer>,
  slug: string | undefined,
  range: ActivityRange,
  now: () => number,
  locale: UiLocale,
): Promise<ActivityData> {
  const loadedAt = now();
  if (slug === undefined) return { kind: "none", loadedAt };
  const invalid = localized(locale, "Invalid answer from haril.", "Respuesta no válida de haril.");
  try {
    const answer = await read(activityArgs(slug, range));
    const events = answer.stdout.trim() === "" ? undefined : parseEvents(answer.stdout);
    if (events !== undefined) return { kind: "events", events, loadedAt };
    return { kind: "failed", reason: (!answer.ok && reasonOf(answer.stderr)) || invalid, loadedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: reasonOf(message) ?? invalid, loadedAt };
  }
}

// "hace 3 min" or "3 min ago": the console's own relative time, said in the language.
function ageText(at: number, now: number, locale: UiLocale): string {
  const english = ago(at, now);
  if (locale === "en") return english;
  const match = /^(\d+) (s|min|h|d) ago$/.exec(english);
  return match === null ? english : `hace ${match[1]} ${match[2]}`;
}

// What marks an event as one that went wrong; the rest are drawn in the text tone.
const PROBLEM = /failed|cancel|error/i;

// A row for an event: `#375 watchdog.closed · hace 3 min`. When it is too long the type gives way, never the age.
function eventRow(event: ActivityEvent, now: number, locale: UiLocale): string {
  const head = `#${event.seq} ${event.type}`;
  const suffix = event.at === undefined ? "" : ` · ${ageText(event.at, now, locale)}`;
  return `${truncate(head, CARD_CONTENT_WIDTH - textWidth(suffix))}${suffix}`;
}

function reasonRows(reason: string): string[] {
  const rows = reason.split("\n").flatMap((line) => wrap(line, CARD_CONTENT_WIDTH));
  if (rows.length <= MAX_REASON_LINES) return rows;
  const kept = rows.slice(0, MAX_REASON_LINES);
  kept[MAX_REASON_LINES - 1] = truncate(`${kept[MAX_REASON_LINES - 1]}…`, CARD_CONTENT_WIDTH);
  return kept;
}

function activityCard(data: ActivityData, say: Say, locale: UiLocale): DockCard {
  const title = say("Activity", "Actividad");
  switch (data.kind) {
    case "none":
      return {
        title,
        rows: [
          ...wrap(
            say(
              "No project registered in this folder.",
              "Sin proyecto registrado en esta carpeta.",
            ),
            CARD_CONTENT_WIDTH,
          ),
          ...wrap(
            say("Register it: haril project init", "Regístralo: haril project init"),
            CARD_CONTENT_WIDTH,
          ),
        ],
      };
    case "failed":
      return {
        title: say("Activity · not available", "Actividad · no disponible"),
        rows: reasonRows(data.reason),
      };
    case "events": {
      const newestFirst = [...data.events].reverse();
      const rows = newestFirst.map((event) => eventRow(event, data.loadedAt, locale));
      const tones: (DashboardTone | undefined)[] = newestFirst.map((event) =>
        PROBLEM.test(event.type) ? "error" : undefined,
      );
      const heading = `${title} · ${data.events.length}`;
      if (rows.length === 0) {
        return {
          title: heading,
          rows: [say("No events in this range.", "Sin eventos en este rango.")],
          tones: ["muted"],
        };
      }
      if (data.events.length >= ACTIVITY_LIMIT) {
        rows.push(
          say(`Showing the latest ${ACTIVITY_LIMIT}.`, `Mostrando los últimos ${ACTIVITY_LIMIT}.`),
        );
        tones.push("muted");
      }
      return { title: heading, rows, tones };
    }
  }
}

// The tab as cards: the range it filters by, the buttons that change it, and the events. The buttons come before the
// events so they stay in reach whatever the list is: it can be fifty rows long.
export function activityRows(data: ActivityData, options: ActivityOptions): ActivityRows {
  const say: Say = (english, spanish) => localized(options.locale, english, spanish);
  const cards: DockCard[] = [
    {
      title: say("Filter", "Filtro"),
      rows: [
        ...wrap(describeRange(options.range, data.loadedAt, options.locale), CARD_CONTENT_WIDTH),
        say(`Updated ${clockText(data.loadedAt)}`, `Actualizado ${clockText(data.loadedAt)}`),
      ],
    },
  ];
  const actions = say("Actions", "Acciones");
  if (options.busy) {
    cards.push({ title: actions, rows: [say("… Loading…", "… Cargando…")] });
  } else if (!(data.kind === "failed" && data.reason === NOT_LAUNCHED)) {
    cards.push({
      title: actions,
      rows: [],
      buttons: [
        { label: say("Last hour", "Última hora"), action: ACTIVITY_ACTIONS.hour },
        { label: say("Last day", "Último día"), action: ACTIVITY_ACTIONS.day },
        { label: say("Range…", "Rango…"), action: ACTIVITY_ACTIONS.range },
        { label: say("All", "Todo"), action: ACTIVITY_ACTIONS.all },
        { label: say("Refresh", "Actualizar"), action: ACTIVITY_ACTIONS.refresh },
      ],
    });
  }
  cards.push(activityCard(data, say, options.locale));
  return { status: say("Recent activity", "Actividad reciente"), cards };
}
