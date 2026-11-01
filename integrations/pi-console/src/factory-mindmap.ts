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
const ROOT_LABEL_MAX = 26;
const MIN_LABEL = 6;

interface Place {
  readonly x: number;
  readonly y: number;
  readonly left: boolean;
  // The rows its leaves may use.
  readonly top: number;
  readonly bottom: number;
}

// Draws the box, and answers its left edge.
function box(
  grid: FactoryGrid,
  centerX: number,
  y: number,
  text: string,
  token: FactoryToken,
  double: boolean,
  max: number,
  g: FactoryGlyphs,
): number {
  const label = truncate(text, max);
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
  return left;
}

function horizontal(
  grid: FactoryGrid,
  from: number,
  to: number,
  y: number,
  token: FactoryToken,
  g: FactoryGlyphs,
): void {
  for (let x = Math.min(from, to); x <= Math.max(from, to); x++) grid.set(x, y, g.h, token);
}

function vertical(
  grid: FactoryGrid,
  x: number,
  from: number,
  to: number,
  token: FactoryToken,
  g: FactoryGlyphs,
): void {
  for (let y = Math.min(from, to); y <= Math.max(from, to); y++) grid.set(x, y, g.v, token);
}

// A junction joining three lines: ASCII has one character for them all.
const tee = (char: string, g: FactoryGlyphs): string => (g.braille ? char : "+");

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

// From the part's box along its row to the middle's column, and along that column to the goal, which is drawn over it.
function joinToRoot(
  grid: FactoryGrid,
  place: Place,
  places: readonly Place[],
  centerX: number,
  centerY: number,
  token: FactoryToken,
  g: FactoryGlyphs,
): void {
  horizontal(grid, place.x, centerX, place.y, token, g);
  if (place.y === centerY) return;
  vertical(grid, centerX, place.y, centerY, token, g);
  const above = place.y < centerY;
  const bothSides = places.filter((row) => row.y === place.y).length > 1;
  const corner = bothSides
    ? tee(above ? "┬" : "┴", g)
    : above
      ? place.left
        ? g.topRight
        : g.topLeft
      : place.left
        ? g.bottomRight
        : g.bottomLeft;
  grid.set(centerX, place.y, corner, token);
}

// The part's tasks, half above its box and half below, each on its own row joined to the box by a square line.
function leaves(
  grid: FactoryGrid,
  place: Place,
  tasks: readonly FactoryTask[],
  width: number,
  token: FactoryToken,
  g: FactoryGlyphs,
): void {
  const roomAbove = Math.max(0, place.y - 2 - place.top + 1);
  const roomBelow = Math.max(0, place.bottom - (place.y + 2) + 1);
  const room = roomAbove + roomBelow;
  const hidden = tasks.length > room ? tasks.length - Math.max(0, room - 1) : 0;
  const count = hidden > 0 ? Math.max(0, room - 1) : tasks.length;
  const rows = count + (hidden > 0 && room > 0 ? 1 : 0);
  const above = Math.min(roomAbove, Math.ceil(rows / 2));
  const below = Math.min(roomBelow, rows - above);
  const places = [
    ...Array.from({ length: above }, (_, at) => place.y - 2 - (above - 1 - at)),
    ...Array.from({ length: below }, (_, at) => place.y + 2 + at),
  ];
  if (above > 0) vertical(grid, place.x, place.y - 1 - above, place.y - 2, token, g);
  if (below > 0) vertical(grid, place.x, place.y + 2, place.y + 1 + below, token, g);
  const maxLabel = Math.max(4, Math.floor(width * 0.2) - 2);
  places.forEach((y, at) => {
    const leaf = tasks[at];
    const isMore = at >= count;
    const label = truncate(isMore ? `+ ${hidden} más` : (leaf?.title ?? ""), maxLabel);
    const x = place.left ? 1 : width - [...label].length - 3;
    const lineEnd = place.left ? x + 2 + [...label].length + 1 : x - 2;
    horizontal(grid, lineEnd, place.x + (place.left ? -1 : 1), y, token, g);
    if (leaf !== undefined && !isMore) grid.set(x, y, g.dot, COLUMN_DOT[leaf.column] ?? token);
    grid.text(x + 2, y, label, "muted");
    const farthest = y === place.y - 1 - above || y === place.y + 1 + below;
    const isAbove = y < place.y;
    const end = !farthest
      ? tee(place.left ? "┤" : "├", g)
      : isAbove
        ? place.left
          ? g.topRight
          : g.topLeft
        : place.left
          ? g.bottomRight
          : g.bottomLeft;
    grid.set(place.x, y, end, token);
  });
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
  const shown = topics.slice(0, TOPIC_TOKENS.length);
  const rootMax = Math.min(ROOT_LABEL_MAX, Math.max(MIN_LABEL, Math.floor(width * 0.2)));
  const rootEdge = centerX - Math.floor((rootMax + 4) / 2);
  // Topics go to the left and the right of the middle, each with its own band of rows for its leaves.
  const rowsPerSide = Math.ceil(shown.length / 2);
  const places = shown.map((_, index): Place => {
    const row = Math.floor(index / 2);
    const top = Math.floor((row * height) / rowsPerSide);
    const bottom = Math.floor(((row + 1) * height) / rowsPerSide) - 1;
    const y = Math.max(1, Math.min(height - 2, Math.floor((top + bottom + 1) / 2)));
    const left = index % 2 === 0;
    return { x: Math.floor(width * (left ? 0.26 : 0.74)), y, left, top, bottom };
  });
  const topicMax = Math.min(
    LABEL_MAX,
    Math.max(MIN_LABEL, (rootEdge - 2 - Math.floor(width * 0.26)) * 2 - 4),
  );
  shown.forEach((topic, index) => {
    const place = places[index] as Place;
    const token = TOPIC_TOKENS[index] as FactoryToken;
    joinToRoot(grid, place, places, centerX, centerY, token, g);
    leaves(grid, place, topic.leaves, width, token, g);
  });
  shown.forEach((topic, index) => {
    const place = places[index] as Place;
    box(
      grid,
      place.x,
      place.y,
      topic.task.title,
      TOPIC_TOKENS[index] as FactoryToken,
      false,
      topicMax,
      g,
    );
  });
  const edge = box(
    grid,
    centerX,
    centerY,
    root?.title ?? workflow.goal,
    "yellow",
    true,
    rootMax,
    g,
  );
  if (g.braille && edge > 0) grid.set(edge - 1, centerY, "◆", "orange");
  if (topics.length > shown.length) {
    const more = `+ ${topics.length - shown.length} partes más`;
    grid.text(centerX - Math.floor(more.length / 2), height - 1, more, "muted");
  }
  return Array.from({ length: height }, (_, y) => grid.segs(y));
}
