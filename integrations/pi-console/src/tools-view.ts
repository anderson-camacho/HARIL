import { NOT_LAUNCHED } from "./cli.js";
import { tailFit } from "./docs-folder.js";
import { localized, type UiLocale } from "./locale.js";
import { wrap } from "./text.js";
import type {
  InstallFailureView,
  InstallView,
  MemoryView,
  ToolState,
  ToolsStatusView,
  ToolView,
} from "./tools-model.js";

// The MEM tab of the right panel: Engram, the memory process and gentle-ai, then the actions that act on them. It is
// built only from what the HARIL CLI printed (tools-model.ts parses it); nothing here reads a file or runs a command.

// Columns a row of the panel has for its text: its width less the border and the margin of each row.
const ROW_WIDTH = 38;
// The most "other copies" listed per tool, and the most lines a failure message takes.
const MAX_OTHERS = 3;
const MAX_REASON_LINES = 3;

// The id of each row a click (or the keyboard menu) can run; the console maps them to what they do.
export const TOOLS_ACTIONS = {
  ensure: "tools:ensure",
  force: "tools:force",
  refresh: "tools:refresh",
  update: "tools:update",
} as const;

// What the console is doing for the tab right now; while it does, the tab shows it instead of the action rows.
export type BusyKind = "check" | "ensure" | "force" | "refresh" | "plan" | "update";

// One of the two commands the tab reads: its parsed answer, or why there is none.
export type Loaded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface MemData {
  readonly tools: Loaded<ToolsStatusView>;
  readonly memory: Loaded<MemoryView>;
}

export interface MemOptions {
  readonly locale: UiLocale;
  readonly busy?: BusyKind | undefined;
  // Why the check the console ran at start-up gave no answer (a timeout, a CLI that could not run).
  readonly checkError?: string | undefined;
}

export interface MemRows {
  readonly status: string;
  readonly lines: string[];
  readonly actions: { line: number; action: string }[];
}

type Say = (english: string, spanish: string) => string;

const STATE_WORDS: Record<ToolState, readonly [string, string]> = {
  ok: ["ok", "ok"],
  missing: ["missing", "falta"],
  outdated: ["outdated", "desactualizado"],
  unknown: ["unknown", "desconocido"],
};

const ORIGIN_WORDS: Record<string, readonly [string, string]> = {
  haril: ["HARIL copy", "copia de HARIL"],
  config: ["memory.binary", "memory.binary"],
  path: ["PATH", "PATH"],
  "go-bin": ["go/bin", "go/bin"],
};

export function busyLabel(busy: BusyKind, say: Say): string {
  switch (busy) {
    case "check":
      return say("Checking Engram and gentle-ai", "Comprobando Engram y gentle-ai");
    case "ensure":
      return say("Checking and installing Engram", "Comprobando e instalando Engram");
    case "force":
      return say("Reinstalling Engram", "Reinstalando Engram");
    case "refresh":
      return say("Looking up the latest versions", "Consultando las últimas versiones");
    case "plan":
      return say("Preparing the gentle-ai update", "Preparando la actualización");
    case "update":
      return say(
        "Building gentle-ai with Go (this can take a while)",
        "Compilando gentle-ai con Go (puede tardar)",
      );
  }
}

const DATE_FORMATS = new Map<UiLocale, Intl.DateTimeFormat>();

// "30 oct, 15:00" or "Oct 30, 15:00" in the interface language; what is not a date is shown as it came.
function whenText(iso: string, locale: UiLocale): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  let format = DATE_FORMATS.get(locale);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    DATE_FORMATS.set(locale, format);
  }
  return format.format(new Date(at));
}

// A sentence indented under its section, broken to the panel's width.
function sentence(text: string, indent = 2): string[] {
  const pad = " ".repeat(indent);
  return wrap(text, ROW_WIDTH - indent).map((part) => `${pad}${part}`);
}

function originsText(origins: readonly string[], say: Say): string {
  return origins
    .map((origin) => {
      const words = ORIGIN_WORDS[origin];
      return words === undefined ? origin : say(words[0], words[1]);
    })
    .join(" + ");
}

function installText(install: InstallView, say: Say): string {
  const version = install.version ?? say("version ?", "versión ?");
  return install.origins.length === 0
    ? version
    : `${version} · ${originsText(install.origins, say)}`;
}

function stateWord(state: ToolState, say: Say): string {
  const words = STATE_WORDS[state];
  return say(words[0], words[1]);
}

// The install that runs: its version and where it came from, then its path (the end of it, which names the file).
function activeLines(tool: ToolView, say: Say): string[] {
  if (tool.active === undefined) return [];
  return [
    ...sentence(installText(tool.active, say)),
    `  ${tailFit(tool.active.path, ROW_WIDTH - 2)}`,
  ];
}

function latestLines(tool: ToolView, say: Say): string[] {
  return sentence(
    `${say("Latest published", "Última publicada")}: ${tool.latest ?? say("not checked", "sin consultar")}`,
  );
}

function othersLines(tool: ToolView, heading: string, say: Say): string[] {
  if (tool.others.length === 0) return [];
  const lines = sentence(heading);
  for (const other of tool.others.slice(0, MAX_OTHERS)) {
    lines.push(
      ...sentence(installText(other, say), 4),
      `    ${tailFit(other.path, ROW_WIDTH - 4)}`,
    );
  }
  const hidden = tool.others.length - MAX_OTHERS;
  if (hidden > 0) lines.push(`    ${say(`…and ${hidden} more`, `…y ${hidden} más`)}`);
  return lines;
}

function failureLines(failure: InstallFailureView, locale: UiLocale, say: Say): string[] {
  const message = wrap(failure.message, ROW_WIDTH - 2).slice(0, MAX_REASON_LINES);
  return [
    `  ${say("The last install failed:", "Falló la última instalación:")}`,
    ...message.map((part) => `  ${part}`),
    ...(failure.retryAt === null
      ? [`  ${say("A new attempt is allowed now.", "Ya se puede reintentar.")}`]
      : sentence(
          say(
            `Retries by itself from ${whenText(failure.retryAt, locale)}.`,
            `Reintenta sola desde ${whenText(failure.retryAt, locale)}.`,
          ),
        )),
  ];
}

function engramLines(
  tool: ToolView | undefined,
  failure: InstallFailureView | undefined,
  locale: UiLocale,
  say: Say,
): string[] {
  if (tool === undefined) {
    return ["Engram", ...sentence(say("No data for it.", "Sin datos."))];
  }
  const lines = [`Engram · ${stateWord(tool.state, say)}`];
  if (tool.active === undefined) {
    lines.push(`  ${say("No copy for HARIL to run.", "No hay copia que HARIL ejecute.")}`);
  } else {
    lines.push(...activeLines(tool, say));
  }
  if (tool.qualified !== null) {
    lines.push(...sentence(`${say("Qualified by HARIL", "Probada por HARIL")}: ${tool.qualified}`));
  }
  lines.push(...latestLines(tool, say));
  if (tool.newerUpstream && tool.latest !== null) {
    lines.push(
      ...sentence(
        say(
          `A newer one exists (${tool.latest}); HARIL will use it once it has qualified it.`,
          `Hay una más nueva (${tool.latest}); HARIL la usará cuando la pruebe.`,
        ),
      ),
    );
  }
  lines.push(
    ...othersLines(
      tool,
      say("Other copies (not used by HARIL):", "Otras copias, que HARIL no usa:"),
      say,
    ),
  );
  // A failure on record says nothing once the copy works: only an Engram that is not fine needs to show it.
  if (failure !== undefined && tool.state !== "ok")
    lines.push(...failureLines(failure, locale, say));
  return lines;
}

// The facts the CLI itself could not establish ("could not read the version...", "could not check the latest...").
function problemNotes(tool: ToolView): string[] {
  return tool.notes.filter((note) => /^could not |last check failed/.test(note)).slice(0, 2);
}

function gentleGuidance(tool: ToolView, say: Say): string | undefined {
  switch (tool.state) {
    case "outdated":
      return say(
        'A newer version exists: use "Update gentle-ai".',
        "Hay una versión más nueva: usa «Actualizar gentle-ai».",
      );
    case "missing":
      return say(
        'Not found. "Install gentle-ai" builds it with Go.',
        "No se encontró. «Instalar gentle-ai» lo compila con Go.",
      );
    case "unknown":
      return tool.active?.version === null || tool.active === undefined
        ? undefined
        : say(
            'The latest version was never checked: use "Check versions now".',
            "No se consultó la última versión: usa «Comprobar versiones ahora».",
          );
    case "ok":
      return undefined;
  }
}

function gentleLines(tool: ToolView | undefined, say: Say): string[] {
  if (tool === undefined) return ["gentle-ai", ...sentence(say("No data for it.", "Sin datos."))];
  const lines = [`gentle-ai · ${stateWord(tool.state, say)}`];
  lines.push(...activeLines(tool, say));
  lines.push(...latestLines(tool, say));
  const guidance = gentleGuidance(tool, say);
  if (guidance !== undefined) lines.push(...sentence(guidance));
  if (tool.active?.origins.includes("go-bin") && !tool.active.origins.includes("path")) {
    lines.push(
      ...sentence(
        say(
          "It is only in go/bin, which is not on PATH.",
          "Solo está en go/bin, que no está en el PATH.",
        ),
      ),
    );
  }
  lines.push(
    ...othersLines(
      tool,
      say("Other copies, which do not run:", "Otras copias, que no se ejecutan:"),
      say,
    ),
  );
  for (const note of problemNotes(tool)) lines.push(...sentence(note));
  return lines;
}

function healthWord(health: string, say: Say): string {
  return health === "not_checked" ? say("not checked", "sin comprobar") : health;
}

// `engramReady`: Engram runs from HARIL's own copy, so a runtime that was started before it only needs a restart.
function memoryLines(memory: MemoryView, engramReady: boolean, say: Say): string[] {
  const none = memory.provider === "null";
  const lines = [
    none
      ? say("Memory process · NOT SAVING", "Proceso de memoria · NO GUARDA")
      : say("Memory process", "Proceso de memoria"),
  ];
  if (none) {
    lines.push(`  ${say("Provider: null (keeps nothing)", "Proveedor: null (no guarda nada)")}`);
  } else {
    const kept =
      memory.persistent === null
        ? ""
        : ` · ${memory.persistent ? say("persistent", "persistente") : say("not persistent", "no persistente")}`;
    lines.push(...sentence(`${say("Provider", "Proveedor")}: ${memory.provider}${kept}`));
  }
  lines.push(
    `  Runtime: ${memory.running ? say("running", "en marcha") : say("not running", "parado")}`,
    ...sentence(`${say("Health", "Salud")}: ${healthWord(memory.health, say)}`),
  );
  const errorText = memory.lastErrorCode === undefined ? "" : ` (${memory.lastErrorCode})`;
  lines.push(
    ...sentence(
      `${say("Degraded", "Degradada")}: ${memory.degraded ? say("yes", "sí") : "no"}${errorText}`,
    ),
  );
  lines.push(
    ...sentence(
      `${say("Queue", "Cola")}: ${say(`${memory.outboxDepth} to deliver`, `${memory.outboxDepth} por entregar`)}`,
    ),
  );
  if (!memory.initialized) {
    lines.push(`  ${say("Store not initialized.", "Almacén sin inicializar.")}`);
  }
  if (none) {
    lines.push(
      ...sentence(
        engramReady
          ? say(
              "Engram is ready: restart the runtime so it uses it (haril.json: memory.provider = engram).",
              "Engram está listo: reinicia el runtime para que lo use (haril.json: memory.provider = engram).",
            )
          : say(
              'To turn Engram on: "Check and install Engram" (or haril tools ensure), then restart the runtime.',
              "Para activar Engram: «Comprobar e instalar Engram» (o haril tools ensure) y reinicia el runtime.",
            ),
      ),
    );
  }
  return lines;
}

// Why a part has no answer, in at most a few lines of the panel's width.
function reasonLines(reason: string): string[] {
  return reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .flatMap((line) => sentence(line))
    .slice(0, MAX_REASON_LINES);
}

function actionLabels(data: MemData, say: Say): { action: string; label: string }[] {
  const gentle = data.tools.ok ? data.tools.value.gentleAi : undefined;
  return [
    {
      action: TOOLS_ACTIONS.ensure,
      label: say("Check and install Engram", "Comprobar e instalar Engram"),
    },
    {
      action: TOOLS_ACTIONS.force,
      label: say("Force reinstall Engram", "Reinstalar Engram (forzar)"),
    },
    {
      action: TOOLS_ACTIONS.refresh,
      label: say("Check versions now", "Comprobar versiones ahora"),
    },
    {
      action: TOOLS_ACTIONS.update,
      label:
        gentle?.state === "missing"
          ? say("Install gentle-ai…", "Instalar gentle-ai…")
          : say("Update gentle-ai…", "Actualizar gentle-ai…"),
    },
  ];
}

// This Pi was not opened by haril: no command can run, so there is nothing to offer.
function cannotAct(data: MemData): boolean {
  const reasons = [data.tools, data.memory].flatMap((part) => (part.ok ? [] : [part.reason]));
  return reasons.length === 2 && reasons.every((reason) => reason === NOT_LAUNCHED);
}

export function memRows(data: MemData, options: MemOptions): MemRows {
  const say: Say = (english, spanish) => localized(options.locale, english, spanish);
  const lines: string[] = [];
  const actions: { line: number; action: string }[] = [];

  if (data.tools.ok) {
    lines.push(
      ...engramLines(data.tools.value.engram, data.tools.value.failure, options.locale, say),
    );
  } else {
    lines.push(
      say("Engram and gentle-ai · not available", "Engram y gentle-ai · no disponible"),
      ...reasonLines(data.tools.reason),
    );
  }
  lines.push("");

  if (data.memory.ok) {
    lines.push(
      ...memoryLines(
        data.memory.value,
        data.tools.ok && data.tools.value.engram?.state === "ok",
        say,
      ),
    );
  } else {
    lines.push(
      say("Memory process · not available", "Proceso de memoria · no disponible"),
      ...reasonLines(data.memory.reason),
    );
  }

  if (data.tools.ok) lines.push("", ...gentleLines(data.tools.value.gentleAi, say));

  if (options.checkError !== undefined) {
    lines.push(
      "",
      say("Start-up check", "Comprobación al arrancar"),
      ...sentence(say(`failed: ${options.checkError}`, `falló: ${options.checkError}`)),
    );
  }

  if (options.busy !== undefined) {
    // The row that says what runs; a longer one goes on under it, indented.
    const [first = "", ...rest] = wrap(`… ${busyLabel(options.busy, say)}`, ROW_WIDTH - 2);
    lines.push("", first, ...rest.map((part) => `  ${part}`));
  } else if (!cannotAct(data)) {
    lines.push("");
    for (const { action, label } of actionLabels(data, say)) {
      actions.push({ line: lines.length, action });
      lines.push(`▸ ${label}`);
    }
  }
  return {
    status: say("Memory and tools", "Memoria y herramientas"),
    lines,
    actions,
  };
}
