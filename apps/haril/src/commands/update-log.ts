// What `haril update` shows (install-log, MIT, ascii-magic-art): a framed log with one row per component and a final bar,
// then a summary that stays on the screen: what went right, what to look at and what failed, each with what happened, the
// state it left and what to do. A row says ✓ only after its installed version was verified, and a component HARIL does not
// manage says so instead of a ✓. Pure: rows in, lines out. Without a terminal the same facts come out as plain lines.

export type ComponentState = "pending" | "running" | "ok" | "warning" | "failed" | "unmanaged";

export const NOT_MANAGED = "No lo gestiona HARIL";

export interface ComponentRow {
  readonly name: string;
  readonly state: ComponentState;
  readonly version: string | null;
  // In a few words, for its row.
  readonly status: string;
  // For the summary.
  readonly happened?: string;
  readonly result?: string;
  readonly todo?: string;
}

const SPINNER = "┤┘┴└├┌┬┐";
const BAR_WIDTH = 40;
const NAME_WIDTH = 13;
const VERSION_WIDTH = 10;

const INK = {
  text: "#e6edf3",
  muted: "#8b949e",
  green: "#7ee787",
  blue: "#79c0ff",
  orange: "#ffa657",
  red: "#ff7b72",
  dim: "#484f58",
  line: "#30363d",
} as const;
type Ink = keyof typeof INK;

function painter(color: boolean): (text: string, ink: Ink) => string {
  if (!color) return (text) => text;
  return (text, ink) => {
    const value = Number.parseInt(INK[ink].slice(1), 16);
    return `\u001b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m${text}\u001b[0m`;
  };
}

function width(text: string): number {
  return Array.from(text).length;
}

function cut(text: string, room: number): string {
  const chars = Array.from(text);
  if (chars.length <= room) return text;
  return room <= 0 ? "" : `${chars.slice(0, room - 1).join("")}…`;
}

function pad(text: string, room: number): string {
  const shown = cut(text, room);
  return `${shown}${" ".repeat(Math.max(0, room - width(shown)))}`;
}

const SETTLED = new Set<ComponentState>(["ok", "warning", "failed", "unmanaged"]);

export function progressOf(rows: readonly ComponentRow[]): number {
  return rows.length === 0 ? 0 : rows.filter((row) => SETTLED.has(row.state)).length / rows.length;
}

function mark(row: ComponentRow, tick: number): { text: string; ink: Ink } {
  switch (row.state) {
    case "ok":
      return { text: "✓", ink: "green" };
    case "warning":
      return { text: "!", ink: "orange" };
    case "failed":
      return { text: "✗", ink: "red" };
    case "unmanaged":
      return { text: "·", ink: "dim" };
    case "running":
      return { text: SPINNER[tick % SPINNER.length] as string, ink: "blue" };
    case "pending":
      return { text: " ", ink: "dim" };
  }
}

function statusInk(row: ComponentRow): Ink {
  if (row.state === "ok") return "blue";
  if (row.state === "warning") return "orange";
  if (row.state === "failed") return "red";
  if (row.state === "running") return "orange";
  return "dim";
}

export interface InstallLogOptions {
  readonly path: string;
  readonly color: boolean;
  readonly columns: number;
  readonly tick: number;
}

// The framed log, redrawn as it advances.
export function installLogLines(
  rows: readonly ComponentRow[],
  options: InstallLogOptions,
): string[] {
  const paint = painter(options.color);
  const total = Math.max(40, Math.min(options.columns, 100));
  const inner = total - 2;
  const titled = ` ${cut(options.path, inner - 6)} `;
  const top = `╭─${titled}${"─".repeat(Math.max(0, inner - 1 - width(titled)))}╮`;
  const side = paint("│", "dim");
  const row = (parts: readonly (readonly [string, Ink])[]): string => {
    let room = inner - 2;
    let out = " ";
    for (const [text, ink] of parts) {
      const shown = cut(text, room);
      out += paint(shown, ink);
      room -= width(shown);
    }
    return `${side}${out}${" ".repeat(Math.max(0, room + 1))}${side}`;
  };
  const done = rows.filter((item) => SETTLED.has(item.state)).length;
  const count = (state: ComponentState): number =>
    rows.filter((item) => item.state === state).length;
  const ratio = progressOf(rows);
  const bar = Math.min(BAR_WIDTH, Math.max(8, inner - 12));
  const filled = Math.round(ratio * bar);
  const running = rows.find((item) => item.state === "running");
  return [
    paint(top, "dim"),
    row([
      ["$ ", "green"],
      ["haril update", "text"],
    ]),
    row([
      ["Progreso: ", "muted"],
      [`${done} de ${rows.length} componentes`, "text"],
      [", correctos ", "muted"],
      [String(count("ok")), "text"],
      [", avisos ", "muted"],
      [String(count("warning")), "text"],
      [", fallos ", "muted"],
      [String(count("failed")), "text"],
      ...(done === rows.length ? ([[", listo", "green"]] as const) : []),
    ]),
    row([]),
    ...rows.map((item) => {
      const sign = mark(item, options.tick);
      return row([
        [sign.text, sign.ink],
        [" ", "dim"],
        [pad(item.name, NAME_WIDTH), "text"],
        [pad(item.version ?? "", VERSION_WIDTH), "muted"],
        [item.status, statusInk(item)],
      ]);
    }),
    row([]),
    row([
      [running === undefined ? " " : (SPINNER[options.tick % SPINNER.length] as string), "blue"],
      [" ", "dim"],
      ["█".repeat(filled), count("failed") > 0 ? "red" : "blue"],
      ["░".repeat(bar - filled), "line"],
      [` ${String(Math.round(ratio * 100)).padStart(3)}%`, "text"],
    ]),
    paint(`╰${"─".repeat(inner)}╯`, "dim"),
  ];
}

function section(
  rows: readonly ComponentRow[],
  title: string,
  sign: string,
  ink: Ink,
  paint: ReturnType<typeof painter>,
): string[] {
  if (rows.length === 0) return [];
  return [
    "",
    paint(title, ink),
    ...rows.flatMap((row) => [
      `${paint(sign, ink)} ${row.name}${row.version === null ? "" : ` ${row.version}`}`,
      ...(row.happened === undefined ? [] : [`    Pasó: ${row.happened}`]),
      ...(row.result === undefined ? [] : [`    Quedó: ${row.result}`]),
      ...(row.todo === undefined ? [] : [`    Qué hacer: ${row.todo}`]),
    ]),
  ];
}

// The summary that stays once the log stopped moving.
export function summaryLines(
  rows: readonly ComponentRow[],
  logPath: string | null,
  color: boolean,
): string[] {
  const paint = painter(color);
  const failed = rows.filter((row) => row.state === "failed");
  return [
    ...section(
      rows.filter((row) => row.state === "ok"),
      "Correcto",
      "✓",
      "green",
      paint,
    ),
    ...section(
      rows.filter((row) => row.state === "unmanaged"),
      "Fuera de HARIL",
      "·",
      "muted",
      paint,
    ),
    ...section(
      rows.filter((row) => row.state === "warning"),
      "Avisos",
      "!",
      "orange",
      paint,
    ),
    ...section(failed, "Fallos", "✗", "red", paint),
    "",
    failed.length === 0
      ? paint("Actualización terminada. Abre una terminal nueva antes de seguir.", "green")
      : paint("La actualización no quedó completa.", "red"),
    ...(logPath === null ? [] : [`Registro: ${logPath}`]),
  ];
}

const PLAIN_MARK: Readonly<Record<ComponentState, string>> = {
  pending: "espera",
  running: "corre",
  ok: "ok",
  warning: "aviso",
  failed: "fallo",
  unmanaged: "fuera",
};

// One line per component, without a terminal: for a pipe, a file or a test.
export function plainRowLine(row: ComponentRow): string {
  return `${PLAIN_MARK[row.state]}: ${row.name}${row.version === null ? "" : ` ${row.version}`}: ${row.status}`;
}

export function logFileText(rows: readonly ComponentRow[], header: readonly string[]): string {
  return `${[...header, ...rows.map(plainRowLine), ...summaryLines(rows, null, false)].join("\n")}\n`;
}
