import { renderBrandArt, renderBrandMark } from "./dashboard-art.js";
import { controlsFor, type DashboardAction } from "./dashboard-controls.js";
import type { DashboardData } from "./dashboard-data.js";
import { frameGlyph, paddedCell, visualText } from "./dashboard-theme.js";
import { delegationSummary } from "./delegation-settings.js";
import { DEFAULT_UI_LOCALE, type UiLocale } from "./locale.js";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./orchestration-draw.js";
import type { OrchestrationState, OrchestrationTarget } from "./orchestration-state.js";
import { renderOrchestrationSummary } from "./orchestration-view.js";
import type { ConsoleTheme, ThemeColor } from "./pi-types.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

// The five modules (spec 7.8): WORKFLOWS retired, its methodologies are in TOOLS (P19) and a workflow is seen in
// ORCHESTRATION.
export const DASHBOARD_AREAS = [
  "agents",
  "orchestration",
  "automation",
  "tools",
  "everywhere",
] as const;
export type DashboardArea = (typeof DASHBOARD_AREAS)[number];

export interface DashboardFacts {
  readonly locale?: UiLocale;
  readonly project: string;
  readonly cwd: string;
  readonly branch: string | null | undefined;
  // The model and its reasoning level ("<model> · <level>", "<model> · no reasoning" or "no model selected").
  readonly modelLevel: string;
  readonly providers: readonly string[];
  readonly runtime: string;
  readonly runtimeAvailable: boolean;
  readonly pending: number | undefined;
  readonly context: string;
  readonly cost: string;
  readonly activeTools: readonly string[];
  readonly tools: readonly {
    readonly name: string;
    readonly active: boolean;
    readonly description?: string;
  }[];
  readonly commands: readonly string[];
  readonly mcpServers: readonly string[];
  readonly extensionStatuses: readonly string[];
  // Observed Pi extension statuses, not the full list of loaded extension packages.
  readonly mode?: string;
  readonly logFailures?: number;
  readonly providerWarnings?: readonly string[];
  readonly memory: string;
  readonly data: DashboardData;
  readonly loading: boolean;
  // The ORCHESTRATION view's state (shared with its full-view overlay) and the glyph set it draws with.
  readonly orchestration: OrchestrationState;
  readonly asciiGlyphs: boolean;
}

export type RailSection = "actions" | "warnings" | "extensions" | "status" | "orchestration";

export interface HeaderLayout {
  readonly lines: string[];
  // Clickable HARIL cards in the header (Pi doesn't expose side-by-side editor panes).
  readonly railHits?: readonly {
    readonly row: number;
    readonly start: number;
    readonly end: number;
    readonly action: "focus" | "details" | "toggle" | "run" | "mode" | "menu" | "area";
    readonly section?: RailSection;
    readonly control?: DashboardAction;
    // Which area an "area" row opens.
    readonly area?: DashboardArea;
  }[];
  readonly tabHits: readonly {
    readonly row: number;
    readonly start: number;
    readonly end: number;
    readonly area: DashboardArea;
  }[];
}

export interface DashboardLayout {
  readonly lines: string[];
  readonly controlHits: readonly {
    readonly row: number;
    readonly start: number;
    readonly end: number;
    readonly action: DashboardAction;
  }[];
  // Hit-boxes of the ORCHESTRATION summary: its rows, view buttons, "Open full view" and "Stop all".
  readonly orchestrationHits: readonly {
    readonly row: number;
    readonly start: number;
    readonly end: number;
    readonly target: OrchestrationTarget;
  }[];
}

export interface FooterNavigationLayout {
  readonly lines: string[];
  readonly tabHits: HeaderLayout["tabHits"];
}

const LABELS: Readonly<Record<DashboardArea, string>> = {
  agents: "AGENTS",
  orchestration: "ORCHESTRATION",
  automation: "AUTOMATION",
  tools: "TOOLS",
  everywhere: "EVERYWHERE",
};
const YELLOW: ThemeColor = "warning";

function fit(text: string, width: number): string {
  return truncate(plainText(text), Math.max(0, width));
}

function border(width: number, left: string, middle: string, right: string): string {
  return width < 2
    ? ""
    : `${frameGlyph(left)}${frameGlyph(middle.repeat(width - 2))}${frameGlyph(right)}`;
}

function boxRow(
  text: string,
  width: number,
  _theme: ConsoleTheme,
  tone: ThemeColor = "text",
): string {
  if (width < 2) return "";
  const inside = width - 2;
  const content = fit(` ${text}`, inside);
  const dashboardTone =
    tone === "error"
      ? "error"
      : tone === "warning"
        ? "yellow"
        : tone === "success"
          ? "teal"
          : "text";
  return `${frameGlyph("│")}${paddedCell(content, inside, dashboardTone)}${frameGlyph("│")}`;
}

function tabs(
  width: number,
  selected: DashboardArea | undefined,
): {
  lines: string[];
  hits: HeaderLayout["tabHits"];
} {
  const usable = Math.max(1, width - 4);
  const rows: {
    items: { label: string; area: DashboardArea; start: number; end: number }[];
    width: number;
  }[] = [];
  let current = {
    items: [] as { label: string; area: DashboardArea; start: number; end: number }[],
    width: 0,
  };
  for (const [index, area] of DASHBOARD_AREAS.entries()) {
    let label = `${selected === area ? "▶" : ""}[${index + 1} ${LABELS[area]}]`;
    if (textWidth(label) > usable)
      label = usable >= 3 ? `[${index + 1}]` : usable >= 2 ? `>${index + 1}` : `${index + 1}`;
    const gap = current.items.length === 0 ? 0 : 1;
    if (current.items.length > 0 && current.width + gap + textWidth(label) > usable) {
      rows.push(current);
      current = { items: [], width: 0 };
    }
    const start = current.width + (current.items.length === 0 ? 0 : 1);
    current.items.push({ label, area, start, end: start + textWidth(label) });
    current.width = start + textWidth(label);
  }
  if (current.items.length > 0) rows.push(current);
  const tabHits = rows.flatMap((row, rowIndex) =>
    row.items.map((segment) => ({
      row: rowIndex,
      start: segment.start + 3,
      end: segment.end + 3,
      area: segment.area,
    })),
  );
  return {
    lines: rows.map((row) => {
      const chunks = row.items.map((item) =>
        visualText(
          item.label,
          item.area === selected ? "yellow" : "cyan",
          item.area === selected ? "selected" : "panel",
        ),
      );
      return `  ${chunks.join(" ")}`;
    }),
    hits: tabHits,
  };
}

function frameRow(text: string, width: number, tone: "cyan" | "teal" | "yellow" = "cyan"): string {
  if (width < 2) return "";
  return `${frameGlyph("│")}${paddedCell(` ${text}`, width - 2, tone)}${frameGlyph("│")}`;
}

// Pi's extension API exposes statuses, not its startup inventory of loaded extensions.
// The HARIL rail lives in the header: Pi 1.2.0 does not expose a full-height split-pane API.
const RIGHT_RAIL_MIN_COLUMNS = 120;
const RIGHT_RAIL_MIN_ROWS = 40;

// What the rail lists under AVISOS: the provider warnings, the data errors and a failing activity log. The bottom bar
// counts the same list, so the number there is the one the sidebar shows.
export function railWarnings(
  facts: Pick<DashboardFacts, "providerWarnings" | "logFailures"> & {
    readonly data: Pick<DashboardData, "errors">;
  },
): string[] {
  return [
    ...new Set([
      ...(facts.providerWarnings ?? []),
      ...facts.data.errors,
      ...((facts.logFailures ?? 0) > 0
        ? [`Activity log: ${facts.logFailures} failed record(s)`]
        : []),
    ]),
  ];
}

type RailHit = NonNullable<HeaderLayout["railHits"]>[number];
// What a click on a rail row asks for, without the header's screen coordinates: the native dock hit-tests by row.
export type RailHitAction = Pick<RailHit, "action" | "section" | "control" | "area">;
interface RailRow {
  readonly line: string;
  readonly hit?: RailHitAction;
}

// The rail body of the native full-height dock: its rows and, aligned with them, the action a click on each runs.
export interface NativeRailContent {
  readonly lines: string[];
  readonly hits: readonly (RailHitAction | undefined)[];
}

// Sections open by default; a user toggle (rail-actions.ts) overrides it.
const SECTIONS_OPEN_BY_DEFAULT: readonly RailSection[] = ["actions", "warnings", "orchestration"];

export function railSectionOpen(
  expanded: Readonly<Partial<Record<RailSection, boolean>>>,
  section: RailSection,
): boolean {
  return expanded[section] ?? SECTIONS_OPEN_BY_DEFAULT.includes(section);
}

function eyeTone(facts: DashboardFacts): "teal" | "yellow" | "error" {
  // A small, steady indicator driven by measurable context usage or active workers.
  // It is NOT a guess about the AI's internal feelings or effort.
  const context = Number.parseFloat(facts.context);
  const workers = facts.orchestration.snapshot?.capacity.executors;
  if (
    context >= 85 ||
    (workers !== undefined && workers.max > 0 && workers.live / workers.max >= 0.8)
  )
    return "error";
  if (facts.runtime === "running" || (workers?.live ?? 0) > 0) return "yellow";
  return "teal";
}

interface RailOptions {
  // `showKeys` puts the [D]-style prefix before each action. The classic header keeps it from before; the native rail
  // leaves it out, because that rail takes no key presses and the prefix read as a shortcut (Alt+K opens its menu).
  readonly showKeys: boolean;
  // `areas` adds the clickable list of areas and the orchestration view. The classic header has its own row of area
  // tabs and a bounded height, so it leaves the list out.
  readonly areas: boolean;
}

function rightRailContent(
  facts: DashboardFacts,
  area: DashboardArea | undefined,
  width: number,
  expanded: Readonly<Partial<Record<RailSection, boolean>>>,
  options: RailOptions,
): RailRow[] {
  const rows: RailRow[] = [];
  const warnings = railWarnings(facts);
  const mode = facts.mode ?? "unknown";
  const currentArea = area ?? "tools";
  const lang = facts.locale ?? DEFAULT_UI_LOCALE;
  const tr = (english: string, spanish: string): string => (lang === "es" ? spanish : english);
  const controls = controlsFor(
    currentArea,
    facts.data,
    facts.runtime,
    facts.runtimeAvailable,
    facts.orchestration.demo,
    facts.locale ?? DEFAULT_UI_LOCALE,
  );
  const isExpanded = (section: RailSection): boolean => railSectionOpen(expanded, section);
  const add = (
    content: string,
    tone: "cyan" | "teal" | "yellow" | "text" | "muted" | "error",
    hit?: RailRow["hit"],
  ) => rows.push({ line: paddedCell(` ${content}`, width, tone, "panel"), hit });
  const section = (name: string, id: RailSection, count?: number) => {
    const countLabel = count === undefined ? "" : ` · ${count}`;
    add(
      `${isExpanded(id) ? "▼" : "▶"} ${name}${countLabel}`,
      id === "warnings" && warnings.length ? "yellow" : "cyan",
      { action: "toggle", section: id },
    );
  };

  const statusEye = visualText("◉", eyeTone(facts), "panel");
  rows.push({
    line:
      statusEye +
      paddedCell(` HARIL · ${LABELS[currentArea]} · panel`, width - 1, "yellow", "panel"),
    hit: { action: "focus" },
  });
  add(`${tr("I am in", "Estoy en")}: ${facts.cwd}`, "muted", { action: "focus" });
  add(`${tr("Mode", "Modo")}: ${mode}  ·  ${tr("change", "cambiar")} ↗`, "yellow", {
    action: "mode",
  });
  add(`${tr("Project", "Proyecto")}: ${facts.project}`, "muted");
  add(`${tr("Model", "Modelo")}: ${facts.modelLevel}`, "text");

  if (options.areas) {
    add(tr("AREAS", "ÁREAS"), "cyan");
    for (const candidate of DASHBOARD_AREAS) {
      add(
        `${candidate === currentArea ? "●" : "○"} ${LABELS[candidate]}`,
        candidate === currentArea ? "yellow" : "text",
        { action: "area", area: candidate },
      );
    }
    add(tr("Open orchestration view", "Abrir vista de orquestación"), "teal", {
      action: "run",
      control: "orchestration-view",
    });
  }

  section(tr("WARNINGS", "AVISOS"), "warnings", warnings.length);
  if (isExpanded("warnings")) {
    if (warnings.length === 0) add(tr("No known warnings", "Sin alertas conocidas"), "muted");
    else {
      for (const warning of warnings.slice(0, 3))
        add(`! ${warning}`, "error", { action: "details" });
      if (warnings.length > 3)
        add(`+ ${warnings.length - 3} avisos · clic para ver todos`, "yellow", {
          action: "details",
        });
    }
  }

  section(tr("EXTENSIONS", "EXTENSIONES"), "extensions", facts.extensionStatuses.length);
  if (isExpanded("extensions")) {
    if (facts.extensionStatuses.length === 0) {
      add("Pi no expone inventario completo", "muted");
    } else {
      for (const status of facts.extensionStatuses.slice(0, 3))
        add(`• ${status}`, "text", { action: "details" });
      if (facts.extensionStatuses.length > 3)
        add(`+ ${facts.extensionStatuses.length - 3} estados · ver detalles`, "yellow", {
          action: "details",
        });
    }
  }

  if (currentArea === "orchestration") {
    section("ORQUESTACIÓN", "orchestration");
    if (isExpanded("orchestration")) {
      const snapshot = facts.orchestration.snapshot;
      if (snapshot === undefined) add("Sin workflow seleccionado", "muted", { action: "focus" });
      else {
        add(`Estado: ${snapshot.workflow.state}`, "text", { action: "focus" });
        add(
          `Agentes: ${snapshot.totals.agentsCreated}/${snapshot.totals.agentsCap} · cola: ${snapshot.totals.queued}`,
          "text",
          { action: "focus" },
        );
      }
    }
  }

  section(tr("SESSION", "SESIÓN"), "status");
  if (isExpanded("status")) {
    // The project and the model are the two rows at the top; the session adds what they do not say.
    add(`Runtime: ${facts.runtime}`, "text");
    add(`${tr("Memory", "Memoria")}: ${facts.memory}`, "text");
  }
  section(`${tr("ACTIONS", "ACCIONES")} · ${LABELS[currentArea]}`, "actions", controls.length);
  if (isExpanded("actions")) {
    for (const control of controls) {
      add(options.showKeys ? `[${control.hint}] ${control.label}` : control.label, "teal", {
        action: "run",
        control: control.action,
      });
    }
    add(tr("↗ Open full /haril menu", "↗ Abrir menú completo /haril"), "muted", { action: "menu" });
  }

  return rows;
}

// The native full-height right dock reuses the same live facts as the legacy header rail. Its lines are rendered
// inside a dedicated Pi layout component, not within the header, so the status and the actions can remain visible.
export function renderNativeRailContent(
  facts: DashboardFacts,
  area: DashboardArea | undefined,
  width: number,
  expanded: Readonly<Partial<Record<RailSection, boolean>>>,
): NativeRailContent {
  const safeWidth = Math.max(1, width);
  const body = rightRailContent(facts, area, safeWidth, expanded, { showKeys: false, areas: true });
  const rows = body.map((item) => item.line);
  // Only the rail body is clickable; the key hints below it carry no action. The recent events are the ACT tab's.
  const hits: (RailHitAction | undefined)[] = body.map((item) => item.hit);
  const add = (line: string, tone: "cyan" | "teal" | "muted" | "text" = "text") => {
    rows.push(paddedCell(` ${line}`, safeWidth, tone, "panel"));
    hits.push(undefined);
  };
  add("", "muted");
  // Two rows: all four hints do not fit the rail's 39 columns on one.
  add("Alt+K menú del panel · Alt+H áreas", "muted");
  add("Alt+I panel · Alt+C comandos", "muted");
  return { lines: rows, hits };
}

function wideHeader(
  width: number,
  version: string | undefined,
  facts: DashboardFacts,
  selected: DashboardArea | undefined,
  height: number,
  expanded: Readonly<Partial<Record<RailSection, boolean>>>,
): HeaderLayout {
  const inside = width - 2;
  // Right-hand panel is bounded: do not reduce the chat to a few rows.
  const railWidth = Math.min(56, Math.max(42, Math.floor(width * 0.3)));
  const leftWidth = inside - railWidth - 1;
  const tabLayout = tabs(width, selected);
  const title = ` ${renderBrandMark()} :: SESSION INIT  ·  ${version ?? "HARIL"} `;
  const rows = [border(width, "┌", "─", "┐"), frameRow(title, width, "yellow")];
  const left = [
    paddedCell(` ${renderBrandMark()}`, leftWidth, "yellow", "base"),
    ...renderBrandArt().map((part) => paddedCell(` ${part}`, leftWidth, "teal", "base")),
    paddedCell(" Many minds. One flow.", leftWidth, "yellow", "base"),
    paddedCell(" Alt+H áreas · Alt+I panel · Alt+C comandos", leftWidth, "text", "base"),
  ];
  const right = rightRailContent(facts, selected, railWidth, expanded, {
    showKeys: true,
    areas: false,
  });
  const budget = Math.max(10, Math.min(24, height - 18));
  const clipped = right.length > budget;
  const shown = clipped
    ? [
        ...right.slice(0, budget - 1),
        {
          line: paddedCell(
            ` … ${right.length - budget + 1} filas ocultas · /haril`,
            railWidth,
            "yellow",
            "panel",
          ),
          hit: { action: "menu" as const },
        },
      ]
    : right;
  const contentRows = Math.max(left.length, shown.length);
  const railHits: RailHit[] = [];
  for (let index = 0; index < contentRows; index++) {
    const leftCell = left[index] ?? paddedCell("", leftWidth, "text", "base");
    const rightCell = shown[index]?.line ?? paddedCell("", railWidth, "text", "panel");
    const row = rows.length;
    rows.push(`${frameGlyph("│")}${leftCell}${frameGlyph("│")}${rightCell}${frameGlyph("│")}`);
    const hit = shown[index]?.hit;
    if (hit !== undefined) {
      railHits.push({
        row,
        start: leftWidth + 2,
        end: width - 1,
        ...hit,
      });
    }
  }
  rows.push(
    frameRow(
      `MEMORY ${facts.memory} · CONTEXT ${facts.context} · COST ${facts.cost}`,
      width,
      "yellow",
    ),
  );
  const tabRow = rows.length;
  rows.push(
    ...tabLayout.lines.map(
      (line) =>
        `${frameGlyph("│")}${paddedCell(line.trimEnd(), inside, "cyan", "base")}${frameGlyph("│")}`,
    ),
  );
  rows.push(border(width, "└", "─", "┘"));
  return {
    lines: rows,
    railHits,
    tabHits: tabLayout.hits.map((hit) => ({ ...hit, row: hit.row + tabRow })),
  };
}

export function renderHeaderLayout(
  version: string | undefined,
  width: number,
  facts: DashboardFacts,
  selected: DashboardArea | undefined,
  _theme: ConsoleTheme,
  height = 24,
  railVisible = true,
  expanded: Readonly<Partial<Record<RailSection, boolean>>> = {},
): HeaderLayout {
  if (width < 10) return { lines: [fit(renderBrandMark(), width)], tabHits: [] };
  if (railVisible && width >= RIGHT_RAIL_MIN_COLUMNS && height >= RIGHT_RAIL_MIN_ROWS)
    return wideHeader(width, version, facts, selected, height, expanded);
  const tabLayout = tabs(width, selected);
  // Wide and sufficiently tall consoles show a static, non-blinking terminal logo.
  // Compact terminals keep the single-line mark instead of consuming chat space.
  const brandRows =
    width >= 90 && height >= 30
      ? [
          ...renderBrandArt().map((line) => frameRow(line, width, "teal")),
          frameRow(
            "Many minds. One flow.   ·   Alt+H: areas   ·   /haril: actions",
            width,
            "yellow",
          ),
        ]
      : [];
  const rows = [
    border(width, "┌", "─", "┐"),
    `${frameGlyph("│")}${paddedCell(` ${renderBrandMark()} ${version ?? ""}`, width - 2, "yellow")}${frameGlyph("│")}`,
    ...brandRows,
    `${frameGlyph("│")}${paddedCell(` ${facts.project} · ${facts.modelLevel} · ${facts.runtime} · Alt+I panel · /haril menú`, width - 2, "teal")}${frameGlyph("│")}`,
    ...tabLayout.lines.map(
      (line) =>
        `${frameGlyph("│")}${paddedCell(line.trimEnd(), width - 2, "cyan")}${frameGlyph("│")}`,
    ),
    border(width, "└", "─", "┘"),
  ];
  return {
    lines: rows,
    tabHits: tabLayout.hits.map((hit) => ({ ...hit, row: hit.row + 3 + brandRows.length })),
  };
}

// The clickable areas line under the bar. `barLines` is how many lines the bar above it takes (two when it is the full
// bar, one when it is compact), because the hit rows are counted from the top of the footer.
export function renderFooterNavigation(
  width: number,
  selected: DashboardArea | undefined,
  _theme: ConsoleTheme,
  barLines = 2,
): FooterNavigationLayout {
  const layout = tabs(width, selected);
  return {
    lines: layout.lines,
    tabHits: layout.hits.map((hit) => ({
      ...hit,
      row: hit.row + barLines,
      start: Math.max(0, hit.start - 1),
      end: hit.end - 1,
    })),
  };
}

function linesFor(area: DashboardArea, facts: DashboardFacts): string[] {
  const data = facts.data;
  const observed = new Map<string, number>();
  for (const task of data.tasks) observed.set(task.agent, (observed.get(task.agent) ?? 0) + 1);
  switch (area) {
    case "agents":
      return [
        `Pi model: ${facts.modelLevel}`,
        data.projectSlug === undefined
          ? "Project agents are unavailable until this folder is registered."
          : `${observed.size} observed task agents · ${data.tasks.length} project tasks`,
        "No separate HARIL agent-profile registry is exposed.",
      ];
    case "orchestration":
      // The workflow summary is drawn above (renderOrchestrationSummary); this is the project's secondary line.
      return [
        data.projectSlug === undefined
          ? "Project tasks, approvals, queue and events require registering this folder."
          : `Project ${facts.project} · ${data.tasks.length} tasks · ${data.queued.length} queued commands · approvals ${facts.pending === undefined ? "unavailable" : `${facts.pending} pending`} · ${data.events.length} recent events`,
      ];
    case "automation":
      return [
        data.projectSlug === undefined
          ? "No project is bound to this folder. Register it to inspect or run a project queue."
          : `Project ${facts.project} · queued commands: ${data.queued.length}`,
        `Runtime status: ${facts.runtime}. ${runtimeExplanation(facts.runtime, facts.runtimeAvailable, data)}`,
        "No scheduled-automation registry or scheduler API is available; no recurring jobs are represented here.",
        ...(data.projectSlug === undefined
          ? []
          : [
              "Run/start controls appear only after HARIL confirms the runtime is idle; stop is available only while running.",
            ]),
      ];
    case "tools":
      return [
        facts.tools.length
          ? `${facts.activeTools.length}/${facts.tools.length} configured Pi tools active`
          : "Pi reports no configured tools in this session.",
        `Methodologies: ${data.methodologies.length} HARIL methodologies · ${facts.commands.length} Pi commands reported`,
        ...(!data.methodologiesAvailable
          ? ["The global methodology registry could not be read; use Refresh to retry."]
          : data.methodologies.length === 0
            ? [
                "The local registry successfully returned no methodologies; the CLI has no import command.",
              ]
            : []),
        ...(data.delegation !== undefined
          ? delegationSummary(data.delegation)
          : data.delegationError === undefined
            ? []
            : [`Delegation settings unavailable: ${data.delegationError}`]),
        "Browse a methodology to read its complete bundled definition; browsing does not execute it.",
      ];
    case "everywhere":
      return [
        `Project: ${facts.project}`,
        `Workspace: ${facts.cwd}`,
        `Git: ${facts.branch === undefined ? "unavailable" : (facts.branch ?? "not a Git repository")}`,
        `Session: ${facts.modelLevel} · context ${facts.context} · cost ${facts.cost}`,
        `Resources: ${facts.providers.length} providers · ${facts.mcpServers.length} MCP servers · ${facts.extensionStatuses.length} extension statuses`,
        `Runtime ${facts.runtime} · approvals ${facts.pending === undefined ? "unavailable" : facts.pending} · memory ${facts.memory}`,
      ];
  }
}

function runtimeExplanation(
  runtime: string,
  runtimeAvailable: boolean,
  data: DashboardData,
): string {
  if (data.projectSlug === undefined)
    return "No project queue is actionable from an unbound folder.";
  if (!runtimeAvailable) {
    const reason = data.errors.find((error) => error.startsWith("Project status:"));
    return `The runtime lease state is not confirmed${reason === undefined ? "." : `: ${reason}`}. Refresh retries the read; run/start/stop stay disabled.`;
  }
  if (runtime === "unknown") {
    const reason = data.errors.find((error) => error.startsWith("Project status:"));
    return `The status read did not confirm a lease${reason === undefined ? "." : `: ${reason}`}. Refresh retries status; run/start/stop stay disabled.`;
  }
  if (runtime === "starting")
    return "A runtime launched by this console is still starting; refresh to confirm its lease.";
  if (runtime === "running")
    return "The runtime lease is active and shared across projects; stop may pause other work.";
  return "HARIL confirmed the runtime idle; queued work can be run or the shared runtime started.";
}

export function renderDashboardLayout(
  area: DashboardArea,
  facts: DashboardFacts,
  width: number,
  theme: ConsoleTheme,
  height = 24,
): DashboardLayout {
  if (width < 10) return { lines: [fit("HARIL", width)], controlHits: [], orchestrationHits: [] };
  const lines = [
    border(width, "┌", "─", "┐"),
    boxRow(
      `${LABELS[area]} · ${facts.project}${facts.loading ? " · refreshing" : ""}`,
      width,
      theme,
      YELLOW,
    ),
  ];
  const warnings = facts.data.errors.map((error) => `! ${error}`);
  const body = linesFor(area, facts);
  if (!facts.loading && facts.data.loadedAt === undefined && area !== "tools")
    body.unshift("Project data has not loaded. Use Refresh to retry the local HARIL CLI.");
  if (
    !facts.loading &&
    facts.data.projectSlug === undefined &&
    ["agents", "orchestration", "automation"].includes(area)
  )
    body.unshift("Use Register this folder below to bind a project before project-scoped actions.");
  if (body.length === 0)
    body.push(facts.loading ? "Loading project data…" : "No matching project data is available.");
  const rowWidth = Math.max(1, width - 4);
  const warningLines = warnings.flatMap((item) => wrap(plainText(item), rowWidth));
  const visibleWarnings = warningLines.slice(0, 2);
  for (const warning of visibleWarnings) lines.push(boxRow(warning, width, theme, "error"));
  if (warningLines.length > visibleWarnings.length)
    lines.push(
      boxRow(
        `+${warningLines.length - visibleWarnings.length} warning lines; open Details`,
        width,
        theme,
        "error",
      ),
    );
  const orchestrationHits: DashboardLayout["orchestrationHits"][number][] = [];
  if (area === "orchestration") {
    // The summary's lines are already colored and exactly rowWidth wide: framed as they are, one space each side.
    const summary = renderOrchestrationSummary(
      facts.orchestration,
      rowWidth,
      height < 30 ? 4 : 8,
      facts.asciiGlyphs ? ASCII_GLYPHS : UNICODE_GLYPHS,
    );
    const first = lines.length;
    const space = paddedCell(" ", 1);
    for (const line of summary.lines)
      lines.push(`${frameGlyph("│")}${space}${line}${space}${frameGlyph("│")}`);
    for (const hit of summary.hits)
      orchestrationHits.push({
        ...hit,
        row: hit.row + first,
        start: hit.start + 2,
        end: hit.end + 2,
      });
  }
  const wrapped = body.flatMap((item) => wrap(plainText(item), rowWidth));
  const bodyBudget = height < 30 ? 3 : 6;
  const room = Math.max(1, bodyBudget - visibleWarnings.length - (warningLines.length > 2 ? 1 : 0));
  for (const line of wrapped.slice(0, room)) lines.push(boxRow(line, width, theme));
  if (wrapped.length > room)
    lines.push(
      boxRow(`… ${wrapped.length - room} more lines; open Details`, width, theme, "warning"),
    );
  const controls = controlsFor(
    area,
    facts.data,
    facts.runtime,
    facts.runtimeAvailable,
    facts.orchestration.demo,
    facts.locale ?? DEFAULT_UI_LOCALE,
  );
  const controlHits: DashboardLayout["controlHits"][number][] = [];
  const rowIndex = lines.length;
  for (const [index, control] of controls.entries()) {
    const label = `[${control.hint}] ${control.label}`;
    const start = 2;
    const end = Math.min(width - 1, start + textWidth(label));
    controlHits.push({ row: rowIndex + index, start, end, action: control.action });
    lines.push(boxRow(label, width, theme, "success"));
  }
  lines.push(
    boxRow(
      `Click a control · /haril for keyboard menu · Alt+H to choose area`,
      width,
      theme,
      "dim",
    ),
  );
  lines.push(border(width, "└", "─", "┘"));
  return { lines, controlHits, orchestrationHits };
}
