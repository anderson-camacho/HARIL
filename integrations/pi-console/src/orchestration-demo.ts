import type { WorkflowNode, WorkflowSnapshot } from "./orchestration-types.js";

// The demo data of the ORCHESTRATION view: the approved mockup's workflow (docs/ADR-0021, "Datos de demostración"),
// eleven nodes in three layers. It is sample data, never HARIL state: the snapshot says `demo: true` and every screen
// that draws it carries the DEMO label. Times are relative to `now`, the moment the demo was loaded, so the view
// reads "9 s ago" and "in 12 min" the same way every time. The same data feeds the console's automated tests.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const CONTEXT_THRESHOLD = 300_000;
const ORCHESTRATOR_THRESHOLD = 400_000;
const NO_QUOTA_DATA = { window5hPct: null, weeklyPct: null } as const;

type NodeFields = Pick<WorkflowNode, "id" | "parentId" | "role" | "label" | "goal" | "state">;

function node(fields: NodeFields, rest: Partial<WorkflowNode>): WorkflowNode {
  const layer = fields.role === "orchestrator" ? 1 : fields.role === "delegator" ? 2 : 3;
  return {
    threadId: `t-${fields.id}`,
    depth: 0,
    layer,
    model: "fast-model",
    modelSource: "table",
    thinkingLevel: null,
    tokens: 0,
    elapsedMs: null,
    lastProgress: null,
    nextCheckAt: null,
    context: null,
    quota: null,
    difficulty: null,
    files: { write: [], read: [] },
    memo: null,
    audit: null,
    waitingReason: null,
    turn: null,
    ...fields,
    ...rest,
  };
}

function demoNodes(now: number): WorkflowNode[] {
  return [
    node(
      {
        id: "o1",
        parentId: null,
        role: "orchestrator",
        label: "Orchestrator",
        goal: "Change the primary button color and test it",
        state: "waiting",
      },
      {
        model: "high-model",
        modelSource: "pinned",
        thinkingLevel: "high",
        tokens: 18_000,
        elapsedMs: 21 * MINUTE + 12 * SECOND,
        lastProgress: { at: now - (20 * MINUTE + 30 * SECOND), text: "delegated to 2 threads" },
        context: { used: 18_000, threshold: ORCHESTRATOR_THRESHOLD },
        quota: { window5hPct: 38, weeklyPct: 52 },
        difficulty: { estimated: "hard", reason: "plans and splits the whole goal" },
        files: { write: [], read: ["src/theme.ts", "src/components/Button.tsx"] },
        memo: "Wait for d1 and d2, then check the button end to end before reporting.",
        waitingReason: "waiting for children",
        turn: { index: 1, of: 2 },
      },
    ),
    node(
      {
        id: "d1",
        parentId: "o1",
        role: "delegator",
        label: "Delegator 1",
        goal: "Primary button: color and states",
        state: "running",
      },
      {
        depth: 1,
        model: "mid-model",
        modelSource: "parent",
        thinkingLevel: "high",
        tokens: 41_000,
        elapsedMs: 2 * MINUTE + 40 * SECOND,
        lastProgress: { at: now - 9 * SECOND, text: "assigned 3 executors" },
        nextCheckAt: now + 12 * MINUTE,
        context: { used: 41_000, threshold: CONTEXT_THRESHOLD },
        quota: { window5hPct: 38, weeklyPct: 52 },
        difficulty: { estimated: "medium", reason: "three files" },
        files: {
          write: [],
          read: ["src/theme.ts", "src/components/Button.tsx", "src/components/Button.css"],
        },
        memo: "Integrate e1, e2 and e3; if an audit fails, retry once and then escalate.",
        turn: { index: 1, of: 2 },
      },
    ),
    node(
      {
        id: "e1",
        parentId: "d1",
        role: "executor",
        label: "Executor",
        goal: "Create tintColor() in theme.ts",
        state: "running",
      },
      {
        depth: 2,
        thinkingLevel: "medium",
        tokens: 12_000,
        elapsedMs: 2 * MINUTE + 10 * SECOND,
        lastProgress: { at: now - 12 * SECOND, text: "edited src/theme.ts" },
        nextCheckAt: now + 13 * MINUTE,
        context: { used: 12_000, threshold: CONTEXT_THRESHOLD },
        quota: NO_QUOTA_DATA,
        difficulty: { estimated: "easy", reason: "one file, one function" },
        files: { write: ["src/theme.ts"], read: [] },
      },
    ),
    node(
      {
        id: "a1",
        parentId: "e1",
        role: "auditor",
        label: "Auditor",
        goal: "Review e1 against its criteria",
        state: "queued",
      },
      {
        depth: 3,
        model: "auditor-model",
        thinkingLevel: "medium",
        quota: NO_QUOTA_DATA,
        difficulty: { estimated: "easy", reason: "review of one function" },
        files: { write: [], read: ["src/theme.ts"] },
        waitingReason: "waits for e1 to finish",
      },
    ),
    node(
      {
        id: "e2",
        parentId: "d1",
        role: "executor",
        label: "Executor",
        goal: "Apply the color in Button.tsx",
        state: "queued",
      },
      {
        depth: 2,
        thinkingLevel: "medium",
        quota: NO_QUOTA_DATA,
        difficulty: { estimated: "easy", reason: "one component" },
        files: { write: ["src/components/Button.tsx"], read: ["src/theme.ts"] },
        waitingReason: "depends on e1",
      },
    ),
    node(
      {
        id: "e3",
        parentId: "d1",
        role: "executor",
        label: "Executor",
        goal: "Disabled-state styles",
        state: "done",
      },
      {
        depth: 2,
        thinkingLevel: "low",
        tokens: 9_000,
        elapsedMs: 95 * SECOND,
        lastProgress: { at: now - 70 * SECOND, text: "finished the disabled-state styles" },
        context: { used: 9_000, threshold: CONTEXT_THRESHOLD },
        quota: NO_QUOTA_DATA,
        difficulty: { estimated: "easy", reason: "one stylesheet" },
        files: { write: ["src/components/Button.css"], read: [] },
        audit: { verdict: "approved", summary: "approved after 1 retry", retries: 1 },
      },
    ),
    node(
      {
        id: "a3",
        parentId: "e3",
        role: "auditor",
        label: "Auditor",
        goal: "Review e3",
        state: "done",
      },
      {
        depth: 3,
        model: "auditor-model",
        thinkingLevel: "medium",
        tokens: 5_000,
        elapsedMs: 40 * SECOND,
        lastProgress: { at: now - 40 * SECOND, text: "approved: 3 of 3 criteria" },
        context: { used: 5_000, threshold: CONTEXT_THRESHOLD },
        quota: NO_QUOTA_DATA,
        difficulty: { estimated: "easy", reason: "review of one stylesheet" },
        files: { write: [], read: ["src/components/Button.css"] },
        audit: { verdict: "approved", summary: "3 of 3 criteria met", retries: 0 },
      },
    ),
    node(
      {
        id: "d2",
        parentId: "o1",
        role: "delegator",
        label: "Delegator 2",
        goal: "Button tests",
        state: "running",
      },
      {
        depth: 1,
        model: "mid-model",
        modelSource: "parent",
        thinkingLevel: "high",
        tokens: 33_000,
        elapsedMs: 2 * MINUTE + 30 * SECOND,
        lastProgress: { at: now - 30 * SECOND, text: "assigned 2 executors" },
        nextCheckAt: now + 11 * MINUTE,
        context: { used: 33_000, threshold: CONTEXT_THRESHOLD },
        quota: { window5hPct: 83, weeklyPct: 41 },
        difficulty: { estimated: "medium", reason: "tests plus reference screenshots" },
        files: { write: [], read: ["src/components/Button.tsx"] },
        memo: "Run the tests after e4; regenerate the screenshots only if they changed.",
        turn: { index: 1, of: 2 },
      },
    ),
    node(
      {
        id: "e4",
        parentId: "d2",
        role: "executor",
        label: "Executor",
        goal: "Write Button tests",
        state: "running",
      },
      {
        depth: 2,
        thinkingLevel: "medium",
        tokens: 14_000,
        elapsedMs: 2 * MINUTE,
        lastProgress: { at: now - 20 * SECOND, text: "wrote 4 test cases" },
        nextCheckAt: now + 10 * MINUTE,
        context: { used: 14_000, threshold: CONTEXT_THRESHOLD },
        quota: NO_QUOTA_DATA,
        difficulty: { estimated: "easy", reason: "one test file" },
        files: { write: ["tests/Button.test.ts"], read: ["src/components/Button.tsx"] },
      },
    ),
    node(
      {
        id: "a4",
        parentId: "e4",
        role: "auditor",
        label: "Auditor",
        goal: "Review e4",
        state: "queued",
      },
      {
        depth: 3,
        model: "auditor-model",
        thinkingLevel: "medium",
        quota: NO_QUOTA_DATA,
        difficulty: { estimated: "easy", reason: "review of one test file" },
        files: { write: [], read: ["tests/Button.test.ts"] },
        waitingReason: "waits for e4 to finish",
      },
    ),
    node(
      {
        id: "e5",
        parentId: "d2",
        role: "executor",
        label: "Executor",
        goal: "Generate reference screenshots",
        state: "running",
      },
      {
        depth: 2,
        thinkingLevel: "low",
        tokens: 6_000,
        elapsedMs: 19 * MINUTE,
        lastProgress: { at: now - 17 * MINUTE, text: "captured 2 of 6 screenshots" },
        nextCheckAt: now + 30 * SECOND,
        context: { used: 6_000, threshold: CONTEXT_THRESHOLD },
        quota: NO_QUOTA_DATA,
        difficulty: { estimated: "easy", reason: "scripted captures" },
        files: { write: ["tests/__screenshots__/"], read: ["src/components/Button.tsx"] },
      },
    ),
  ];
}

// The demo workflow as a fresh snapshot. Totals and capacity agree with the nodes: 138k tokens, 3 of 5 executors
// working, 0 of 5 auditors, 11 agents created and 3 queued.
export function demoSnapshot(now: number): WorkflowSnapshot {
  const nodes = demoNodes(now);
  const elapsedMs = 21 * MINUTE + 12 * SECOND;
  return {
    schemaVersion: 1,
    demo: true,
    workflow: {
      id: "wf_ab12",
      goal: "Change the primary button color and test it",
      state: "running",
      startedAt: now - elapsedMs,
      elapsedMs,
      autonomy: { mode: "stops", stops: ["after_plan"] },
      orchestratorModel: "high-model",
    },
    totals: {
      tokensUsed: nodes.reduce((sum, item) => sum + item.tokens, 0),
      tokensBudget: 20_000_000,
      agentsCreated: nodes.length,
      agentsCap: 100,
      queued: nodes.filter((item) => item.state === "queued").length,
      retries: 1,
      escalations: 0,
    },
    capacity: {
      executors: { live: 3, max: 5 },
      auditors: { live: 0, max: 5 },
      delegators: { live: 2, max: 5 },
    },
    nodes,
    quota: [
      {
        provider: "claude",
        credential: "account 1",
        window5hPct: 38,
        weeklyPct: 52,
        resetAt: now + 2 * 60 * MINUTE,
        note: "in use",
      },
      {
        provider: "claude",
        credential: "account 2",
        window5hPct: 83,
        weeklyPct: 41,
        resetAt: now + 70 * MINUTE,
        note: "avoided: 5h window above 80%",
      },
      {
        provider: "gemini",
        credential: "account 1",
        window5hPct: 20,
        weeklyPct: 88,
        resetAt: now + 3 * 24 * 60 * MINUTE,
        note: "not used: weekly above 80%",
      },
      {
        provider: "codex",
        credential: "account 1",
        window5hPct: null,
        weeklyPct: null,
        resetAt: null,
        note: "no data",
      },
    ],
    events: [
      { at: now - elapsedMs, type: "workflow.started", text: "wf_ab12 started" },
      {
        at: now - 21 * MINUTE,
        type: "stop.reached",
        text: "after_plan: plan ready for review",
      },
      {
        at: now - (20 * MINUTE + 50 * SECOND),
        type: "stop.continued",
        text: "after_plan continued by the user",
      },
      { at: now - (20 * MINUTE + 30 * SECOND), type: "delegation.applied", text: "o1 (2)" },
      { at: now - (19 * MINUTE + 10 * SECOND), type: "delegation.applied", text: "d2 (2)" },
      { at: now - 19 * MINUTE, type: "task.claimed", text: "e5 claimed by fast-model" },
      { at: now - 70 * SECOND, type: "task.done", text: "e3 done" },
      { at: now - 55 * SECOND, type: "watchdog.checked", text: "e4 active" },
      { at: now - 40 * SECOND, type: "audit.verdict", text: "a3 approved" },
      { at: now - 9 * SECOND, type: "delegation.applied", text: "d1 (3)" },
    ],
    usage: [
      {
        at: now - (21 * MINUTE + 30 * SECOND),
        kind: "chat",
        role: "user",
        model: "high-model",
        tokensIn: 2_400,
        tokensOut: 600,
        durationMs: 5_200,
        difficulty: null,
        outcome: "/delegate confirmed",
      },
      {
        at: now - (20 * MINUTE + 30 * SECOND),
        kind: "agent_run",
        role: "orchestrator",
        model: "high-model",
        tokensIn: 14_000,
        tokensOut: 4_000,
        durationMs: 42_000,
        difficulty: "hard",
        outcome: "delegated to 2 threads",
      },
      {
        at: now - (19 * MINUTE + 10 * SECOND),
        kind: "agent_run",
        role: "delegator",
        model: "mid-model",
        tokensIn: 26_000,
        tokensOut: 7_000,
        durationMs: 61_000,
        difficulty: "medium",
        outcome: "assigned 2 executors",
      },
      {
        at: now - 200 * SECOND,
        kind: "agent_run",
        role: "executor",
        model: "fast-model",
        tokensIn: 5_000,
        tokensOut: 1_500,
        durationMs: 52_000,
        difficulty: "easy",
        outcome: "rejected by audit",
      },
      {
        at: now - 70 * SECOND,
        kind: "agent_run",
        role: "executor",
        model: "fast-model",
        tokensIn: 2_000,
        tokensOut: 500,
        durationMs: 43_000,
        difficulty: "easy",
        outcome: "done",
      },
      {
        at: now - 40 * SECOND,
        kind: "agent_run",
        role: "auditor",
        model: "auditor-model",
        tokensIn: 4_000,
        tokensOut: 1_000,
        durationMs: 40_000,
        difficulty: "easy",
        outcome: "approved",
      },
      {
        at: now - 30 * SECOND,
        kind: "chat",
        role: "user",
        model: "high-model",
        tokensIn: null,
        tokensOut: null,
        durationMs: null,
        difficulty: null,
        outcome: "question about e5",
      },
      {
        at: now - 9 * SECOND,
        kind: "agent_run",
        role: "delegator",
        model: "mid-model",
        tokensIn: 30_000,
        tokensOut: 11_000,
        durationMs: 160_000,
        difficulty: "medium",
        outcome: null,
      },
    ],
  };
}

interface DemoTranscriptLine {
  readonly kind: "assistant" | "tool" | "note";
  readonly text: string;
}

export interface DemoTranscript {
  readonly timeline: readonly { readonly at: number; readonly text: string }[];
  readonly lines: readonly DemoTranscriptLine[];
}

function roleLines(item: WorkflowNode): DemoTranscriptLine[] {
  const file = item.files.write[0] ?? item.files.read[0] ?? "the project files";
  switch (item.role) {
    case "orchestrator":
      return [
        {
          kind: "assistant",
          text: "I will split the goal into two threads: the button and its tests.",
        },
        { kind: "tool", text: "haril_delegate 2 threads -> accepted by Core" },
        {
          kind: "assistant",
          text: "Waiting for both threads; my memo keeps the integration plan.",
        },
      ];
    case "delegator":
      return [
        { kind: "assistant", text: `Breaking "${item.goal}" into executor tasks.` },
        { kind: "tool", text: `read ${file} -> 84 lines` },
        { kind: "tool", text: "haril_delegate executors -> accepted by Core" },
        { kind: "assistant", text: "I will integrate the results when the audits finish." },
      ];
    case "executor":
      return [
        { kind: "assistant", text: `Working on: ${item.goal}.` },
        { kind: "tool", text: `read ${file} -> 84 lines` },
        { kind: "tool", text: `edit ${file} -> +18 -2` },
        { kind: "assistant", text: "Running the type check next." },
      ];
    case "auditor":
      return [
        { kind: "assistant", text: "Reviewing the change against the task criteria." },
        { kind: "tool", text: `read ${file} -> 84 lines` },
        { kind: "assistant", text: "Checking each criterion before giving a verdict." },
      ];
  }
}

// A simulated transcript for the live view of one node: what a real one will show once workflows exist.
export function demoTranscript(item: WorkflowNode, now: number): DemoTranscript {
  const timeline: { at: number; text: string }[] = [];
  const claimedAt = item.elapsedMs === null ? undefined : now - item.elapsedMs;
  if (claimedAt === undefined) {
    timeline.push({ at: now, text: `created; ${item.waitingReason ?? "waiting in the queue"}` });
  } else {
    timeline.push({ at: claimedAt - 5 * SECOND, text: "created" });
    timeline.push({ at: claimedAt, text: `claimed by ${item.model}` });
  }
  if (item.lastProgress !== null)
    timeline.push({ at: item.lastProgress.at, text: `progress: ${item.lastProgress.text}` });
  if (item.audit !== null)
    timeline.push({ at: now, text: `audit ${item.audit.verdict}: ${item.audit.summary}` });
  if (item.state === "closed")
    timeline.push({ at: now, text: `watchdog closed it: ${item.waitingReason ?? "no progress"}` });
  if (item.state === "cancelled") timeline.push({ at: now, text: "cancelled by stop all" });
  timeline.sort((left, right) => left.at - right.at);

  if (item.state === "queued")
    return {
      timeline,
      lines: [{ kind: "note", text: `Not started yet: ${item.waitingReason ?? "queued"}.` }],
    };
  const lines = roleLines(item);
  if (item.state === "done")
    lines.push({ kind: "assistant", text: "Finished; the result is ready." });
  if (item.state === "closed")
    lines.push({ kind: "note", text: "The watchdog closed this attempt: no progress for 15 min." });
  if (item.state === "cancelled") lines.push({ kind: "note", text: "Cancelled by stop all." });
  return { timeline, lines };
}
