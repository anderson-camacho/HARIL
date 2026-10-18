import type { DashboardTone } from "./dashboard-theme.js";
import { demoTranscript } from "./orchestration-demo.js";
import {
  ago,
  type Background,
  Canvas,
  clip,
  clockTime,
  compose,
  contextBar,
  firstThatFits,
  framed,
  frameText,
  inTime,
  nodeStatus,
  type OrchestrationGlyphs,
  optionalTokens,
  quotaValue,
  type RenderedBlock,
  rule,
  type Seg,
  shortTime,
  spread,
  tokens,
  widthOf,
  workflowStatus,
} from "./orchestration-draw.js";
import {
  filteredUsage,
  LOG_FILTERS,
  nodesForView,
  ORCHESTRATION_VIEWS,
  type OrchestrationState,
  type OrchestrationTarget,
  selectedNode,
  VIEW_LABELS,
} from "./orchestration-state.js";
import type { QuotaRow, UsageRow, WorkflowNode, WorkflowSnapshot } from "./orchestration-types.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

// The ORCHESTRATION view drawn as terminal lines (spec 7.6 and 7.8): the module panel summary, the full view (wide
// from 120x40, compact below) and the live view of one agent. Pure: a state, a size and a glyph set in, lines and
// hit-boxes out. Every line is cut to the width, every state is a glyph and a text (never a color alone), and a value
// the snapshot does not have is drawn as "n/a". The primitives (glyphs, composition, values) are in
// orchestration-draw.ts.

export const DEMO_LABEL = "DEMO · sample data, not real";
export const EMPTY_MESSAGE =
  "No workflows yet. Run /orchestration demo to see the view with sample data.";
const LIVE_UNAVAILABLE = "The live view arrives with real workflows.";
const LIVE_NOTHING_IN_DEMO = "Nothing live to show: this view lists no agent right now.";
const LABEL_WIDTH = 11;

const MODEL_SOURCE: Readonly<Record<WorkflowNode["modelSource"], string>> = {
  pinned: "pinned",
  parent: "from parent",
  table: "from difficulty table",
};

// The last watchdog verdict on a node, from the events ("e1 active, continues", "e5 closed: no progress").
function watchdogVerdict(snapshot: WorkflowSnapshot, id: string): string | undefined {
  for (let index = snapshot.events.length - 1; index >= 0; index--) {
    const event = snapshot.events[index];
    if (event?.type.startsWith("watchdog.") && event.text.startsWith(`${id} `))
      return event.text.slice(id.length + 1);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces: metrics, view tabs, stop button, events, action buttons.

function metricCandidates(snapshot: WorkflowSnapshot, g: OrchestrationGlyphs): Seg[][] {
  const { totals, capacity, workflow } = snapshot;
  const budget = totals.tokensBudget === null ? "n/a" : tokens(totals.tokensBudget);
  const sep: Seg = { text: ` ${g.frame.v} `, tone: "dim" };
  const long: Seg[] = [
    { text: `Tokens ${tokens(totals.tokensUsed)} of ${budget}`, tone: "teal" },
    sep,
    { text: `Time ${clockTime(workflow.elapsedMs)}`, tone: "teal" },
    sep,
    { text: `Executors ${capacity.executors.live} of ${capacity.executors.max}`, tone: "teal" },
    sep,
    { text: `Auditors ${capacity.auditors.live} of ${capacity.auditors.max}`, tone: "teal" },
    sep,
    { text: `Agents ${totals.agentsCreated} of ${totals.agentsCap}`, tone: "teal" },
    sep,
    { text: `Queued ${totals.queued}`, tone: "teal" },
  ];
  const extra: Seg[] = [
    sep,
    { text: `Retries ${totals.retries} · Escalations ${totals.escalations}`, tone: "muted" },
  ];
  const short: Seg[] = [
    {
      text: `${tokens(totals.tokensUsed)} tok · ${clockTime(workflow.elapsedMs)} · exec ${capacity.executors.live}/${capacity.executors.max} · aud ${capacity.auditors.live}/${capacity.auditors.max} · agents ${totals.agentsCreated}/${totals.agentsCap} · queued ${totals.queued}`,
      tone: "teal",
    },
  ];
  return [[...long, ...extra], long, short];
}

function tabSegs(state: OrchestrationState, gap: string): Seg[] {
  return ORCHESTRATION_VIEWS.flatMap((view, index): Seg[] => {
    const selected = state.view === view;
    const tab: Seg = {
      text: selected ? `[${VIEW_LABELS[view]}]` : VIEW_LABELS[view],
      tone: selected ? "yellow" : "cyan",
      bg: selected ? "selected" : "panel",
      target: { kind: "view", view },
    };
    return index === 0 ? [tab] : [{ text: gap }, tab];
  });
}

function stopSeg(g: OrchestrationGlyphs): Seg {
  return { text: `[${g.stop} Stop all]`, tone: "error", target: { kind: "stop" } };
}

function eventsSegs(snapshot: WorkflowSnapshot): Seg[] {
  const recent = snapshot.events.slice(-3).reverse();
  const text = recent.length
    ? recent.map((event) => `${event.type} ${event.text}`).join(" · ")
    : "none";
  return [
    { text: "Events: ", tone: "teal" },
    { text, tone: "text" },
  ];
}

function button(text: string, target: OrchestrationTarget, tone: DashboardTone = "yellow"): Seg {
  return { text, tone, target };
}

function actionCandidates(state: OrchestrationState, g: OrchestrationGlyphs): Seg[][] {
  const next =
    LOG_FILTERS[(LOG_FILTERS.indexOf(state.logFilter) + 1) % LOG_FILTERS.length] ?? "all";
  const space: Seg = { text: " " };
  const hint: Seg = { text: `${g.upDown} move · Tab view · `, tone: "dim" };
  const build = (long: boolean): Seg[] => {
    const parts: Seg[] = [
      button("[Enter Detail]", { kind: "detail" }),
      button(long ? "[L Live view]" : "[L Live]", { kind: "live" }),
      button(long ? `[F Filter: ${state.logFilter}]` : `[F ${state.logFilter}]`, {
        kind: "filter",
        filter: next,
      }),
      button(long ? `[D Demo: ${state.demo ? "on" : "off"}]` : "[D Demo]", { kind: "demo" }),
      ...(state.demo
        ? [
            button(long ? "[W Simulate watchdog]" : "[W Watchdog]", { kind: "watchdog" }),
            button("[R Reset]", { kind: "reset" }),
          ]
        : []),
      button("[Esc Close]", { kind: "close" }, "cyan"),
    ];
    return parts.flatMap((part, index) => (index === 0 ? [part] : [space, part]));
  };
  return [[hint, ...build(true)], build(true), [hint, ...build(false)], build(false)];
}

// ---------------------------------------------------------------------------------------------------------------
// List items and their window.

interface Item {
  readonly lines: Seg[][];
  readonly selected: boolean;
}

function pad(text: string, width: number): string {
  const fitted = truncate(plainText(text), width);
  return `${fitted}${" ".repeat(Math.max(0, width - textWidth(fitted)))}`;
}

function nodeItem(
  node: WorkflowNode,
  state: OrchestrationState,
  width: number,
  g: OrchestrationGlyphs,
  options: {
    readonly indent: number;
    readonly selected: boolean;
    readonly twoLines: boolean;
    readonly status?: string;
  },
): Item {
  const target: OrchestrationTarget = { kind: "node", id: node.id };
  const status = nodeStatus(node, state.clock, g);
  const statusText = options.status ?? status.text;
  const bg: Background = options.selected ? "selected" : "base";
  const indent = "  ".repeat(options.indent);
  const headWidth = Math.max(18, Math.min(32, Math.floor(width * 0.36)));
  const statusWidth = Math.min(textWidth(statusText), Math.max(10, Math.floor(width * 0.3)));
  const pointer = options.selected ? `${g.pointer} ` : "  ";
  const before = `${pointer}${indent}`;
  const glyph = `${status.glyph} `;
  const name = pad(`${node.id} ${node.label}`, Math.max(1, headWidth - textWidth(before + glyph)));
  const goalWidth = Math.max(0, width - headWidth - statusWidth - 2);
  const line: Seg[] = [
    { text: before, tone: "yellow", bg, target },
    { text: glyph, tone: status.tone, bg, target },
    { text: name, tone: options.selected ? "yellow" : "text", bg, target },
    { text: " ", bg, target },
    { text: pad(node.goal, goalWidth), tone: "text", bg, target },
    { text: " ", bg, target },
    { text: pad(statusText, statusWidth), tone: status.tone, bg, target },
  ];
  if (!options.twoLines) return { lines: [line], selected: options.selected };
  const progress = node.lastProgress?.text ?? node.waitingReason ?? "no progress yet";
  const second: Seg[] = [
    {
      text: `${" ".repeat(textWidth(before + glyph))}${node.model} · ${tokens(node.tokens)} · ${shortTime(node.elapsedMs)} · ${progress}`,
      tone: "muted",
      bg,
      target,
    },
  ];
  return { lines: [line, second], selected: options.selected };
}

function headerItem(text: string, tone: DashboardTone = "yellow"): Item {
  return { lines: [[{ text, tone }]], selected: false };
}

function quotaItem(
  row: QuotaRow,
  index: number,
  selected: boolean,
  width: number,
  g: OrchestrationGlyphs,
): Item {
  const target: OrchestrationTarget = { kind: "row", index };
  const bg: Background = selected ? "selected" : "base";
  const name = pad(
    `${row.provider} · ${row.credential}`,
    Math.min(22, Math.max(12, Math.floor(width * 0.25))),
  );
  return {
    lines: [
      [
        { text: selected ? `${g.pointer} ` : "  ", tone: "yellow", bg, target },
        { text: `${name} `, tone: selected ? "yellow" : "text", bg, target },
        { text: "5h ", tone: "teal", bg, target },
        ...quotaValue(row.window5hPct, g).map((seg) => ({ ...seg, bg, target })),
        { text: "  weekly ", tone: "teal", bg, target },
        ...quotaValue(row.weeklyPct, g).map((seg) => ({ ...seg, bg, target })),
        { text: `  ${row.note}`, tone: "muted", bg, target },
      ],
    ],
    selected,
  };
}

function usageItem(row: UsageRow, index: number, selected: boolean, g: OrchestrationGlyphs): Item {
  const target: OrchestrationTarget = { kind: "row", index };
  const bg: Background = selected ? "selected" : "base";
  const tokensText = `${optionalTokens(row.tokensIn)}/${optionalTokens(row.tokensOut)} tok`;
  const text = `${row.kind.padEnd(9)} ${row.role.padEnd(12)} ${row.model.padEnd(13)} ${tokensText.padEnd(13)} ${shortTime(row.durationMs).padEnd(5)} ${row.outcome ?? "n/a"}`;
  return {
    lines: [
      [
        { text: selected ? `${g.pointer} ` : "  ", tone: "yellow", bg, target },
        { text, tone: selected ? "yellow" : "text", bg, target },
      ],
    ],
    selected,
  };
}

function filterItem(state: OrchestrationState): Item {
  const segs: Seg[] = [{ text: "Filter: ", tone: "teal" }];
  for (const [index, filter] of LOG_FILTERS.entries()) {
    if (index > 0) segs.push({ text: "  " });
    const active = state.logFilter === filter;
    segs.push({
      text: active ? `[${filter}]` : filter,
      tone: active ? "yellow" : "cyan",
      bg: active ? "selected" : "panel",
      target: { kind: "filter", filter },
    });
  }
  segs.push({ text: "  (F cycles)", tone: "dim" });
  return { lines: [segs], selected: false };
}

function listItems(
  state: OrchestrationState,
  width: number,
  g: OrchestrationGlyphs,
  wide: boolean,
): Item[] {
  const snapshot = state.snapshot;
  if (snapshot === undefined) return [];
  const current = selectedNode(state)?.id;
  switch (state.view) {
    case "tree":
      return nodesForView(snapshot, "tree").map((node) =>
        nodeItem(node, state, width, g, {
          indent: node.depth,
          selected: node.id === current,
          twoLines: wide,
        }),
      );
    case "layers": {
      const names = [
        "",
        "Layer 1 · orchestrator",
        "Layer 2 · delegators",
        "Layer 3 · executors and auditors",
      ];
      const nodes = nodesForView(snapshot, "layers");
      return [1, 2, 3].flatMap((layer) => {
        const members = nodes.filter((node) => node.layer === layer);
        return [
          headerItem(`${names[layer]} (${members.length})`),
          ...members.map((node) =>
            nodeItem(node, state, width, g, {
              indent: 1,
              selected: node.id === current,
              twoLines: false,
            }),
          ),
        ];
      });
    }
    case "queue": {
      const queued = nodesForView(snapshot, "queue");
      const running = snapshot.nodes.filter((node) => node.state === "running").length;
      return [
        headerItem(
          `${queued.length} queued · ${running} running · executors ${snapshot.capacity.executors.live} of ${snapshot.capacity.executors.max} · auditors ${snapshot.capacity.auditors.live} of ${snapshot.capacity.auditors.max}`,
          "teal",
        ),
        ...(queued.length === 0
          ? [headerItem("Nothing is queued.", "muted")]
          : queued.map((node) =>
              nodeItem(node, state, width, g, {
                indent: 0,
                selected: node.id === current,
                twoLines: false,
                status: node.waitingReason ?? "queued",
              }),
            )),
      ];
    }
    case "quota":
      return [
        headerItem("Accounts · the rules avoid one above 80% of its 5h or weekly window", "teal"),
        ...(snapshot.quota.length === 0
          ? [headerItem("No quota data.", "muted")]
          : snapshot.quota.map((row, index) =>
              quotaItem(row, index, index === state.quotaCursor, width, g),
            )),
      ];
    case "log": {
      const rows = filteredUsage(snapshot, state.logFilter);
      return [
        filterItem(state),
        ...(rows.length === 0
          ? [headerItem("No usage rows for this filter.", "muted")]
          : rows.map((row, index) => usageItem(row, index, index === state.logCursor, g))),
      ];
    }
  }
}

// The lines of the items that fit `rows`, keeping the selected item in view; a last line says what is hidden.
function windowed(items: readonly Item[], rows: number): Seg[][] {
  if (rows <= 0) return [];
  const all = items.flatMap((item) => item.lines);
  if (all.length <= rows) return all;
  const selected = Math.max(
    0,
    items.findIndex((item) => item.selected),
  );
  // One row: the selected item's first line, without room to say what is hidden.
  if (rows === 1) return (items[selected]?.lines ?? []).slice(0, 1);
  const budget = rows - 1;
  let start = 0;
  let used = items.slice(0, selected + 1).reduce((sum, item) => sum + item.lines.length, 0);
  while (used > budget && start < selected) {
    used -= items[start]?.lines.length ?? 0;
    start++;
  }
  const out: Seg[][] = [];
  let end = start;
  while (end < items.length && out.length + (items[end]?.lines.length ?? 0) <= budget) {
    out.push(...(items[end]?.lines ?? []));
    end++;
  }
  const above = start;
  const below = items.length - end;
  const parts = [above > 0 ? `${above} above` : "", below > 0 ? `${below} more below` : ""].filter(
    Boolean,
  );
  out.push([{ text: `… ${parts.join(" · ")}`, tone: "dim" }]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The detail of the selection.

function field(label: string, value: readonly Seg[] | string): Seg[] {
  const head: Seg = { text: `${label.padEnd(LABEL_WIDTH)} `, tone: "teal" };
  return typeof value === "string" ? [head, { text: value }] : [head, ...value];
}

function wrappedField(label: string, value: string, width: number, maxLines: number): Seg[][] {
  const room = Math.max(1, width - LABEL_WIDTH - 1);
  const parts = wrap(plainText(value), room);
  const shown = parts.slice(0, maxLines);
  if (parts.length > maxLines && shown.length > 0) {
    const lastIndex = shown.length - 1;
    shown[lastIndex] = truncate(`${shown[lastIndex]} ${parts.slice(maxLines).join(" ")}`, room);
  }
  return shown.map((part, index) =>
    index === 0 ? field(label, part) : [{ text: " ".repeat(LABEL_WIDTH + 1) }, { text: part }],
  );
}

function nodeDetail(
  snapshot: WorkflowSnapshot,
  node: WorkflowNode,
  now: number,
  width: number,
  g: OrchestrationGlyphs,
): Seg[][] {
  const status = nodeStatus(node, now, g);
  const verdict = watchdogVerdict(snapshot, node.id);
  const check =
    node.nextCheckAt === null
      ? verdict === undefined
        ? "n/a"
        : `none · last: ${verdict}`
      : `${inTime(node.nextCheckAt, now)} (watchdog)${verdict === undefined ? "" : ` · last: ${verdict}`}`;
  const lines: Seg[][] = [
    [
      { text: `${node.label} · ${node.id} · `, tone: "yellow" },
      { text: `${status.glyph} ${status.text}`, tone: status.tone },
      ...(node.turn === null
        ? []
        : [{ text: ` · turn ${node.turn.index} of ${node.turn.of}`, tone: "muted" as const }]),
    ],
    ...wrappedField("Goal", node.goal, width, 2),
    field(
      "Model",
      `${node.model} · ${node.thinkingLevel ?? "level n/a"} (${MODEL_SOURCE[node.modelSource]})`,
    ),
    field("Writes", node.files.write.length ? node.files.write.join(", ") : "none"),
    field("Reads", node.files.read.length ? node.files.read.join(", ") : "none"),
    field(
      "Difficulty",
      node.difficulty === null ? "n/a" : `${node.difficulty.estimated} · ${node.difficulty.reason}`,
    ),
    field(
      "Context",
      node.context === null
        ? "n/a"
        : [
            { text: `${tokens(node.context.used)} of ${tokens(node.context.threshold)}  ` },
            { text: contextBar(node.context.used, node.context.threshold, g), tone: "teal" },
          ],
    ),
    field("5h", quotaValue(node.quota?.window5hPct ?? null, g)),
    field("Weekly", quotaValue(node.quota?.weeklyPct ?? null, g)),
    field(
      "Progress",
      node.lastProgress === null
        ? "n/a"
        : `${ago(node.lastProgress.at, now)} · ${node.lastProgress.text}`,
    ),
    field("Next check", check),
    field("Audit", node.audit === null ? "n/a" : `${node.audit.verdict} · ${node.audit.summary}`),
    ...wrappedField("Memo", node.memo ?? "n/a", width, 2),
  ];
  if (node.waitingReason !== null) lines.push(field("Reason", node.waitingReason));
  return lines;
}

function quotaDetail(row: QuotaRow, now: number, g: OrchestrationGlyphs): Seg[][] {
  return [
    [{ text: `${row.provider} · ${row.credential}`, tone: "yellow" }],
    field("5h", quotaValue(row.window5hPct, g)),
    field("Weekly", quotaValue(row.weeklyPct, g)),
    field("Resets", row.resetAt === null ? "n/a" : inTime(row.resetAt, now)),
    field("Note", row.note),
    field("Rule", "avoid an account above 80% (5h or weekly)"),
  ];
}

function usageDetail(row: UsageRow, now: number): Seg[][] {
  return [
    [{ text: `${row.kind} · ${row.role} · ${row.model}`, tone: "yellow" }],
    field("When", ago(row.at, now)),
    field("Tokens in", optionalTokens(row.tokensIn)),
    field("Tokens out", optionalTokens(row.tokensOut)),
    field("Duration", shortTime(row.durationMs)),
    field("Difficulty", row.difficulty ?? "n/a"),
    field("Outcome", row.outcome ?? "n/a"),
  ];
}

function detailLines(state: OrchestrationState, width: number, g: OrchestrationGlyphs): Seg[][] {
  const snapshot = state.snapshot;
  if (snapshot === undefined) return [];
  if (state.view === "quota") {
    const row = snapshot.quota[state.quotaCursor];
    return row === undefined
      ? [[{ text: "No quota row selected.", tone: "muted" }]]
      : quotaDetail(row, state.clock, g);
  }
  if (state.view === "log") {
    const row = filteredUsage(snapshot, state.logFilter)[state.logCursor];
    return row === undefined
      ? [[{ text: "No usage row selected.", tone: "muted" }]]
      : usageDetail(row, state.clock);
  }
  const node = selectedNode(state);
  return node === undefined
    ? [[{ text: "Nothing selected.", tone: "muted" }]]
    : nodeDetail(snapshot, node, state.clock, width, g);
}

// ---------------------------------------------------------------------------------------------------------------
// The full view.

function titleSegs(
  snapshot: WorkflowSnapshot,
  g: OrchestrationGlyphs,
): { left: Seg[]; right: Seg[] } {
  const status = workflowStatus(snapshot.workflow.state, g);
  return {
    left: [
      { text: "ORCHESTRATION", tone: "yellow" },
      { text: ` · ${snapshot.workflow.id} · `, tone: "cyan" },
      { text: `"${snapshot.workflow.goal}"`, tone: "text" },
    ],
    right: [
      ...(snapshot.demo
        ? [{ text: DEMO_LABEL, tone: "yellow" as const, bg: "selected" as const }, { text: "  " }]
        : []),
      { text: `${status.glyph} ${status.text}`, tone: status.tone },
    ],
  };
}

function wideView(
  state: OrchestrationState,
  snapshot: WorkflowSnapshot,
  width: number,
  height: number,
  g: OrchestrationGlyphs,
): RenderedBlock {
  const canvas = new Canvas();
  const inside = width - 2;
  const showDetail = state.detail;
  const leftWidth = showDetail ? Math.floor((inside - 1) * 0.58) : inside;
  const rightWidth = showDetail ? inside - 1 - leftWidth : 0;
  const title = titleSegs(snapshot, g);
  const titleWidth = inside - 4;
  const rightWidth0 = widthOf(title.right);
  const leftShown = clip(title.left, Math.max(0, titleWidth - rightWidth0 - 2));
  const filler = Math.max(0, titleWidth - widthOf(leftShown) - rightWidth0 - 2);
  canvas.push(
    compose(
      [
        { text: `${g.frame.topLeft}${g.frame.h} `, tone: "cyan" },
        ...leftShown,
        { text: ` ${g.frame.h.repeat(filler)} `, tone: "cyan" },
        ...title.right,
        { text: ` ${g.frame.h}${g.frame.topRight}`, tone: "cyan" },
      ],
      width,
    ),
  );
  framed(
    canvas,
    [{ text: " " }, ...firstThatFits(metricCandidates(snapshot, g), inside - 2)],
    width,
    g,
  );
  framed(
    canvas,
    [{ text: " " }, ...spread(tabSegs(state, "   "), [stopSeg(g), { text: " " }], inside - 1)],
    width,
    g,
  );
  canvas.raw(
    rule(
      width,
      g.frame.teeLeft,
      g.frame.teeRight,
      g,
      showDetail ? { at: leftWidth, glyph: g.frame.teeTop } : undefined,
    ),
  );
  const footer = state.status === undefined ? 4 : 5;
  const bodyRows = Math.max(0, height - canvas.lines.length - footer);
  const list = windowed(listItems(state, leftWidth - 1, g, true), bodyRows);
  const detail = showDetail ? detailLines(state, rightWidth - 2, g).slice(0, bodyRows) : [];
  for (let index = 0; index < bodyRows; index++) {
    const left = compose([{ text: " " }, ...(list[index] ?? [])], leftWidth);
    if (!showDetail) {
      canvas.raw(
        `${frameText(g.frame.v)}${left.text}${frameText(g.frame.v)}`,
        left.hits.map((hit) => ({ ...hit, start: hit.start + 1, end: hit.end + 1 })),
      );
      continue;
    }
    const right = compose([{ text: " " }, ...(detail[index] ?? [])], rightWidth, "panel");
    canvas.raw(
      `${frameText(g.frame.v)}${left.text}${frameText(g.frame.v)}${right.text}${frameText(g.frame.v)}`,
      [
        ...left.hits.map((hit) => ({ ...hit, start: hit.start + 1, end: hit.end + 1 })),
        ...right.hits.map((hit) => ({
          ...hit,
          start: hit.start + leftWidth + 2,
          end: hit.end + leftWidth + 2,
        })),
      ],
    );
  }
  canvas.raw(
    rule(
      width,
      g.frame.teeLeft,
      g.frame.teeRight,
      g,
      showDetail ? { at: leftWidth, glyph: g.frame.teeBottom } : undefined,
    ),
  );
  if (state.status !== undefined)
    framed(
      canvas,
      [
        { text: " Status: ", tone: "teal" },
        { text: state.status, tone: "yellow" },
      ],
      width,
      g,
    );
  framed(canvas, [{ text: " " }, ...eventsSegs(snapshot)], width, g);
  framed(
    canvas,
    [{ text: " " }, ...firstThatFits(actionCandidates(state, g), inside - 1)],
    width,
    g,
  );
  canvas.raw(rule(width, g.frame.bottomLeft, g.frame.bottomRight, g));
  return fitHeight(canvas.block(), width, height);
}

function compactView(
  state: OrchestrationState,
  snapshot: WorkflowSnapshot,
  width: number,
  height: number,
  g: OrchestrationGlyphs,
): RenderedBlock {
  const canvas = new Canvas();
  const status = workflowStatus(snapshot.workflow.state, g);
  const head: Seg[] = [
    { text: "ORCHESTRATION", tone: "yellow" },
    { text: ` · ${snapshot.workflow.id} · `, tone: "cyan" },
    { text: `${status.glyph} ${status.text}`, tone: status.tone },
  ];
  const demo: Seg[] = [{ text: DEMO_LABEL, tone: "yellow", bg: "selected" }];
  if (snapshot.demo && widthOf(head) + 3 + widthOf(demo) <= width)
    canvas.push(compose([...head, { text: " · ", tone: "cyan" }, ...demo], width));
  else {
    canvas.push(compose(head, width));
    if (snapshot.demo) canvas.push(compose(demo, width));
  }
  canvas.push(compose(firstThatFits(metricCandidates(snapshot, g), width), width));
  canvas.push(compose(spread(tabSegs(state, " "), [stopSeg(g)], width), width));
  const footer = (state.status === undefined ? 0 : 1) + 2;
  const available = Math.max(0, height - canvas.lines.length - footer);
  const detail = state.detail ? detailLines(state, width, g) : [];
  // The detail goes below the list; the list keeps at least five rows so the selection has neighbors.
  const detailRows = Math.min(detail.length, Math.max(0, available - 5));
  const listRows = available - detailRows;
  const list = windowed(listItems(state, width, g, false), listRows);
  for (let index = 0; index < listRows; index++) canvas.push(compose(list[index] ?? [], width));
  for (const line of detail.slice(0, detailRows)) canvas.push(compose(line, width, "panel"));
  if (state.status !== undefined)
    canvas.push(
      compose(
        [
          { text: "Status: ", tone: "teal" },
          { text: state.status, tone: "yellow" },
        ],
        width,
      ),
    );
  canvas.push(compose(eventsSegs(snapshot), width));
  canvas.push(compose(firstThatFits(actionCandidates(state, g), width), width));
  return fitHeight(canvas.block(), width, height);
}

function emptyView(
  state: OrchestrationState,
  width: number,
  height: number,
  g: OrchestrationGlyphs,
): RenderedBlock {
  const canvas = new Canvas();
  canvas.push(
    compose(
      [
        { text: "ORCHESTRATION", tone: "yellow" },
        { text: " · no workflow", tone: "cyan" },
      ],
      width,
    ),
  );
  canvas.push(compose([], width));
  const message = [
    EMPTY_MESSAGE,
    "Press D (or click Demo) to load the sample workflow here.",
    LIVE_UNAVAILABLE,
  ];
  for (const text of message)
    for (const line of wrap(text, width))
      canvas.push(compose([{ text: line, tone: "text" }], width));
  canvas.push(compose([], width));
  if (state.status !== undefined)
    canvas.push(
      compose(
        [
          { text: "Status: ", tone: "teal" },
          { text: state.status, tone: "yellow" },
        ],
        width,
      ),
    );
  canvas.push(
    compose(
      [
        button(`[D Demo: ${state.demo ? "on" : "off"}]`, { kind: "demo" }),
        { text: " " },
        stopSeg(g),
        { text: " " },
        button("[Esc Close]", { kind: "close" }, "cyan"),
      ],
      width,
    ),
  );
  return fitHeight(canvas.block(), width, height);
}

// Exactly `height` lines: blank lines fill the rest (an overlay covers the screen), extra lines are dropped.
function fitHeight(block: RenderedBlock, width: number, height: number): RenderedBlock {
  const lines = block.lines.slice(0, Math.max(0, height));
  const blank = compose([], width).text;
  while (lines.length < height) lines.push(blank);
  return { lines, hits: block.hits.filter((hit) => hit.row < lines.length) };
}

export function renderOrchestrationView(
  state: OrchestrationState,
  width: number,
  height: number,
  glyphs: OrchestrationGlyphs,
): RenderedBlock {
  if (width <= 0 || height <= 0) return { lines: [], hits: [] };
  const snapshot = state.snapshot;
  if (snapshot === undefined) return emptyView(state, width, height, glyphs);
  return width >= 120 && height >= 40
    ? wideView(state, snapshot, width, height, glyphs)
    : compactView(state, snapshot, width, height, glyphs);
}

// ---------------------------------------------------------------------------------------------------------------
// The live view of one agent.

export function renderLiveView(
  state: OrchestrationState,
  width: number,
  height: number,
  g: OrchestrationGlyphs,
): RenderedBlock {
  if (width <= 0 || height <= 0) return { lines: [], hits: [] };
  const canvas = new Canvas();
  const back = button("[Esc Back]", { kind: "back" }, "cyan");
  const node = selectedNode(state);
  if (!state.demo || state.snapshot === undefined || node === undefined) {
    // In demo the view may list no agent (a Queue emptied by Stop all): that is what it says, labeled DEMO.
    canvas.push(
      compose(
        state.demo
          ? spread(
              [{ text: "LIVE VIEW", tone: "yellow" }],
              [{ text: DEMO_LABEL, tone: "yellow", bg: "selected" }],
              width,
            )
          : [{ text: "LIVE VIEW", tone: "yellow" }],
        width,
      ),
    );
    canvas.push(compose([], width));
    for (const text of state.demo
      ? [LIVE_NOTHING_IN_DEMO]
      : [LIVE_UNAVAILABLE, "Each agent's text and tool calls will stream here while it works."])
      for (const line of wrap(text, width)) canvas.push(compose([{ text: line }], width));
    canvas.push(compose([], width));
    canvas.push(compose([back], width));
    return fitHeight(canvas.block(), width, height);
  }
  const status = nodeStatus(node, state.clock, g);
  const transcript = demoTranscript(node, state.clock);
  canvas.push(
    compose(
      spread(
        [{ text: `LIVE · ${node.label} ${node.id}`, tone: "yellow" }],
        [{ text: DEMO_LABEL, tone: "yellow", bg: "selected" }],
        width,
      ),
      width,
    ),
  );
  canvas.push(
    compose(
      [
        {
          text: `${node.label} ${node.id} · layer ${node.layer} · ${node.role} · ${node.model} · ${node.thinkingLevel ?? "level n/a"}`,
          tone: "cyan",
        },
      ],
      width,
    ),
  );
  canvas.push(
    compose(
      [
        { text: `${status.glyph} ${status.text}`, tone: status.tone },
        {
          text: ` · ${tokens(node.tokens)} tokens · context ${node.context === null ? "n/a" : `${tokens(node.context.used)} of ${tokens(node.context.threshold)}`}`,
          tone: "text",
        },
      ],
      width,
    ),
  );
  const body: Seg[][] = [
    [{ text: "Timeline", tone: "teal" }],
    ...transcript.timeline.map((entry): Seg[] => [
      { text: `  ${ago(entry.at, state.clock).padEnd(11)} `, tone: "muted" },
      { text: entry.text },
    ]),
    [{ text: "Transcript", tone: "teal" }],
    ...transcript.lines.map((line): Seg[] => [
      { text: `  ${line.kind.padEnd(10)} `, tone: line.kind === "tool" ? "cyan" : "muted" },
      {
        text: line.text.replaceAll(" -> ", ` ${g.arrow} `),
        tone: line.kind === "note" ? "yellow" : "text",
      },
    ]),
  ];
  const rows = Math.max(0, height - canvas.lines.length - 1);
  for (const line of body.slice(0, rows)) canvas.push(compose(line, width));
  while (canvas.lines.length < height - 1) canvas.push(compose([], width));
  canvas.push(
    compose(
      [
        { text: `${g.upDown} other agent · `, tone: "dim" },
        button("[L Back]", { kind: "back" }),
        { text: " " },
        back,
      ],
      width,
    ),
  );
  return fitHeight(canvas.block(), width, height);
}

export function renderOrchestrationScreen(
  state: OrchestrationState,
  width: number,
  height: number,
  glyphs: OrchestrationGlyphs,
): RenderedBlock {
  return state.screen === "live"
    ? renderLiveView(state, width, height, glyphs)
    : renderOrchestrationView(state, width, height, glyphs);
}

// ---------------------------------------------------------------------------------------------------------------
// The module panel summary.

export function renderOrchestrationSummary(
  state: OrchestrationState,
  width: number,
  maxLines: number,
  g: OrchestrationGlyphs,
): RenderedBlock {
  const canvas = new Canvas();
  if (width <= 0 || maxLines <= 0) return canvas.block();
  const open = button("[Open full view]", { kind: "open" });
  const snapshot = state.snapshot;
  if (snapshot === undefined) {
    const message = wrap(EMPTY_MESSAGE, width).slice(0, Math.max(0, maxLines - 1));
    for (const line of message) canvas.push(compose([{ text: line, tone: "text" }], width));
    canvas.push(compose([open, { text: "  " }, stopSeg(g)], width));
    return canvas.block();
  }
  const status = workflowStatus(snapshot.workflow.state, g);
  const header = compose(
    [
      ...(snapshot.demo
        ? [
            { text: DEMO_LABEL, tone: "yellow" as const, bg: "selected" as const },
            { text: " · ", tone: "cyan" as const },
          ]
        : []),
      { text: `${snapshot.workflow.id} · `, tone: "cyan" },
      { text: `${status.glyph} ${status.text}`, tone: status.tone },
      { text: ` · ${snapshot.workflow.goal}`, tone: "text" },
    ],
    width,
  );
  const metrics = compose(firstThatFits(metricCandidates(snapshot, g), width), width);
  const buttons = compose(
    spread(tabSegs(state, "  "), [open, { text: "  " }, stopSeg(g)], width),
    width,
  );
  if (maxLines < 3) {
    for (const row of [buttons, header].slice(0, maxLines)) canvas.push(row);
    return canvas.block();
  }
  canvas.push(header);
  canvas.push(metrics);
  canvas.push(buttons);
  const hint = maxLines - 3 >= 3;
  const rows = maxLines - 3 - (hint ? 1 : 0);
  const current = selectedNode({ ...state, view: "tree" })?.id;
  const items = nodesForView(snapshot, "tree").map((node) =>
    nodeItem(node, state, width, g, {
      indent: node.depth,
      selected: node.id === current,
      twoLines: false,
    }),
  );
  for (const line of windowed(items, rows)) canvas.push(compose(line, width));
  if (hint)
    canvas.push(
      compose(
        [{ text: "Click a row or a view to open it · /orchestration view · Alt+O", tone: "dim" }],
        width,
      ),
    );
  return canvas.block();
}
