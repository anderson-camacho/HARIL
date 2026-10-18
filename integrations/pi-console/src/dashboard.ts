import type { ConsoleTheme, ThemeColor } from "./pi-types.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

export const DASHBOARD_AREAS = [
  "agents",
  "orchestration",
  "automation",
  "tools",
  "workflows",
  "everywhere",
] as const;

export type DashboardArea = (typeof DASHBOARD_AREAS)[number];

export interface DashboardFacts {
  readonly project: string;
  readonly cwd: string;
  readonly branch: string | null | undefined;
  readonly model: string;
  readonly thinking: string;
  readonly runtime: string;
  readonly pending: number | undefined;
  readonly context: string;
  readonly cost: string;
  readonly activeTools: readonly string[];
  readonly tools: readonly { readonly name: string; readonly active: boolean }[];
  readonly commands: readonly string[];
  readonly mcpServers: readonly string[];
  readonly extensionStatuses: readonly string[];
}

const AREAS: Readonly<Record<DashboardArea, string>> = {
  agents: "AGENTS",
  orchestration: "ORCHESTRATION",
  automation: "AUTOMATION",
  tools: "TOOLS",
  workflows: "WORKFLOWS",
  everywhere: "EVERYWHERE",
};

const SHORTCUTS = ["1", "2", "3", "4", "5", "6"];
const YELLOW: ThemeColor = "warning";

function color(theme: ConsoleTheme, text: string, tone: ThemeColor = "text"): string {
  return theme.fg(tone, plainText(text));
}

function fitted(text: string, width: number): string {
  return truncate(plainText(text), Math.max(0, width));
}

function borderLine(width: number): string {
  return width < 2 ? "" : `┌${"─".repeat(width - 2)}┐`;
}

function row(text: string, width: number, theme: ConsoleTheme, tone: ThemeColor = "text"): string {
  if (width < 2) return "";
  const inside = width - 2;
  const content = fitted(` ${text}`, inside);
  return `${theme.fg("dim", "│")}${color(theme, content, tone)}${" ".repeat(Math.max(0, inside - textWidth(content)))}${theme.fg("dim", "│")}`;
}

function tabs(width: number, selected: DashboardArea | undefined, theme: ConsoleTheme): string {
  const chunks = DASHBOARD_AREAS.map((area, index) => {
    const label = `${SHORTCUTS[index]} ${AREAS[area]}`;
    const text = selected === area ? `[ ${label} ]` : ` ${label} `;
    return { area, text };
  });
  const visible: typeof chunks = [];
  let used = 0;
  for (const chunk of chunks) {
    const size = textWidth(chunk.text) + (visible.length === 0 ? 0 : 1);
    if (used + size > width) break;
    visible.push(chunk);
    used += size;
  }
  let remaining = DASHBOARD_AREAS.length - visible.length;
  while (remaining > 0 && visible.length > 0 && used + 1 + textWidth(`+${remaining}`) > width) {
    const removed = visible.pop();
    if (removed !== undefined) used -= textWidth(removed.text) + (visible.length > 0 ? 1 : 0);
    remaining = DASHBOARD_AREAS.length - visible.length;
  }
  const rendered = visible.map(({ area, text }) => theme.fg(area === selected ? YELLOW : "dim", text));
  if (remaining > 0 && width > 4) rendered.push(theme.fg("dim", `+${remaining}`));
  return rendered.join("");
}

export function renderHeader(
  version: string | undefined,
  width: number,
  facts: DashboardFacts,
  selected: DashboardArea | undefined,
  theme: ConsoleTheme,
): string[] {
  if (width <= 0) return [];
  const title = `${version === undefined ? "◆ HARIL" : `◆ HARIL ${version}`} · MANY MINDS. ONE FLOW.`;
  const summary = `${facts.project}  │  ${facts.model} · ${facts.thinking}  │  runtime ${facts.runtime}`;
  const stats = `TOOLS ${facts.activeTools.length}/${facts.tools.length}  ·  MCP ${facts.mcpServers.length}  ·  ${facts.pending === undefined ? "approvals unavailable" : `${facts.pending} pending`}`;
  const compact = width < 76;
  const output = ["", color(theme, fitted(title, width), YELLOW), color(theme, fitted(summary, width), "dim")];
  if (!compact) output.push(color(theme, fitted(stats, width), "success"));
  output.push(color(theme, tabs(width, selected, theme), "dim"));
  return output;
}

function values(area: DashboardArea, facts: DashboardFacts): string[] {
  switch (area) {
    case "agents":
      return [
        `Model: ${facts.model}`,
        `Thinking level: ${facts.thinking}`,
        `Active Pi tools: ${facts.activeTools.length ? facts.activeTools.join(", ") : "none"}`,
        "This console has no separate live HARIL agent roster; tools are not agents.",
      ];
    case "orchestration":
      return [
        `Project: ${facts.project}`,
        `Runtime: ${facts.runtime}`,
        `Pending approvals: ${facts.pending === undefined ? "unavailable" : facts.pending}`,
        "Actions: /plans · /tasks · /events · /start",
      ];
    case "automation":
      return [
        `Runtime: ${facts.runtime}`,
        `Pending approvals: ${facts.pending === undefined ? "unavailable" : facts.pending}`,
        "No scheduled automation inventory is exposed by the current HARIL console API.",
        "Use /start to start or connect to the HARIL runtime.",
      ];
    case "tools":
      return facts.tools.length
        ? facts.tools.map((tool) => `${tool.active ? "● active" : "○ available"}  ${tool.name}`)
        : ["Pi reports no configured tools in this session."];
    case "workflows":
      return facts.commands.length
        ? facts.commands.map((command) => `/${command}`)
        : ["No slash commands are currently reported by Pi."];
    case "everywhere":
      return [
        `Project: ${facts.project}`,
        `Path: ${facts.cwd}`,
        `Git: ${facts.branch === undefined ? "status unavailable" : facts.branch ?? "not a Git repository"}`,
        `Model: ${facts.model} · thinking ${facts.thinking}`,
        `Session context: ${facts.context} · cost ${facts.cost}`,
        `MCP servers: ${facts.mcpServers.length ? facts.mcpServers.join(", ") : "none reported"}`,
        `Extensions: ${facts.extensionStatuses.length ? facts.extensionStatuses.join(" · ") : "no status reported"}`,
      ];
  }
}

export function renderDashboard(
  area: DashboardArea,
  facts: DashboardFacts,
  width: number,
  theme: ConsoleTheme,
): string[] {
  if (width <= 0) return [];
  const heading = `${AREAS[area]}  ·  ${area === "tools" ? `${facts.tools.length} configured` : "live session view"}`;
  const body = values(area, facts).flatMap((line) => wrap(plainText(line), Math.max(1, width - 4)));
  const lines = [color(theme, borderLine(width), "dim"), row(heading, width, theme, YELLOW)];
  for (const line of body.slice(0, 12)) lines.push(row(line, width, theme));
  lines.push(row("Keys: Ctrl+Shift+1..6 · Commands: /agents /orchestration /automation /tools /workflows /everywhere", width, theme, "dim"));
  lines.push(color(theme, `└${"─".repeat(Math.max(0, width - 2))}┘`, "dim"));
  return lines;
}
