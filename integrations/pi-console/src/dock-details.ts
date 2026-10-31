import { type ActionsInput, actionsRows } from "./actions-view.js";
import { type ActivityRange, ALL_RANGE } from "./activity-range.js";
import {
  type ActivityData,
  type ActivityOptions,
  activityRows,
  loadActivity,
} from "./activity-view.js";
import { cliAvailable, runHaril } from "./cli.js";
import { type DocsScan, scanDocsFolder, tailFit } from "./docs-folder.js";
import { localized, type UiLocale } from "./locale.js";
import { DOCK_LABELS, type DockId } from "./native-panes.js";
import { CARD_CONTENT_WIDTH } from "./rail-metrics.js";
import { type DockAction, type DockCard, flatView } from "./rail-view.js";
import { plainText, textWidth, wrap } from "./text.js";
import { type MemoryView, parseMemoryStatus, parseToolsStatus } from "./tools-model.js";
import {
  type BusyKind,
  type Loaded,
  type MemData,
  type MemOptions,
  memRows,
} from "./tools-view.js";

const MAX_LINES = 140;
// Columns a row of a card of the right panel has for its text. A row is one line of the view, so what is wider is cut
// by the card; the DOCS view wraps or shortens its own rows instead.
const ROW_WIDTH = CARD_CONTENT_WIDTH;

export interface DockDetails {
  readonly id: DockId;
  readonly title: string;
  readonly status: string;
  // The view as plain lines (the left dock and the inline details draw these).
  readonly lines: readonly string[];
  // The action each button of the view runs, by the line it is on in `lines`, with the words it reads as. The pane
  // reads it for whichever tab is selected; the keyboard menu lists these labels.
  readonly actions?: readonly DockAction[];
  // The same view as sections: the right panel draws one card for each, a button for each of its actions.
  readonly cards?: readonly DockCard[];
}

// What a command printed.
interface CommandAnswer {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DockSource {
  // `haril memory status --json`: the memory process, for the TOOLS tab.
  readonly memory?: () => Promise<CommandAnswer>;
  // `haril tools status --json`: Engram and gentle-ai, for the TOOLS tab.
  readonly tools?: () => Promise<CommandAnswer>;
  // What the console is doing for the TOOLS tab now, and why the check it ran at start-up gave no answer.
  readonly busy?: BusyKind | undefined;
  readonly checkError?: string | undefined;
  // The documentation folder the user connected: its path, or undefined when none is. Rejects with the reason when
  // haril.json cannot be read.
  readonly docsPath?: () => Promise<string | undefined>;
  // What is in that folder (read only).
  readonly scanDocs?: (path: string) => Promise<DocsScan>;
  // `haril events <args>`: the project's events, for the ACT tab.
  readonly events?: (args: readonly string[]) => Promise<CommandAnswer>;
  // The project of the folder the console is in, the range the ACT tab filters by and the clock it reads the time from.
  readonly projectSlug?: string | undefined;
  readonly activityRange?: ActivityRange;
  readonly now?: () => number;
  // The ACT tab is being loaded again: its buttons give way to a «Cargando…» row.
  readonly activityBusy?: boolean;
  // The «Rango…» dialog of the ACT tab is open: its chip says it is waiting.
  readonly activityWaiting?: boolean;
  // The area chosen in MAIN and its controls, for the ACC tab: it reads nothing, it is made of this.
  readonly actions?: ActionsInput;
  readonly locale?: UiLocale;
}

function linesOf(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => plainText(line.trimEnd()))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

function view(id: DockId, status: string, cards: readonly DockCard[]): DockDetails {
  const { lines, actions } = flatView(cards);
  const kept = actions.filter((action) => action.line < MAX_LINES);
  return {
    id,
    title: DOCK_LABELS.find((slot) => slot.id === id)?.label ?? id,
    status,
    lines: lines.slice(0, MAX_LINES),
    ...(kept.length === 0 ? {} : { actions: kept }),
    ...(cards.length === 0 ? {} : { cards }),
  };
}

// The documentation folder as `haril config get docs.path` says it; undefined when none is connected, and no CLI to ask
// (Pi was not opened by haril) is the same as none. Rejects with the CLI's own message when the file has problems.
export async function readDocsPath(cwd: string): Promise<string | undefined> {
  if (!cliAvailable()) return undefined;
  const result = await runHaril(["config", "get", "docs.path", "--json"], {
    cwd,
    timeoutMs: 8_000,
  });
  if (!result.ok) throw new Error(result.stderr.trim() || "haril config get docs.path falló");
  let value: unknown;
  try {
    value = (JSON.parse(result.stdout) as { value?: unknown }).value;
  } catch {
    throw new Error("haril config get docs.path no devolvió JSON");
  }
  return typeof value === "string" && value !== "" ? value : undefined;
}

const DATE_FORMATS = new Map<UiLocale, Intl.DateTimeFormat>();

// "30 oct" or "Oct 30": the day and the month, in the interface language.
function noteDate(mtimeMs: number, locale: UiLocale): string {
  let format = DATE_FORMATS.get(locale);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
    DATE_FORMATS.set(locale, format);
  }
  return format.format(new Date(mtimeMs));
}

// The DOCS view. HARIL only reads the folder; connecting, changing and disconnecting it are rows that the console
// runs through `haril config set docs.path` (actions docs:set and docs:clear).
async function docsDetails(id: DockId, cwd: string, source: DockSource): Promise<DockDetails> {
  const locale = source.locale ?? "es";
  const say = (english: string, spanish: string): string => localized(locale, english, spanish);
  const status = say("Documentation · read-only", "Documentación · solo lectura");
  const path = await (source.docsPath ?? (() => readDocsPath(cwd)))();

  const folder = say("Folder", "Carpeta");
  const actions = say("Actions", "Acciones");

  if (path === undefined) {
    return view(id, status, [
      {
        title: folder,
        rows: [
          say("No folder connected.", "Sin carpeta conectada."),
          ...wrap(
            say(
              "Connect your documentation folder (for example your Obsidian vault).",
              "Conecta tu carpeta de documentación (por ejemplo la bóveda de Obsidian).",
            ),
            ROW_WIDTH,
          ),
        ],
      },
      {
        title: actions,
        rows: [],
        buttons: [{ label: say("Set folder…", "Definir carpeta…"), action: "docs:set" }],
      },
    ]);
  }

  const cards: DockCard[] = [];
  const scanned = await (source.scanDocs ?? scanDocsFolder)(path);
  if (!scanned.exists || !scanned.isDirectory) {
    const message = scanned.exists
      ? say("Not a folder:", "No es una carpeta:")
      : say("Folder not found:", "Carpeta no encontrada:");
    cards.push({
      title: folder,
      rows:
        textWidth(`${message} ${path}`) <= ROW_WIDTH
          ? [`${message} ${path}`]
          : [message, tailFit(path, ROW_WIDTH)],
    });
  } else {
    const count = `${scanned.noteCount}${scanned.truncated ? "+" : ""}`;
    const single = scanned.noteCount === 1 && !scanned.truncated;
    const rows = [
      tailFit(path, ROW_WIDTH),
      locale === "es"
        ? `${count} ${single ? "nota" : "notas"} .md`
        : `${count} .md ${single ? "note" : "notes"}`,
    ];
    if (scanned.latest.length === 0) {
      cards.push({
        title: folder,
        rows: [...rows, "", say("No .md notes yet.", "Sin notas .md todavía.")],
      });
    } else {
      cards.push({ title: folder, rows });
      cards.push({
        title: say("Latest notes", "Últimas notas"),
        rows: scanned.latest.map((note) => {
          const date = noteDate(note.mtimeMs, locale);
          return `${date} ${tailFit(note.rel, ROW_WIDTH - textWidth(date) - 1)}`;
        }),
      });
    }
  }
  cards.push({
    title: actions,
    rows: [],
    buttons: [
      { label: say("Change folder…", "Cambiar carpeta…"), action: "docs:set" },
      { label: say("Disconnect", "Desconectar"), action: "docs:clear" },
    ],
  });
  return view(id, status, cards);
}

// One of the two commands of the TOOLS tab: its answer parsed, or the reason there is none. The exit code does not decide
// (a command that printed its document and then exited non-zero still answered); a rejection is a failed part, never
// a failed tab.
async function readPart<T>(
  read: () => Promise<CommandAnswer>,
  parse: (text: string) => T | undefined,
  invalid: string,
): Promise<Loaded<T>> {
  let answer: CommandAnswer;
  try {
    answer = await read();
  } catch (error) {
    return { ok: false, reason: plainText(error instanceof Error ? error.message : String(error)) };
  }
  const parsed = answer.stdout.trim() === "" ? undefined : parse(answer.stdout);
  if (parsed !== undefined) return { ok: true, value: parsed };
  const reason = plainText(answer.stderr).trim();
  return { ok: false, reason: !answer.ok && reason !== "" ? reason : invalid };
}

// Both commands of the TOOLS tab, asked at the same time: one that fails must not blank the other.
export async function loadMemData(cwd: string, source: DockSource = {}): Promise<MemData> {
  const invalid = localized(
    source.locale ?? "es",
    "Invalid answer from haril.",
    "Respuesta no válida de haril.",
  );
  const [tools, memory] = await Promise.all([
    readPart(
      source.tools ?? (() => runHaril(["tools", "status", "--json"], { cwd, timeoutMs: 8_000 })),
      parseToolsStatus,
      invalid,
    ),
    readPart<MemoryView>(
      source.memory ?? (() => runHaril(["memory", "status", "--json"], { cwd, timeoutMs: 8_000 })),
      parseMemoryStatus,
      invalid,
    ),
  ]);
  return { tools, memory };
}

// The TOOLS tab from what was loaded; the console draws it again from the same data when only its busy state changes.
export function memDetails(data: MemData, options: MemOptions): DockDetails {
  const rows = memRows(data, options);
  return view("memory", rows.status, rows.cards);
}

// The ACT tab from what was loaded; the console draws it again from the same data when only its busy state changes.
export function activityDetails(data: ActivityData, options: ActivityOptions): DockDetails {
  const rows = activityRows(data, options);
  return view("activity", rows.status, rows.cards);
}

// The ACC tab: the actions of the area chosen in MAIN. It is built from live state (the console asks again on every
// frame), so it follows the area and the dashboard's data without a load of its own.
export function actionsDetails(input: ActionsInput): DockDetails {
  const rows = actionsRows(input);
  return view("actions", rows.status, rows.cards);
}

// The ACT tab's data: `haril events` for the project, inside the range, or why there is none.
function loadActivityData(cwd: string, source: DockSource = {}): Promise<ActivityData> {
  return loadActivity(
    source.events ?? ((args) => runHaril(args, { cwd, timeoutMs: 8_000 })),
    source.projectSlug,
    source.activityRange ?? ALL_RANGE,
    source.now ?? Date.now,
    source.locale ?? "es",
  );
}

export async function loadDockDetails(
  id: DockId,
  cwd: string,
  source: DockSource = {},
): Promise<DockDetails> {
  const en = source.locale === "en";
  try {
    switch (id) {
      // MAIN has nothing to load: its content is the status block, which is drawn from live facts on every frame.
      case "main":
        return view(id, "", []);
      case "memory": {
        const data = await loadMemData(cwd, source);
        return memDetails(data, {
          locale: source.locale ?? "es",
          busy: source.busy,
          checkError: source.checkError,
        });
      }
      case "docs":
        return await docsDetails(id, cwd, source);
      case "activity": {
        const data = await loadActivityData(cwd, source);
        return activityDetails(data, {
          locale: source.locale ?? "es",
          range: source.activityRange ?? ALL_RANGE,
          busy: source.activityBusy ?? false,
          waiting: source.activityWaiting ?? false,
        });
      }
      // ACC has nothing to load either: the console hands in the area and its controls.
      case "actions":
        return source.actions === undefined ? view(id, "", []) : actionsDetails(source.actions);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return view(id, en ? "Could not read" : "No se pudo leer", [
      {
        title: en ? "Reason" : "Motivo",
        rows: linesOf(reason).flatMap((line) => wrap(line, ROW_WIDTH)),
      },
    ]);
  }
}
