import type { BodyLine } from "./factory-board.js";
import {
  type FactoryGlyphs,
  FactoryGrid,
  type FactorySeg,
  type FactoryToken,
  factoryCell,
} from "./factory-kit.js";
import { agoText } from "./factory-models.js";
import { connectionAgents } from "./factory-rows.js";
import type { FactoryState, FactoryTarget } from "./factory-state.js";
import type { FactoryAgent, FactoryEvent, FactoryModel } from "./factory-types.js";
import { plainText, truncate } from "./text.js";

// The Conexiones tab: who delegated to whom, from the read model's edges and events. A chain of boxes for the selected
// agent (dns-resolver-chain), the delegation tree with its path lit (binary-tree), the whole network with what is in flight
// (network-topology), the selected agent's events as a sequence (sequence-diagram), and a handoff when one happened
// (blue-green-deploy). Every view falls back to an indented tree when it does not fit, and the selected agent's wait is
// always below it.

type Seg = FactorySeg<FactoryTarget>;

const CHAIN_BOX = 18;
const CHAIN_GAP = 4;
const TREE_CELL = 9;
const NET_BOX = 8;
const NET_GAP = 6;
const TRACE_ROWS = 4;
const BUSY: ReadonlySet<string> = new Set(["running"]);
const LIVE: ReadonlySet<string> = new Set(["running", "queued", "waiting", "awaiting_human"]);

function workflowAgents(model: FactoryModel, workflowId: string): FactoryAgent[] {
  return model.agents.filter((agent) => agent.workflowId === workflowId);
}

function parentOf(agent: FactoryAgent, agents: readonly FactoryAgent[]): FactoryAgent | undefined {
  return agents.find((row) => row.code === agent.parent);
}

function childrenOf(code: string, agents: readonly FactoryAgent[]): FactoryAgent[] {
  return agents.filter((row) => row.parent === code);
}

// The agents from the root to this one.
function pathTo(agent: FactoryAgent, agents: readonly FactoryAgent[]): FactoryAgent[] {
  const path = [agent];
  let current = parentOf(agent, agents);
  while (current !== undefined && !path.includes(current)) {
    path.unshift(current);
    current = parentOf(current, agents);
  }
  return path;
}

function statusToken(agent: FactoryAgent): FactoryToken {
  if (agent.status === "running") return "green";
  if (agent.status === "failed" || agent.status === "closed") return "red";
  if (agent.status === "done") return "muted";
  return "yellow";
}

// What this view does not fit becomes this: each agent under its parent, the selected path lit.
function indentedTree(
  agents: readonly FactoryAgent[],
  selected: FactoryAgent,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const lit = new Set(pathTo(selected, agents).map((agent) => agent.code));
  const lines: BodyLine[] = [];
  const add = (agent: FactoryAgent, prefix: string, last: boolean, root: boolean): void => {
    const branch = root ? "" : `${prefix}${last ? g.lastBranch : g.branch}`;
    lines.push([
      { text: branch, token: lit.has(agent.code) ? "orange" : "dim" },
      factoryCell(
        agent.code,
        Math.max(0, width - branch.length),
        lit.has(agent.code) ? "orange" : statusToken(agent),
      ),
    ]);
    const children = childrenOf(agent.code, agents);
    children.forEach((child, index) => {
      add(
        child,
        root ? "" : `${prefix}${last ? "  " : `${g.v} `}`,
        index === children.length - 1,
        false,
      );
    });
  };
  for (const root of agents.filter((agent) => parentOf(agent, agents) === undefined)) {
    add(root, "", true, true);
  }
  const at = lines.findIndex((line) => line.some((seg) => seg.text.trimEnd() === selected.code));
  const start = Math.max(0, Math.min(at, lines.length - height));
  return lines.slice(start, start + Math.max(0, height));
}

function eventsOf(
  model: FactoryModel,
  codes: readonly string[],
  workflowId: string,
): FactoryEvent[] {
  return model.events.filter(
    (event) =>
      event.workflowId === workflowId && event.agent !== null && codes.includes(event.agent),
  );
}

function chainBody(
  model: FactoryModel,
  selected: FactoryAgent,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const agents = workflowAgents(model, selected.workflowId);
  const path = pathTo(selected, agents);
  const needed = path.length * CHAIN_BOX + (path.length - 1) * CHAIN_GAP;
  if (needed > width || height < 6) return indentedTree(agents, selected, width, height, g);
  const grid = new FactoryGrid(width, 4);
  path.forEach((agent, index) => {
    const x = index * (CHAIN_BOX + CHAIN_GAP);
    const busy = BUSY.has(agent.status);
    const border: FactoryToken = agent === selected ? "yellow" : busy ? "green" : "dim";
    grid.text(x, 0, `${g.topLeft}${g.h.repeat(CHAIN_BOX - 2)}${g.topRight}`, border);
    grid.text(x, 3, `${g.bottomLeft}${g.h.repeat(CHAIN_BOX - 2)}${g.bottomRight}`, border);
    for (const row of [1, 2]) {
      grid.text(x, row, g.v, border);
      grid.text(x + CHAIN_BOX - 1, row, g.v, border);
    }
    grid.text(
      x + 2,
      1,
      truncate(plainText(agent.code), CHAIN_BOX - 4),
      agent === selected ? "text" : "blue",
    );
    grid.text(x + 2, 2, truncate(plainText(agent.role), CHAIN_BOX - 4), "muted");
    if (index > 0) {
      const active = busy;
      for (let gap = 0; gap < CHAIN_GAP; gap++) {
        grid.text(
          x - CHAIN_GAP + gap,
          1,
          active ? g.activeLink : g.idleLink,
          active ? "blue" : "dim",
        );
      }
    }
  });
  const lines: BodyLine[] = [0, 1, 2, 3].map((row) => grid.segs<FactoryTarget>(row));
  const parent = path[path.length - 2];
  lines.push([
    factoryCell(
      `${g.action} ${parent === undefined ? "tú" : parent.code} → ${selected.code}: ${selected.task}`,
      width,
      BUSY.has(selected.status) ? "yellow" : "green",
    ),
  ]);
  const room = Math.min(TRACE_ROWS, height - lines.length - 1);
  if (room > 0) {
    lines.push([{ text: g.h.repeat(width), token: "line" }]);
    const codes = path.map((agent) => agent.code);
    for (const event of eventsOf(model, codes, selected.workflowId).slice(-room)) {
      lines.push([
        factoryCell(event.agent ?? "", 9, "muted"),
        factoryCell(event.type, 24, "blue"),
        factoryCell(event.text, Math.max(0, width - 45), "muted"),
        factoryCell(agoText(event.at, model.generatedAt), 12, "dim", true),
      ]);
    }
  }
  return lines;
}

interface Placed {
  readonly agent: FactoryAgent;
  readonly x: number;
  readonly depth: number;
}

// Each node above its children, leaves left to right.
function placed(agents: readonly FactoryAgent[]): Placed[] {
  const out: Placed[] = [];
  let leaf = 0;
  const walk = (agent: FactoryAgent, depth: number, seen: readonly string[]): number => {
    const children = childrenOf(agent.code, agents).filter((row) => !seen.includes(row.code));
    let x: number;
    if (children.length === 0) {
      x = leaf * TREE_CELL + Math.floor(TREE_CELL / 2);
      leaf += 1;
    } else {
      const xs = children.map((child) => walk(child, depth + 1, [...seen, agent.code]));
      x = Math.round(((xs[0] as number) + (xs[xs.length - 1] as number)) / 2);
    }
    out.push({ agent, x, depth });
    return x;
  };
  for (const root of agents.filter((agent) => parentOf(agent, agents) === undefined)) {
    walk(root, 0, []);
  }
  return out;
}

function treeBody(
  model: FactoryModel,
  selected: FactoryAgent,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const agents = workflowAgents(model, selected.workflowId);
  const nodes = placed(agents);
  const depth = Math.max(...nodes.map((node) => node.depth));
  const rows = depth * 3 + 1;
  const right = Math.max(...nodes.map((node) => node.x)) + TREE_CELL;
  if (right > width || rows > height) return indentedTree(agents, selected, width, height, g);
  const lit = new Set(pathTo(selected, agents).map((agent) => agent.code));
  const grid = new FactoryGrid(width, rows);
  for (const node of nodes) {
    const parent = nodes.find((row) => row.agent.code === node.agent.parent);
    if (parent !== undefined) {
      const on = lit.has(node.agent.code) && lit.has(parent.agent.code);
      const token: FactoryToken = on ? "orange" : "line";
      const midRow = parent.depth * 3 + 1;
      const from = Math.min(node.x, parent.x);
      const to = Math.max(node.x, parent.x);
      for (let x = from; x <= to; x++) grid.text(x, midRow, g.h, token);
      grid.text(parent.x, midRow, g.v, token);
      if (node.x !== parent.x)
        grid.text(node.x, midRow, node.x < parent.x ? g.topLeft : g.topRight, token);
      grid.text(node.x, midRow + 1, g.v, token);
    }
  }
  for (const node of nodes) {
    const on = lit.has(node.agent.code);
    const code = truncate(plainText(node.agent.code), TREE_CELL - 3);
    const label = on ? `[${code}]` : `(${code})`;
    grid.text(
      node.x - Math.floor(label.length / 2),
      node.depth * 3,
      label,
      on ? "orange" : statusToken(node.agent),
    );
  }
  return Array.from({ length: rows }, (_, row) => grid.segs<FactoryTarget>(row));
}

function inFlight(agents: readonly FactoryAgent[]): number {
  return agents.filter((agent) => agent.parent !== null && LIVE.has(agent.status)).length;
}

function networkBody(
  model: FactoryModel,
  selected: FactoryAgent,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const agents = workflowAgents(model, selected.workflowId);
  const links = model.edges.filter((edge) => edge.workflowId === selected.workflowId);
  const header: BodyLine = [
    factoryCell(
      `  ${agents.length} agentes  ${links.length} enlaces`,
      Math.max(0, width - 24),
      "muted",
    ),
    factoryCell(
      `mensajes en curso ${String(inFlight(agents)).padStart(2, "0")}`,
      24,
      "orange",
      true,
    ),
  ];
  const columns = new Map<number, FactoryAgent[]>();
  for (const agent of agents)
    columns.set(agent.depth, [...(columns.get(agent.depth) ?? []), agent]);
  const tallest = Math.max(...[...columns.values()].map((list) => list.length));
  const rows = tallest * 3;
  const deepest = Math.max(...columns.keys());
  const needed = (deepest + 1) * NET_BOX + deepest * NET_GAP;
  if (needed > width || rows + 1 > height) {
    return [header, ...indentedTree(agents, selected, width, Math.max(0, height - 1), g)];
  }
  const grid = new FactoryGrid(width, rows);
  const position = new Map<string, { x: number; y: number }>();
  for (const [depth, list] of columns) {
    list.forEach((agent, index) => {
      position.set(agent.code, { x: depth * (NET_BOX + NET_GAP), y: index * 3 });
    });
  }
  for (const edge of links) {
    const from = position.get(edge.parent);
    const to = position.get(edge.child);
    const child = agents.find((agent) => agent.code === edge.child);
    if (from === undefined || to === undefined || child === undefined) continue;
    const active = LIVE.has(child.status);
    const x0 = from.x + NET_BOX;
    const y0 = from.y + 1;
    const x1 = to.x - 1;
    const y1 = to.y + 1;
    const steps = Math.max(1, x1 - x0);
    for (let step = 0; step <= steps; step++) {
      const x = x0 + step;
      const y = Math.round(y0 + ((y1 - y0) * step) / steps);
      grid.text(x, y, active ? g.activeLink : g.h, active ? "blue" : "line");
    }
  }
  for (const agent of agents) {
    const at = position.get(agent.code);
    if (at === undefined) continue;
    const border: FactoryToken =
      agent === selected ? "yellow" : BUSY.has(agent.status) ? "blue" : "muted";
    grid.text(at.x, at.y, `${g.topLeft}${g.h.repeat(NET_BOX - 2)}${g.topRight}`, border);
    grid.text(at.x, at.y + 1, g.v, border);
    grid.text(at.x + NET_BOX - 1, at.y + 1, g.v, border);
    grid.text(at.x + 1, at.y + 1, truncate(plainText(agent.code), NET_BOX - 2), "text");
    grid.text(at.x, at.y + 2, `${g.bottomLeft}${g.h.repeat(NET_BOX - 2)}${g.bottomRight}`, border);
  }
  return [header, ...Array.from({ length: rows }, (_, row) => grid.segs<FactoryTarget>(row))];
}

const REPLY_EVENT = /complet|fail|report|settled|closed|verdict/;

function sequenceBody(
  model: FactoryModel,
  selected: FactoryAgent,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const agents = workflowAgents(model, selected.workflowId);
  const parent = parentOf(selected, agents);
  const children = childrenOf(selected.code, agents);
  const slots = Math.max(1, Math.min(4, Math.floor(width / 14)));
  const cast = [...(parent === undefined ? [] : [parent]), selected, ...children].slice(0, slots);
  const codes = cast.map((agent) => agent.code);
  const events = eventsOf(model, codes, selected.workflowId);
  if (events.length === 0) {
    return [
      [factoryCell(`  ${selected.code} no tiene eventos registrados todavía.`, width, "muted")],
    ];
  }
  const step = Math.floor(width / cast.length);
  const columnOf = (code: string): number => codes.indexOf(code) * step + Math.floor(step / 2);
  const rows = Math.max(0, height - 1);
  const room = Math.floor(rows / 2);
  const grid = new FactoryGrid(width, room * 2);
  for (const code of codes) {
    const active = code === selected.code;
    for (let row = 0; row < room * 2; row++) {
      grid.text(columnOf(code), row, active ? g.heavyV : g.lifeline, active ? "blue" : "line");
    }
  }
  events.slice(-room).forEach((event, index) => {
    const from = event.agent as string;
    const reply = REPLY_EVENT.test(event.type);
    // A child answers the selected agent, and it answers its parent; anything else stays on its own lifeline.
    const target =
      from === selected.code
        ? reply && parent !== undefined && codes.includes(parent.code)
          ? parent.code
          : from
        : selected.code;
    const y = index * 2;
    const x0 = columnOf(from);
    const x1 = columnOf(target);
    grid.text(
      Math.min(x0, x1) + 1,
      y,
      truncate(plainText(`${event.type} ${event.text}`), Math.max(1, width - Math.min(x0, x1) - 2)),
      reply ? "muted" : "text",
    );
    if (x0 === x1) {
      grid.set(x0, y + 1, g.dot, "orange");
      return;
    }
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    for (let x = left + 1; x < right; x++) {
      grid.text(x, y + 1, reply ? g.dash : g.h, reply ? "muted" : "text");
    }
    if (x1 > x0) grid.text(x1 - 1, y + 1, g.arrowRight, "text");
    else grid.text(x1 + 1, y + 1, g.arrowLeft, "text");
  });
  const head: Seg[] = codes.map((code) =>
    factoryCell(code, step, code === selected.code ? "yellow" : "blue"),
  );
  return [head, ...Array.from({ length: room * 2 }, (_, row) => grid.segs<FactoryTarget>(row))];
}

function handoffBody(
  model: FactoryModel,
  selected: FactoryAgent,
  width: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const own = model.handoffs.filter((row) => row.workflowId === selected.workflowId);
  const last = own[own.length - 1];
  if (last === undefined)
    return [[factoryCell("  No hubo ningún relevo en este flujo.", width, "muted")]];
  const side = Math.max(0, Math.floor((width - 6) / 2));
  // The two sides' top or bottom edge: the one left dim, the one that took over green.
  const edge = (left: string, right: string): BodyLine => {
    const line = `${left}${g.h.repeat(Math.max(0, side - 2))}${right}`;
    return [
      factoryCell(line, side, "dim"),
      factoryCell("", 6, "dim"),
      factoryCell(line, side, "green"),
    ];
  };
  const label = last.kind === "model" ? "Relevo de modelo" : "Relevo de agente";
  return [
    [
      factoryCell(
        `  ${label}${last.agent === null ? "" : ` de ${last.agent}`}, ${agoText(last.at, model.generatedAt)}`,
        width,
        "text",
      ),
    ],
    edge(g.topLeft, g.topRight),
    [
      factoryCell(`${g.v} ${last.from}`, side, "muted"),
      { text: ` ${g.h}${g.h}${g.arrowRight}   `, token: "green" },
      factoryCell(`${g.v} ${last.to}`, side, "green"),
    ],
    edge(g.bottomLeft, g.bottomRight),
    [],
    ...own
      .slice(-TRACE_ROWS)
      .reverse()
      .map(
        (row): BodyLine => [
          factoryCell(`  ${row.from} ${g.arrowRight} ${row.to}`, Math.max(0, width - 14), "muted"),
          factoryCell(agoText(row.at, model.generatedAt), 14, "dim", true),
        ],
      ),
  ];
}

// Whom the selected agent waits for, and why, from the read model; always in view.
function waitLines(model: FactoryModel, selected: FactoryAgent, width: number): BodyLine[] {
  const task = model.tasks.find((row) => row.id === selected.taskId);
  const who =
    selected.waitingFor.length > 0
      ? `${selected.code} espera a ${selected.waitingFor.join(", ")}`
      : selected.status === "running"
        ? `${selected.code} está trabajando`
        : `${selected.code} no espera a otro agente`;
  return [
    [
      factoryCell(
        `  ${who}: ${task?.explanation.what ?? selected.status}`,
        width,
        selected.waitingFor.length > 0 ? "yellow" : "muted",
      ),
    ],
    ...(task === undefined
      ? []
      : [[factoryCell<FactoryTarget>(`  ${task.explanation.why}`, width, "muted")]]),
  ];
}

export function conexionesBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const rows = connectionAgents(state);
  const selected = rows[state.selection.conexiones];
  if (selected === undefined) {
    return [[factoryCell("  Sin agentes todavía: nadie habla con nadie.", width, "muted")]];
  }
  const wait = height >= 5 ? waitLines(model, selected, width) : [];
  const room = Math.max(0, height - wait.length - (wait.length > 0 ? 1 : 0));
  const body = ((): BodyLine[] => {
    switch (state.conexionesView) {
      case "cadena":
        return chainBody(model, selected, width, room, g);
      case "arbol":
        return treeBody(model, selected, width, room, g);
      case "red":
        return networkBody(model, selected, width, room, g);
      case "secuencia":
        return sequenceBody(model, selected, width, room, g);
      case "relevo":
        return handoffBody(model, selected, width, g);
    }
  })();
  const padded: BodyLine[] = body.slice(0, room);
  while (wait.length > 0 && padded.length < room) padded.push([]);
  return wait.length > 0
    ? [...padded, [{ text: g.h.repeat(width), token: "line" }], ...wait]
    : padded;
}
