import type { BodyLine } from "./factory-board.js";
import { roleLabel } from "./factory-board.js";
import { type FactoryGlyphs, type FactoryToken, factoryCell } from "./factory-kit.js";
import type { FactoryState } from "./factory-state.js";
import type { FactoryAgent, FactoryMessage } from "./factory-types.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

// A direct chat with one agent (chat-thread): a header with its dot, state and task; its words in muted bubbles on the
// left, yours in blue on the right, events inline without a bubble, what it is doing now, and the composer pinned below.
// One attempt takes one prompt, so a message reaches the agent at the next turn boundary: under each of yours, how far it
// got. `Tab` makes it interrupt instead.

const STATE_TEXT: Readonly<Record<FactoryMessage["state"], string>> = {
  waiting: "en espera del fin de turno",
  delivered: "entregado",
  applied: "aplicado",
};
const STATE_TOKEN: Readonly<Record<FactoryMessage["state"], FactoryToken>> = {
  waiting: "yellow",
  delivered: "blue",
  applied: "green",
};
const STATUS_TOKEN: Readonly<Record<string, FactoryToken>> = {
  running: "green",
  waiting: "yellow",
  queued: "muted",
  failed: "red",
  awaiting_human: "yellow",
};
const STATUS_TEXT: Readonly<Record<string, string>> = {
  running: "trabajando",
  waiting: "esperando",
  queued: "en cola",
  done: "terminó",
  failed: "falló",
  cancelled: "cancelado",
  awaiting_human: "te espera",
  closed: "cerrado",
};
// The share of the width a bubble takes at most, as in the piece.
const BUBBLE_SHARE = 0.62;
const MIN_ROWS_FOR_BUBBLES = 8;

function chatAgent(state: FactoryState): FactoryAgent | undefined {
  const chat = state.chat;
  if (chat === null) return undefined;
  return state.model?.agents.find(
    (row) => row.workflowId === chat.workflowId && row.code === chat.code,
  );
}

type Item =
  | { readonly at: number; readonly kind: "agent"; readonly text: string }
  | { readonly at: number; readonly kind: "you"; readonly message: FactoryMessage }
  | { readonly at: number; readonly kind: "event"; readonly text: string };

function itemsOf(state: FactoryState, agent: FactoryAgent): Item[] {
  const { model } = state;
  if (model === null) return [];
  const mine = model.messages.filter(
    (row) => row.workflowId === agent.workflowId && row.agent === agent.code,
  );
  const events = model.events.filter(
    (row) =>
      row.workflowId === agent.workflowId &&
      row.agent === agent.code &&
      (row.type === "handoff" ||
        row.type === "vigilante.alert" ||
        row.type === "model.substituted" ||
        row.type === "capacity.waiting"),
  );
  return [
    ...agent.said.map((row): Item => ({ at: row.at, kind: "agent", text: row.text })),
    ...mine.map((message): Item => ({ at: message.at, kind: "you", message })),
    ...events.map((row): Item => ({ at: row.at, kind: "event", text: row.text })),
  ].sort((a, b) => a.at - b.at);
}

function bubble(text: string, side: "left" | "right", width: number, g: FactoryGlyphs): BodyLine[] {
  const room = Math.max(4, Math.floor(width * BUBBLE_SHARE) - 4);
  const lines = wrap(plainText(text), room);
  const inner = Math.max(...lines.map((line) => textWidth(line)), 1);
  const outer = inner + 4;
  const pad = side === "left" ? 1 : Math.max(0, width - outer - 1);
  const border: FactoryToken = side === "left" ? "dim" : "blue";
  const ink: FactoryToken = side === "left" ? "muted" : "blue";
  const lead = { text: " ".repeat(pad), token: "dim" as const };
  return [
    [lead, { text: `${g.topLeft}${g.h.repeat(outer - 2)}${g.topRight}`, token: border }],
    ...lines.map(
      (line): BodyLine => [
        lead,
        { text: `${g.v} `, token: border },
        factoryCell(line, inner, ink),
        { text: ` ${g.v}`, token: border },
      ],
    ),
    [lead, { text: `${g.bottomLeft}${g.h.repeat(outer - 2)}${g.bottomRight}`, token: border }],
  ];
}

function itemLines(item: Item, width: number, g: FactoryGlyphs, compact: boolean): BodyLine[] {
  if (item.kind === "event") {
    return [[factoryCell(`  ${g.fill} ${item.text}`, width, "dim")]];
  }
  if (item.kind === "agent") {
    return compact
      ? [[factoryCell(`  ${item.text}`, width, "muted")]]
      : bubble(item.text, "left", width, g);
  }
  const { message } = item;
  const urgent = message.urgent ? "urgente · " : "";
  const stateText = `${urgent}${STATE_TEXT[message.state]}`;
  const stateLine: BodyLine = [
    factoryCell(stateText, Math.max(0, width - 1), STATE_TOKEN[message.state], true),
  ];
  return compact
    ? [[factoryCell(`  tú: ${message.text}`, width, "blue")], stateLine]
    : [...bubble(message.text, "right", width, g), stateLine];
}

function composer(
  state: FactoryState,
  agent: FactoryAgent,
  width: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const draft = state.chatDraft;
  const composing = draft !== "";
  const border: FactoryToken = composing ? "blue" : "dim";
  const top = composing ? g.heavy : g.h;
  const side = composing ? g.heavyV : g.v;
  const send = "Enviar →";
  const inner = Math.max(0, width - 4);
  const room = Math.max(0, inner - textWidth(send) - 2);
  const placeholder = state.readOnly
    ? "Este modo es de solo lectura"
    : `Mensaje a ${roleLabel(agent.role)}...`;
  const shown = composing ? truncate(`${draft}_`, room) : truncate(placeholder, room);
  return [
    [
      {
        text: `${composing ? g.heavyTopLeft : g.topLeft}${top.repeat(Math.max(0, width - 2))}${composing ? g.heavyTopRight : g.topRight}`,
        token: border,
      },
    ],
    [
      { text: `${side} `, token: border },
      factoryCell(shown, room, composing ? "text" : "dim"),
      { text: "  ", token: "dim" },
      { text: send, token: composing ? "blue" : "dim" },
      { text: ` ${side}`, token: border },
    ],
    [
      {
        text: `${composing ? g.heavyBottomLeft : g.bottomLeft}${top.repeat(Math.max(0, width - 2))}${composing ? g.heavyBottomRight : g.bottomRight}`,
        token: border,
      },
    ],
  ];
}

export function chatBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const agent = chatAgent(state);
  if (agent === undefined) {
    return [[factoryCell("  Ese agente ya no está en la vista.", width, "muted")]];
  }
  const dot: FactoryToken = STATUS_TOKEN[agent.status] ?? "muted";
  const context =
    agent.context === null || agent.context.threshold <= 0
      ? ""
      : `  ctx ${Math.round((agent.context.used / agent.context.threshold) * 100)}%`;
  const header: BodyLine = [
    { text: ` ${g.dot} `, token: dot },
    { text: `${agent.code} `, token: "text" },
    {
      text: `· ${roleLabel(agent.role)} · ${STATUS_TEXT[agent.status] ?? agent.status}`,
      token: "muted",
    },
    { text: context, token: "purple" },
    { text: ` · ${agent.task}`, token: "dim" },
  ];
  const rule: BodyLine = [{ text: g.h.repeat(Math.max(0, width)), token: "line" }];
  const urgent: BodyLine = state.chatUrgent
    ? [
        {
          text: "  Interrumpirá el intento en curso (Tab para esperar al fin de turno)",
          token: "orange",
        },
      ]
    : [];
  const activity: BodyLine = [
    factoryCell(agent.activity === null ? "" : `  ${agent.activity}...`, width, "blue"),
  ];
  const fixed = 2 + 3 + 1 + (urgent.length > 0 ? 1 : 0);
  const room = Math.max(0, height - fixed);
  const compact = height < MIN_ROWS_FOR_BUBBLES;
  const lines: BodyLine[] = [];
  const items = itemsOf(state, agent);
  // Whole bubbles only, bottom up: older ones have scrolled away.
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index] as Item;
    const drawn = itemLines(item, width, g, compact);
    if (lines.length + drawn.length > room) break;
    lines.unshift(...drawn);
  }
  if (items.length === 0 && room > 0) {
    lines.push([factoryCell("  Aún no hay mensajes con este agente.", width, "dim")]);
  }
  const filler = Array.from({ length: Math.max(0, room - lines.length) }, (): BodyLine => []);
  return [
    header,
    rule,
    ...filler,
    ...lines,
    activity,
    ...(urgent.length > 0 ? [urgent] : []),
    ...composer(state, agent, width, g),
  ];
}
