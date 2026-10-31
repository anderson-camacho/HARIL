import { DASHBOARD_AREAS } from "./dashboard.js";
import { lineTone, paddedCell, visualText } from "./dashboard-theme.js";
import { keyOf } from "./orchestration-state.js";
import { plainText, truncate } from "./text.js";

export interface CommandDescription {
  readonly name: string;
  readonly description: string;
}

// What Pi reports for a registered command; only these members are read.
export interface RegisteredCommand {
  readonly name: string;
  readonly description?: string | undefined;
  readonly source?: string | undefined;
}

export interface RegisteredShortcut {
  readonly key: string;
  readonly description: string;
  readonly run?: () => void;
}

export type CatalogEntry =
  | {
      readonly kind: "command";
      readonly name: string;
      readonly description: string;
      readonly group: string;
    }
  | {
      readonly kind: "shortcut";
      readonly name: string;
      readonly description: string;
      readonly group: string;
      readonly run?: () => void;
    };

const STATUS_DESCRIPTION =
  "Estado de la sesión: avisos, extensiones, contexto, memoria / status, warnings, extensions, context";

const CONSOLE_COMMANDS: readonly CommandDescription[] = [
  { name: "language", description: "Idioma de la interfaz" },
  { name: "haril-status", description: STATUS_DESCRIPTION },
  { name: "haril-plugin", description: "Abrir o cambiar el espacio del dock izquierdo" },
  { name: "haril-plugins", description: "Mostrar, ocultar y ordenar espacios del dock" },
  { name: "haril-extensions", description: "Gestionar paquetes Pi declarados en HARIL" },
  { name: "haril-dock", description: "Mostrar u ocultar columnas" },
  { name: "haril-focus", description: "Abrir detalles de la sección actual" },
  { name: "haril-panel", description: "Abrir el menú de teclado del panel derecho" },
  { name: "haril-docs", description: "Conectar la carpeta de documentación (Obsidian)" },
  { name: "haril-commands", description: "Buscar en todos los comandos y atajos" },
  ...DASHBOARD_AREAS.map((area) => ({ name: area, description: `Abrir área ${area}` })),
];

export function statusCommandDescription(): string {
  return STATUS_DESCRIPTION;
}

// Pi's own commands: getCommands reports only extensions, prompts and skills, and this list is not in the extension API
// (Pi 1.2.0, core/slash-commands.js). A name an extension also registers is listed once, as the extension's.
const PI_COMMANDS: readonly CommandDescription[] = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model" },
  { name: "tree", description: "Navigate session tree" },
  { name: "thinking", description: "Set thinking level" },
  { name: "scoped-models", description: "Enable or disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "bug", description: "Report a bug to the Pi developers" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "trust", description: "Save project trust decision for future sessions" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  {
    name: "reload",
    description: "Reload keybindings, extensions, skills, prompts, themes, context",
  },
  { name: "quit", description: "Quit Pi" },
];

const COMMAND_NAME = /^[a-z][a-z0-9_:-]{0,63}$/i;

// Every command this session can run: what Pi reports now, HARIL's first with HARIL's own descriptions, then the other
// extensions, the prompts and skills, Pi's own, and the shortcuts as registered. A name Pi does not report is not listed
// from HARIL's descriptions, so a command that failed to register never appears.
export function catalogEntries(
  registered: readonly RegisteredCommand[],
  harilCommands: readonly CommandDescription[],
  shortcuts: readonly RegisteredShortcut[],
): CatalogEntry[] {
  const described = new Map(
    [...harilCommands, ...CONSOLE_COMMANDS].map((item) => [item.name, item.description]),
  );
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  const clean = registered.filter(({ name }) => {
    if (!COMMAND_NAME.test(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const sorted = [...clean].sort((a, b) => a.name.localeCompare(b.name));
  for (const { name } of sorted) {
    const own = described.get(name);
    if (own !== undefined)
      entries.push({ kind: "command", name, description: own, group: "HARIL" });
  }
  for (const { name, description, source } of sorted) {
    if (described.has(name)) continue;
    entries.push({
      kind: "command",
      name,
      description: plainText(description ?? ""),
      group: source === "prompt" ? "Prompt" : source === "skill" ? "Skill" : "Extensión",
    });
  }
  for (const { name, description } of PI_COMMANDS) {
    if (!seen.has(name)) entries.push({ kind: "command", name, description, group: "Pi" });
  }
  for (const { key, description, run } of shortcuts) {
    entries.push({
      kind: "shortcut",
      name: key,
      description,
      group: "Atajo",
      ...(run === undefined ? {} : { run }),
    });
  }
  return entries;
}

// Every word typed must appear in the name, the description or the group, in any order and any case.
export function filterCatalog(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((entry) => {
    const text = `${entry.name} ${entry.description} ${entry.group}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

const VISIBLE = 14;

// The searchable list of Alt+C and /haril-commands. Typing filters it, the arrows move, Enter chooses and Esc closes; a
// command is handed back for the editor (Pi offers no way to run another extension's command), a shortcut runs.
export function createCommandPicker(
  entries: readonly CatalogEntry[],
  done: (entry: CatalogEntry | undefined) => void,
  tui?: { requestRender(): void },
) {
  let query = "";
  let selected = 0;
  let closed = false;
  const shown = (): CatalogEntry[] => filterCatalog(entries, query);
  const finish = (entry: CatalogEntry | undefined): void => {
    closed = true;
    done(entry);
  };
  return {
    render(width: number): string[] {
      const span = Math.max(12, Math.min(width, 96));
      const inside = span - 2;
      const border = lineTone("teal", "accent");
      const side = visualText("│", border, "panel");
      const cell = (
        text: string,
        tone: "cyan" | "teal" | "yellow" | "text" | "muted",
        active = false,
      ): string =>
        `${side}${paddedCell(` ${text}`, inside, tone, active ? "selected" : "panel")}${side}`;
      const list = shown();
      const first = Math.max(0, Math.min(selected - VISIBLE + 1, list.length - VISIBLE));
      const rows = list.slice(first, first + VISIBLE).map((entry, index) => {
        const active = first + index === selected;
        const label = entry.kind === "command" ? `/${entry.name}` : entry.name;
        const line = `${active ? "▸" : " "} ${label.padEnd(20)} ${entry.group.padEnd(9)} ${entry.description}`;
        return cell(truncate(line, inside - 1), active ? "yellow" : "text", active);
      });
      return [
        visualText(`╭${"─".repeat(inside)}╮`, border, "panel"),
        cell(`Buscar: ${query}█`, "cyan"),
        cell(
          `${list.length}/${entries.length}  ·  ↑/↓ mover  ·  Enter elegir  ·  Esc cerrar`,
          "muted",
        ),
        ...(rows.length === 0 ? [cell("Sin resultados", "muted")] : rows),
        visualText(`╰${"─".repeat(inside)}╯`, border, "panel"),
      ];
    },
    handleInput(input: string): void {
      if (closed) return;
      const key = keyOf(input);
      const list = shown();
      if (key === "escape") {
        finish(undefined);
        return;
      }
      if (key === "enter") {
        finish(list[selected]);
        return;
      }
      if (key === "down") selected = list.length === 0 ? 0 : (selected + 1) % list.length;
      else if (key === "up")
        selected = list.length === 0 ? 0 : (selected + list.length - 1) % list.length;
      else if (input === "\u007f" || input === "\b") {
        query = Array.from(query).slice(0, -1).join("");
        selected = 0;
      } else if (Array.from(input).length === 1 && input >= " ") {
        query += input;
        selected = 0;
      } else return;
      tui?.requestRender();
    },
    invalidate() {},
  };
}
