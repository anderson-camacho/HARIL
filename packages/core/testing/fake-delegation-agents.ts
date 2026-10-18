import type {
  AbortInput,
  AssignInput,
  Assignment,
  DelegateInput,
  Delegation,
  Difficulty,
  ReportInput,
  RequestAuditInput,
  VerdictInput,
} from "@haril/contracts";

// Simulated agents of the three-layer delegation (docs/modos-y-delegacion.md 9, phase F1): fake:orchestrate,
// fake:delegate, fake:execute and fake:audit. Each one is a pure function of its turn: the same turn and seed always
// give the same tool call and the same cost (tokens and duration), so a simulated workflow is reproducible and a test
// can assert its result. They make the calls a real agent would make through the bridge (haril_delegate, haril_assign,
// haril_report, haril_verdict, haril_request_audit, haril_abort), and every call passes the tool contracts. The haril
// workflow demo drives them; phase F2 runs them inside FakeAgentRuntime.
//
// A scripted scenario travels as visible data, the way a real agent's behavior follows its prompt: the orchestrator
// writes "[demo:step-<n>=<behavior>]" into a part's description, the delegator copies "[demo:<behavior>]" into that
// step's instructions, and the executor follows it:
//   reject-once   the first attempt is incomplete (its auditor rejects it); the next one is complete;
//   reject-twice  every attempt is incomplete until the delegator reformulates the step (an escalation);
//   stall-once    the first attempt shows no progress (the watchdog closes it); the next one is complete.

export const FAKE_DELEGATION_AGENT_REFS = [
  "fake:orchestrate",
  "fake:delegate",
  "fake:execute",
  "fake:audit",
] as const;
export type FakeDelegationAgentRef = (typeof FAKE_DELEGATION_AGENT_REFS)[number];

export function isFakeDelegationAgentRef(value: string): value is FakeDelegationAgentRef {
  return (FAKE_DELEGATION_AGENT_REFS as readonly string[]).includes(value);
}

export type DemoBehavior = "reject-once" | "reject-twice" | "stall-once";
const BEHAVIORS: readonly DemoBehavior[] = ["reject-once", "reject-twice", "stall-once"];

// The model the orchestrator proposes by mistake on its first call (not in any catalog), so the Core's refusal shows.
export const RETIRED_MODEL = "fake/retired-model";

// What a turn cost: tokens in and out, and how long the model worked.
export interface FakeTurnCost {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly durationMs: number;
}

// --- deterministic randomness --------------------------------------------------------------------------------------

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// mulberry32 seeded by the seed and a key, so each turn draws its own stable numbers.
function randomFor(seed: number, key: string): (min: number, max: number) => number {
  let state = fnv1a(`${seed}:${key}`);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (min, max) => min + Math.floor(next() * (max - min + 1));
}

function costFor(
  seed: number,
  key: string,
  tokensIn: [number, number],
  tokensOut: [number, number],
  minutes: [number, number],
): FakeTurnCost {
  const draw = randomFor(seed, key);
  return {
    tokensIn: draw(tokensIn[0], tokensIn[1]),
    tokensOut: draw(tokensOut[0], tokensOut[1]),
    durationMs: draw(minutes[0] * 60, minutes[1] * 60) * 1000,
  };
}

// Where each scripted behavior lands for a seed: one distinct step per behavior, keyed "part-<i>/step-<j>". Fewer steps
// than behaviors drop the last behaviors.
export function demoScenario(
  seed: number,
  delegators: number,
  executorsPerDelegator: number,
): Map<string, DemoBehavior> {
  const slots: string[] = [];
  for (let part = 1; part <= delegators; part++) {
    for (let step = 1; step <= executorsPerDelegator; step++)
      slots.push(`part-${part}/step-${step}`);
  }
  const draw = randomFor(seed, "scenario");
  for (let index = slots.length - 1; index > 0; index--) {
    const other = draw(0, index);
    [slots[index], slots[other]] = [slots[other] as string, slots[index] as string];
  }
  const scenario = new Map<string, DemoBehavior>();
  BEHAVIORS.forEach((behavior, index) => {
    const slot = slots[index];
    if (slot !== undefined) scenario.set(slot, behavior);
  });
  return scenario;
}

function directiveOf(text: string): DemoBehavior | null {
  const match = /\[demo:(reject-once|reject-twice|stall-once)\]/.exec(text);
  return match === null ? null : (match[1] as DemoBehavior);
}

// --- fake:orchestrate ----------------------------------------------------------------------------------------------

export interface DelegatorReport {
  readonly localId: string;
  readonly status: ReportInput["status"];
  readonly summary: string;
  readonly issues: readonly string[];
}

export type OrchestrateTurn =
  | {
      readonly kind: "plan";
      readonly goal: string;
      readonly seed: number;
      readonly delegators: number;
      readonly executorsPerDelegator: number;
      // The issue codes of the proposal the Core refused in this turn, empty on the first call.
      readonly previousRejection: readonly string[];
      // Propose a model that does not exist on the first call, so the refusal and the correction show.
      readonly makeMistake?: boolean;
    }
  | {
      readonly kind: "continuation";
      readonly goal: string;
      readonly seed: number;
      readonly memo: string;
      readonly reports: readonly DelegatorReport[];
    }
  | {
      // The final auditor rejected the workflow.
      readonly kind: "final_rejected";
      readonly goal: string;
      readonly seed: number;
      readonly findings: readonly string[];
    };

export type OrchestratorCall =
  | { readonly tool: "haril_delegate"; readonly input: DelegateInput }
  | { readonly tool: "haril_request_audit"; readonly input: RequestAuditInput }
  | { readonly tool: "haril_abort"; readonly input: AbortInput };

const PART_DIFFICULTY: readonly Difficulty[] = ["medium", "hard", "easy", "medium", "expert"];
const STEP_DIFFICULTY: readonly Difficulty[] = ["easy", "medium", "trivial", "hard"];

export function fakeOrchestrate(turn: OrchestrateTurn): {
  readonly call: OrchestratorCall;
  readonly cost: FakeTurnCost;
} {
  if (turn.kind === "plan") {
    const scenario = demoScenario(turn.seed, turn.delegators, turn.executorsPerDelegator);
    const mistake = turn.makeMistake === true && turn.previousRejection.length === 0;
    const delegations: Delegation[] = [];
    for (let part = 1; part <= turn.delegators; part++) {
      const directives = [...scenario.entries()]
        .filter(([slot]) => slot.startsWith(`part-${part}/`))
        .map(([slot, behavior]) => `[demo:${slot.split("/")[1]}=${behavior}]`);
      delegations.push({
        localId: `part-${part}`,
        goal: `${turn.goal}: part ${part} of ${turn.delegators}`,
        description: [
          `Split part ${part} into ${turn.executorsPerDelegator} steps.`,
          ...directives,
        ].join(" "),
        difficulty: PART_DIFFICULTY[(part - 1) % PART_DIFFICULTY.length] as Difficulty,
        difficultyReason: `${turn.executorsPerDelegator} steps across a few files`,
        dependsOn: [],
        priority: 5,
        acceptanceCriteria: [`Part ${part} is done and each step was approved by its auditor`],
        model: mistake && part === turn.delegators ? RETIRED_MODEL : null,
        budget: { maxTokens: 60_000 },
      });
    }
    return {
      call: {
        tool: "haril_delegate",
        input: {
          schemaVersion: 1,
          memo: `Split the goal into ${turn.delegators} parts; read every report before asking for the final audit.`,
          delegations,
        },
      },
      cost: costFor(
        turn.seed,
        `orchestrate:plan:${turn.previousRejection.length}`,
        [3_000, 6_000],
        [600, 1_400],
        [2, 5],
      ),
    };
  }
  if (turn.kind === "continuation") {
    const done = turn.reports.filter((report) => report.status === "done");
    const rest = turn.reports.filter((report) => report.status !== "done");
    const outstanding = rest.flatMap((report) =>
      report.issues.length === 0
        ? [`${report.localId}: ${report.status}`]
        : report.issues.map((issue) => `${report.localId}: ${issue}`),
    );
    const summary =
      rest.length === 0
        ? `${done.length} of ${turn.reports.length} parts done`
        : `${done.length} of ${turn.reports.length} parts done; ${rest.length} partial or failed`;
    return {
      call: { tool: "haril_request_audit", input: { summary, outstanding } },
      cost: costFor(turn.seed, "orchestrate:continuation", [2_000, 4_000], [300, 800], [1, 3]),
    };
  }
  return {
    call: {
      tool: "haril_abort",
      input: {
        reason: `the final audit rejected the work: ${turn.findings.join("; ") || "no finding given"}`,
      },
    },
    cost: costFor(turn.seed, "orchestrate:final_rejected", [1_000, 2_000], [100, 300], [1, 2]),
  };
}

// --- fake:delegate -------------------------------------------------------------------------------------------------

export interface ExecutorOutcome {
  readonly localId: string;
  readonly status: "done" | "failed" | "escalated";
}

export type DelegateTurn =
  | {
      readonly kind: "plan";
      readonly goal: string;
      readonly description: string;
      readonly seed: number;
      readonly partId: string;
      readonly executors: number;
    }
  | {
      readonly kind: "continuation";
      readonly goal: string;
      readonly seed: number;
      readonly partId: string;
      // Steps this delegator already reformulated once.
      readonly reformulated: readonly string[];
      readonly children: readonly ExecutorOutcome[];
    };

export type DelegatorCall =
  | { readonly tool: "haril_assign"; readonly input: AssignInput }
  | { readonly tool: "haril_report"; readonly input: ReportInput };

function stepAssignment(
  partId: string,
  goal: string,
  step: number,
  instructions: string,
  writeSurface: readonly string[],
): Assignment {
  return {
    localId: `step-${step}`,
    goal: `${goal}: step ${step}`,
    instructions,
    files: { write: [...writeSurface], read: [`src/${partId}/**`] },
    tests: `Add or run the unit test of step ${step}`,
    acceptanceCriteria: [`Step ${step} is implemented`, `The test of step ${step} passes`],
    difficulty: STEP_DIFFICULTY[(step - 1) % STEP_DIFFICULTY.length] as Difficulty,
    difficultyReason: step <= 2 ? "edits one shared file" : "reads and checks only",
    dependsOn: [],
    model: null,
    budget: { maxTokens: 30_000 },
  };
}

// The first two steps write the same file, so their write surfaces overlap and the Core runs them one after the other;
// the other steps only read.
function writeSurfaceOf(partId: string, step: number): string[] {
  return step <= 2 ? [`src/${partId}/shared.ts`] : [];
}

export function fakeDelegate(turn: DelegateTurn): {
  readonly call: DelegatorCall;
  readonly cost: FakeTurnCost;
} {
  if (turn.kind === "plan") {
    const assignments: Assignment[] = [];
    for (let step = 1; step <= turn.executors; step++) {
      const behavior = new RegExp(`\\[demo:step-${step}=([a-z-]+)\\]`).exec(turn.description)?.[1];
      const instructions = [
        `Do step ${step} of ${turn.partId}.`,
        behavior === undefined ? "" : `[demo:${behavior}]`,
      ]
        .join(" ")
        .trim();
      assignments.push(
        stepAssignment(
          turn.partId,
          turn.goal,
          step,
          instructions,
          writeSurfaceOf(turn.partId, step),
        ),
      );
    }
    return {
      call: {
        tool: "haril_assign",
        input: {
          schemaVersion: 1,
          memo: `${turn.executors} steps; the first two share a file and run in sequence.`,
          assignments,
        },
      },
      cost: costFor(
        turn.seed,
        `delegate:${turn.partId}:plan`,
        [2_000, 5_000],
        [500, 1_200],
        [1, 4],
      ),
    };
  }
  const reformulate = turn.children.filter(
    (child) => child.status === "escalated" && !turn.reformulated.includes(child.localId),
  );
  const cost = costFor(
    turn.seed,
    `delegate:${turn.partId}:continuation:${turn.reformulated.length}`,
    [1_500, 3_500],
    [300, 900],
    [1, 3],
  );
  if (reformulate.length > 0) {
    return {
      call: {
        tool: "haril_assign",
        input: {
          schemaVersion: 1,
          memo: `Reformulated ${reformulate.map((child) => child.localId).join(", ")} once; a second rejection fails it.`,
          assignments: reformulate.map((child) => {
            const step = Number(child.localId.replace("step-", ""));
            return stepAssignment(
              turn.partId,
              turn.goal,
              step,
              `Do step ${step} of ${turn.partId} again, in a smaller change that meets each criterion.`,
              writeSurfaceOf(turn.partId, step),
            );
          }),
        },
      },
      cost,
    };
  }
  const failed = turn.children.filter((child) => child.status !== "done");
  const status: ReportInput["status"] =
    failed.length === 0 ? "done" : failed.length < turn.children.length ? "partial" : "failed";
  return {
    call: {
      tool: "haril_report",
      input: {
        status,
        summary: `${turn.children.length - failed.length} of ${turn.children.length} steps of ${turn.partId} approved`,
        issues: failed.map((child) => `${child.localId} failed`),
      },
    },
    cost,
  };
}

// --- fake:execute --------------------------------------------------------------------------------------------------

export interface ExecuteTurn {
  readonly seed: number;
  // A stable name of the thread (its label), so its cost does not depend on ids.
  readonly key: string;
  readonly goal: string;
  readonly instructions: string;
  // The attempt of this thread, from 1.
  readonly attempt: number;
  // The delegator reformulated the assignment.
  readonly reformulated: boolean;
}

export type ExecuteOutcome =
  | {
      readonly outcome: "succeeded";
      // Whether the work meets its criteria; an incomplete result is what its auditor rejects.
      readonly complete: boolean;
      readonly summary: string;
      readonly cost: FakeTurnCost;
    }
  // No progress at all: no tokens and no tool call, until the watchdog closes the attempt.
  | { readonly outcome: "stalled" };

export function fakeExecute(turn: ExecuteTurn): ExecuteOutcome {
  const behavior = directiveOf(turn.instructions);
  if (behavior === "stall-once" && turn.attempt === 1) return { outcome: "stalled" };
  const complete =
    behavior === "reject-once"
      ? turn.attempt > 1
      : behavior === "reject-twice"
        ? turn.reformulated
        : true;
  return {
    outcome: "succeeded",
    complete,
    summary: complete
      ? `${turn.goal}: done, test passing`
      : `${turn.goal}: partly done, the test still fails`,
    cost: costFor(
      turn.seed,
      `execute:${turn.key}:${turn.attempt}`,
      [2_000, 9_000],
      [300, 1_500],
      [1, 6],
    ),
  };
}

// --- fake:audit ----------------------------------------------------------------------------------------------------

export interface AuditTurn {
  readonly seed: number;
  readonly key: string;
  readonly scope: "task" | "workflow";
  readonly acceptanceCriteria: readonly string[];
  // The executor's result met its criteria (task scope), or every part was done (workflow scope).
  readonly complete: boolean;
}

export function fakeAudit(turn: AuditTurn): {
  readonly verdict: VerdictInput;
  readonly cost: FakeTurnCost;
} {
  const cost = costFor(turn.seed, `audit:${turn.key}`, [1_000, 4_000], [150, 500], [1, 3]);
  if (turn.complete) {
    return {
      verdict: {
        approved: true,
        reasons: turn.acceptanceCriteria.map((criterion) => ({
          criterion,
          ok: true,
          evidence:
            turn.scope === "task"
              ? "the result shows it done and its test passing"
              : "every part reported done",
        })),
      },
      cost,
    };
  }
  return {
    verdict: {
      approved: false,
      reasons: turn.acceptanceCriteria.map((criterion, index) => ({
        criterion,
        ok: index > 0,
        evidence:
          index === 0
            ? "the result reports this as not done yet"
            : "not checked after the first unmet criterion",
      })),
    },
    cost,
  };
}
