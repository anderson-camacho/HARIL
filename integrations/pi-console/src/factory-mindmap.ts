import type { BodyLine } from "./factory-board.js";
import { roleLabel } from "./factory-board.js";
import { type FactoryGlyphs, FactoryGrid, type FactoryToken, factoryCell } from "./factory-kit.js";
import type { FactoryState } from "./factory-state.js";
import type { FactoryModel, FactoryTask } from "./factory-types.js";
import { truncate } from "./text.js";

// The Tablero tab's map (mind-map): the workflow's goal in the middle, each part around it, and each part's tasks as
// leaves. It is drawn from the board's own tasks. Too small for a map, it is an indented tree.

const TOPIC_TOKENS: readonly FactoryToken[] = [
  "blue",
  "green",
  "orange",
  "purple",
  "cyan",
  "yellow",
];
const MIN_WIDTH = 70;
const MIN_HEIGHT = 16;
const LABEL_MAX = 18;

function slope(dx: number, dy: number): string {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy) * 2;
  if (ay < ax * 0.4) return "─";
  if (ax < ay * 0.4) return "│";
  return dx * dy > 0 ? "╲" : "╱";
}

function line(
  grid: FactoryGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  token: FactoryToken,
  g: FactoryGlyphs,
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0) * 2, 1);
  const ascii = !g.braille;
  const raw = slope(x1 - x0, y1 - y0);
  const char = ascii ? ({ "─": "-", "│": "|", "╲": "\\", "╱": "/" }[raw] ?? raw) : raw;
  for (let step = 0; step <= steps; step++) {
    const at = step / steps;
    grid.set(Math.round(x0 + (x1 - x0) * at), Math.round(y0 + (y1 - y0) * at), char, token);
  }
}

function box(
  grid: FactoryGrid,
  centerX: number,
  y: number,
  text: string,
  token: FactoryToken,
  double: boolean,
  g: FactoryGlyphs,
): void {
  const label = truncate(text, LABEL_MAX + (double ? 8 : 0));
  const width = [...label].length + 4;
  const left = Math.max(0, Math.min(grid.width - width, centerX - Math.floor(width / 2)));
  const ascii = !g.braille;
  const set =
    double && !ascii
      ? ["╔", "═", "╗", "║", "╚", "╝"]
      : [g.topLeft, g.h, g.topRight, g.v, g.bottomLeft, g.bottomRight];
  const [tl, h, tr, v, bl, br] = set as [string, string, string, string, string, string];
  grid.text(left, y - 1, `${tl}${h.repeat(width - 2)}${tr}`, token);
  grid.text(left, y, `${v}${" ".repeat(width - 2)}${v}`, token);
  grid.text(left + 2, y, label, double ? "yellow" : "text");
  grid.text(left, y + 1, `${bl}${h.repeat(width - 2)}${br}`, token);
}

interface Topic {
  readonly task: FactoryTask;
  readonly leaves: readonly FactoryTask[];
}

function topicsOf(
  model: FactoryModel,
  workflowId: string,
): { root: FactoryTask | undefined; topics: Topic[] } {
  const tasks = model.tasks.filter((task) => task.workflowId === workflowId);
  const root = tasks.find((task) => task.delegatedBy === null);
  const rootCode = root?.agent;
  const parts = tasks.filter((task) => task.delegatedBy === rootCode && rootCode !== undefined);
  return {
    root,
    topics: parts.map((task) => ({
      task,
      leaves: tasks.filter((row) => row.delegatedBy === task.agent),
    })),
  };
}

const COLUMN_DOT: Readonly<Record<string, FactoryToken>> = {
  por_hacer: "muted",
  en_curso: "blue",
  detenidas: "yellow",
  errores: "red",
  hechas: "green",
};

function treeLines(
  root: FactoryTask | undefined,
  topics: readonly Topic[],
  width: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const lines: BodyLine[] = [[factoryCell(` ${root?.title ?? "Flujo"}`, width, "yellow")]];
  topics.forEach((topic, index) => {
    const token = TOPIC_TOKENS[index % TOPIC_TOKENS.length] as FactoryToken;
    lines.push([factoryCell(` ${g.branch} ${topic.task.title}`, width, token)]);
    for (const leaf of topic.leaves) {
      lines.push([
        factoryCell(`    ${g.dot} ${roleLabel(leaf.role)}: ${leaf.title}`, width, "muted"),
      ]);
    }
  });
  return lines;
}

export function mindMapBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const workflow =
    model.workflows.find((row) => row.state === "running" || row.state === "awaiting_human") ??
    model.workflows[0];
  if (workflow === undefined) return [[factoryCell("  Sin flujos todavía.", width, "muted")]];
  const { root, topics } = topicsOf(model, workflow.id);
  if (width < MIN_WIDTH || height < MIN_HEIGHT || topics.length === 0) {
    return treeLines(root, topics, width, g).slice(0, Math.max(0, height));
  }
  const grid = new FactoryGrid(width, height);
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  // Topics go round the middle: first to the left and right of it, then above and below.
  const places = topics.slice(0, TOPIC_TOKENS.length).map((_, index, list) => {
    const left = index % 2 === 0;
    const rowsPerSide = Math.ceil(list.length / 2);
    const row = Math.floor(index / 2);
    const y = Math.round(((row + 1) * height) / (rowsPerSide + 1));
    const x = left ? Math.floor(width * 0.26) : Math.floor(width * 0.74);
    return { x, y: Math.max(1, Math.min(height - 2, y)), left };
  });
  topics.slice(0, TOPIC_TOKENS.length).forEach((topic, index) => {
    const place = places[index] as { x: number; y: number; left: boolean };
    const token = TOPIC_TOKENS[index] as FactoryToken;
    line(grid, centerX, centerY, place.x, place.y, token, g);
    topic.leaves.slice(0, 4).forEach((leaf, at, leaves) => {
      const y =
        place.y +
        at -
        Math.floor(leaves.length / 2) +
        (at >= Math.floor(leaves.length / 2) ? 2 : -1);
      const clamped = Math.max(0, Math.min(height - 1, y));
      const label = truncate(leaf.title, Math.max(4, Math.floor(width * 0.2) - 2));
      const x = place.left ? 1 : width - [...label].length - 3;
      line(
        grid,
        place.x,
        place.y,
        place.left ? x + [...label].length + 2 : x - 1,
        clamped,
        token,
        g,
      );
      grid.set(x, clamped, g.dot, COLUMN_DOT[leaf.column] ?? token);
      grid.text(x + 2, clamped, label, "muted");
    });
  });
  topics.slice(0, TOPIC_TOKENS.length).forEach((topic, index) => {
    const place = places[index] as { x: number; y: number };
    box(grid, place.x, place.y, topic.task.title, TOPIC_TOKENS[index] as FactoryToken, false, g);
  });
  box(grid, centerX, centerY, root?.title ?? workflow.goal, "yellow", true, g);
  if (g.braille) grid.set(Math.max(0, centerX - 16), centerY, "◆", "orange");
  return Array.from({ length: height }, (_, y) => grid.segs(y));
}
