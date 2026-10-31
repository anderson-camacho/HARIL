import { cliAvailable, runHaril } from "./cli.js";
import { type DocsScan, scanDocsFolder, tailFit } from "./docs-folder.js";
import { localized, type UiLocale } from "./locale.js";
import { DOCK_LABELS, type DockId } from "./native-panes.js";
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
// Columns a row of the right panel has for its text: the panel is 40 wide, less its border and the margin of each row.
// A row is one line of the view, so what is wider is cut by the pane; the DOCS view wraps or shortens its own rows
// instead.
const ROW_WIDTH = 38;

export interface DockDetails {
  readonly id: DockId;
  readonly title: string;
  readonly status: string;
  readonly lines: readonly string[];
  // A click on a detail row runs the action declared for its line. The pane reads this for whichever tab is selected.
  readonly actions?: readonly { line: number; action: string }[];
}

// What a command printed.
interface CommandAnswer {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DockSource {
  // `haril memory status --json`: the memory process, for the MEM tab.
  readonly memory?: () => Promise<CommandAnswer>;
  // `haril tools status --json`: Engram and gentle-ai, for the MEM tab.
  readonly tools?: () => Promise<CommandAnswer>;
  // What the console is doing for the MEM tab now, and why the check it ran at start-up gave no answer.
  readonly busy?: BusyKind | undefined;
  readonly checkError?: string | undefined;
  // The documentation folder the user connected: its path, or undefined when none is. Rejects with the reason when
  // haril.json cannot be read.
  readonly docsPath?: () => Promise<string | undefined>;
  // What is in that folder (read only).
  readonly scanDocs?: (path: string) => Promise<DocsScan>;
  readonly locale?: UiLocale;
}

function linesOf(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => plainText(line.trimEnd()))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

function view(
  id: DockId,
  status: string,
  lines: readonly string[],
  actions?: readonly { line: number; action: string }[],
): DockDetails {
  return {
    id,
    title: DOCK_LABELS.find((slot) => slot.id === id)?.label ?? id,
    status,
    lines: lines.slice(0, MAX_LINES),
    ...(actions === undefined ? {} : { actions }),
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

  const lines: string[] = [];
  const actions: { line: number; action: string }[] = [];
  const addAction = (label: string, action: string): void => {
    actions.push({ line: lines.length, action });
    lines.push(`▸ ${label}`);
  };

  if (path === undefined) {
    lines.push(say("No folder connected.", "Sin carpeta conectada."));
    lines.push(
      ...wrap(
        say(
          "Connect your documentation folder (for example your Obsidian vault).",
          "Conecta tu carpeta de documentación (por ejemplo la bóveda de Obsidian).",
        ),
        ROW_WIDTH,
      ),
    );
    lines.push("");
    addAction(say("Set folder…", "Definir carpeta…"), "docs:set");
    return view(id, status, lines, actions);
  }

  const scanned = await (source.scanDocs ?? scanDocsFolder)(path);
  if (!scanned.exists || !scanned.isDirectory) {
    const message = scanned.exists
      ? say("Not a folder:", "No es una carpeta:")
      : say("Folder not found:", "Carpeta no encontrada:");
    if (textWidth(`${message} ${path}`) <= ROW_WIDTH) {
      lines.push(`${message} ${path}`);
    } else {
      lines.push(message, tailFit(path, ROW_WIDTH));
    }
  } else {
    const count = `${scanned.noteCount}${scanned.truncated ? "+" : ""}`;
    const single = scanned.noteCount === 1 && !scanned.truncated;
    lines.push(tailFit(path, ROW_WIDTH));
    lines.push(
      locale === "es"
        ? `${count} ${single ? "nota" : "notas"} .md`
        : `${count} .md ${single ? "note" : "notes"}`,
    );
    lines.push("");
    if (scanned.latest.length === 0) {
      lines.push(say("No .md notes yet.", "Sin notas .md todavía."));
    } else {
      lines.push(say("Latest notes:", "Últimas notas:"));
      for (const note of scanned.latest) {
        const date = noteDate(note.mtimeMs, locale);
        lines.push(`${date} ${tailFit(note.rel, ROW_WIDTH - textWidth(date) - 1)}`);
      }
    }
  }
  lines.push("");
  addAction(say("Change folder…", "Cambiar carpeta…"), "docs:set");
  addAction(say("Disconnect", "Desconectar"), "docs:clear");
  return view(id, status, lines, actions);
}

// One of the two commands of the MEM tab: its answer parsed, or the reason there is none. The exit code does not decide
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

// Both commands of the MEM tab, asked at the same time: one that fails must not blank the other.
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

// The MEM tab from what was loaded; the console draws it again from the same data when only its busy state changes.
export function memDetails(data: MemData, options: MemOptions): DockDetails {
  const rows = memRows(data, options);
  return view(
    "memory",
    rows.status,
    rows.lines,
    rows.actions.length === 0 ? undefined : rows.actions,
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
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return view(
      id,
      en ? "Could not read" : "No se pudo leer",
      linesOf(reason).flatMap((line) => wrap(line, ROW_WIDTH)),
    );
  }
}
