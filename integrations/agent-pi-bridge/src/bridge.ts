// HARIL bridge: a Pi extension loaded with `-e` (ADR-0004 decision 5, ARCHITECTURE 9.4). It sends the
// handshake `hello` over the run's pipe, registers the `haril` provider, the `read` tool and, for a plan task,
// `haril_propose_plan` (LD-T4), and for a workflow turn the delegation tools its role is announced (phase F2b:
// haril_delegate, haril_assign, haril_report, haril_verdict, haril_request_audit, haril_abort). A turn of a workflow that
// writes (phase F8) is also announced its workspace tools: write and edit (Pi's own shapes), haril_run, haril_merge,
// haril_merge_continue and haril_merge_abort; they go to the Runtime like the delegation tools, and the Runtime does
// them inside the turn's git worktree and declared surface. It forwards every tool operation to the Runtime, which
// decides. Pi's shell and search tools are never served: a name it does not serve is never registered, so the hello
// leaves it out and the Runtime's handshake refuses the run. Self-contained:
// node:* imports and local types only (R6), so it bundles into one file. The shapes below follow Pi 1.2.0's
// ExtensionAPI types (ProviderConfig, ProviderChatModelConfig, ToolDefinition, AgentToolResult), which are read-only
// under vendor/pi/1.2.0.

import { connect, type Socket } from "node:net";

export const BRIDGE_VERSION = "0.1.0";

// Declared locally to keep the bridge self-contained (R6); the shapes mirror Pi 1.2.0's types.
export interface ProviderModel {
  readonly id: string;
  readonly name: string;
  readonly input: readonly ("text" | "image")[];
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly api: "openai-completions";
  readonly apiKey: string;
  readonly models: readonly ProviderModel[];
}

export interface BridgeToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface BridgeToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  // The arguments the model sent, unchecked: the Runtime validates every operation.
  execute(toolCallId: string, params: Readonly<Record<string, unknown>>): Promise<BridgeToolResult>;
}

export interface BridgePiApi {
  registerProvider(name: string, config: ProviderConfig): void;
  registerTool(tool: BridgeToolDefinition): void;
}

// The runtime sets both limits (launch.ts); these defaults only apply when they are absent or not positive integers.
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;

const BRIDGE_ENV = "HARIL_BRIDGE";
const TOOLS_ENV = "HARIL_TOOLS";
const VKEY_ENV = "HARIL_VKEY";
const CONTEXT_ENV = "HARIL_MODEL_CONTEXT";
const MAX_TOKENS_ENV = "HARIL_MODEL_MAX_TOKENS";
const LEVELS_ENV = "HARIL_MODEL_LEVELS";
const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// The model's reasoning from the levels the gateway publishes (HARIL_MODEL_LEVELS, phase F7), which the runtime passes
// only when the agent's layer asks for a level: each published level maps to itself and off to "none" when published,
// so Pi keeps the --thinking level and sends it as reasoning_effort. Without a level Pi knows, the model does not reason.
export function reasoningFromLevels(value: string | undefined): {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
} {
  const published = new Set((value ?? "").split(",").filter((level) => level !== ""));
  if (!REASONING_LEVELS.some((level) => published.has(level))) return { reasoning: false };
  const map: Record<string, string | null> = { off: published.has("none") ? "none" : null };
  for (const level of REASONING_LEVELS) map[level] = published.has(level) ? level : null;
  return { reasoning: true, thinkingLevelMap: map };
}
const LF = "\n";
// The planning tool of a plan task (LD-T4): registered only when the run announces it in HARIL_TOOLS.
const PROPOSE_PLAN_TOOL = "haril_propose_plan";
// The operation every delegation tool sends; the Runtime answers with its typed reply (DelegationToolResult).
const DELEGATION_CALL_OP = "delegation.call";

interface Channel {
  send(message: Record<string, unknown>): void;
  request(message: { id: string } & Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface PendingReply {
  resolve(reply: Record<string, unknown>): void;
  reject(error: Error): void;
}

export default async function harilBridge(pi: BridgePiApi): Promise<void> {
  // Read and remove the handshake secrets before anything else can see them.
  const bridgeValue = process.env[BRIDGE_ENV];
  const toolsValue = process.env[TOOLS_ENV];
  const vkey = process.env[VKEY_ENV];
  delete process.env[BRIDGE_ENV];
  delete process.env[TOOLS_ENV];
  delete process.env[VKEY_ENV];

  const runId = process.env.HARIL_RUN_ID;
  const brokerUrl = process.env.HARIL_BROKER_URL;
  const model = process.env.HARIL_MODEL;
  if (!bridgeValue || !toolsValue || !vkey || !runId || !brokerUrl || !model) {
    throw new Error("haril bridge: the run environment is incomplete");
  }

  const split = bridgeValue.lastIndexOf("#");
  if (split <= 0) throw new Error("haril bridge: HARIL_BRIDGE has no token");
  const pipePath = bridgeValue.slice(0, split);
  const token = bridgeValue.slice(split + 1);
  const announced = toolsValue.split(",").filter((name) => name !== "");

  // A failed connection throws, so Pi fails to load the extension (fail closed).
  const channel = await openChannel(pipePath);

  pi.registerProvider("haril", {
    baseUrl: brokerUrl,
    api: "openai-completions",
    apiKey: vkey,
    models: [
      {
        id: model,
        name: model,
        input: ["text"],
        ...reasoningFromLevels(process.env[LEVELS_ENV]),
        contextWindow: positiveIntegerEnv(process.env[CONTEXT_ENV], DEFAULT_CONTEXT_WINDOW),
        maxTokens: positiveIntegerEnv(process.env[MAX_TOKENS_ENV], DEFAULT_MAX_TOKENS),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });

  // The hello lists the tools registered here and nothing else: the Runtime compares it with the run's allowed tools,
  // so a name the bridge does not serve fails the handshake instead of being announced.
  let sequence = 0;
  const nextId = (): string => `op-${++sequence}`;
  const tools = [readTool(channel, nextId)];
  if (announced.includes(PROPOSE_PLAN_TOOL)) tools.push(proposePlanTool(channel, nextId));
  for (const name of new Set(announced)) {
    const spec = DELEGATION_TOOLS[name];
    if (spec !== undefined) tools.push(delegationTool(channel, nextId, name, spec));
  }
  for (const tool of tools) pi.registerTool(tool);
  channel.send({
    type: "hello",
    runId,
    token,
    tools: tools.map((tool) => tool.name),
    bridgeVersion: BRIDGE_VERSION,
  });
}

function readTool(channel: Channel, nextId: () => string): BridgeToolDefinition {
  return {
    name: "read",
    label: "Read",
    description:
      "Read a UTF-8 text file inside the project (your worktree, in a workflow that writes). The runtime decides what may be read.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute(_toolCallId, params) {
      const path = typeof params.path === "string" ? params.path : "";
      const reply = await channel.request({ id: nextId(), op: "read", path });
      if (reply.ok === true && typeof reply.content === "string") {
        return { content: [{ type: "text", text: reply.content }], details: {} };
      }
      const error = typeof reply.error === "string" ? reply.error : "denied";
      return {
        content: [{ type: "text", text: `denied: ${error}` }],
        details: {},
        isError: true,
      };
    },
  };
}

// haril_propose_plan (LD-T4, ARCH 9.4): the arguments are the plan itself, sent as they came. The schema only names the
// two top-level fields; the Runtime checks the plan with the plan.submit rules, and a refusal comes back as an error
// result with the reason, so the model can fix the plan and call again.
function proposePlanTool(channel: Channel, nextId: () => string): BridgeToolDefinition {
  return {
    name: PROPOSE_PLAN_TOOL,
    label: "Propose plan",
    description:
      'Propose the plan of this goal: {"schemaVersion": 1, "tasks": [...]}. The runtime checks it, and a person approves it before any of its tasks runs.',
    parameters: {
      type: "object",
      properties: {
        schemaVersion: { type: "integer" },
        tasks: { type: "array", items: { type: "object" } },
      },
    },
    async execute(_toolCallId, params) {
      const reply = await channel.request({ id: nextId(), op: "plan.propose", plan: params });
      if (reply.ok === true && typeof reply.content === "string") {
        return { content: [{ type: "text", text: reply.content }], details: {} };
      }
      const error = typeof reply.error === "string" ? reply.error : "refused";
      return {
        content: [{ type: "text", text: `refused: ${error}` }],
        details: {},
        isError: true,
      };
    },
  };
}

// The delegation tools a workflow turn may be announced (docs/modos-y-delegacion.md 3.5). Their schemas mirror the
// tool contracts of @haril/contracts with the plainest JSON Schema (type, properties, required, items, enum on strings),
// which Pi validates before the call and every provider accepts. A child's model is optional (phase F6: the parent
// proposes one from the models its prompt lists, or leaves it out for the difficulty table); checkpoints are left out,
// so a model is not invited to send them. The Runtime checks every call again with the contracts and the Core rules,
// and its reply carries the reason of a refusal.
interface DelegationToolSpec {
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

const text = (description: string) => ({ type: "string", description });
const texts = (description: string) => ({ type: "array", items: { type: "string" }, description });
const DIFFICULTY = {
  type: "string",
  enum: ["trivial", "easy", "medium", "hard", "expert"],
  description: "How hard the work is, from trivial to expert.",
};
const BUDGET = {
  type: "object",
  description: "The child's token budget for one turn.",
  properties: {
    maxTokens: {
      type: "integer",
      description: "Tokens the child may spend in one turn, its instructions included.",
    },
  },
  required: ["maxTokens"],
};
const LOCAL_ID = text('A short id of letters, digits, "-" or "_", unique among your children.');
const CHILD_MODEL = text(
  "Optional: the model for this child, one your prompt lists under Models for your children. Leave it out to let the difficulty table choose.",
);
const SCHEMA_VERSION = { type: "integer", description: "Always 1." };
const MEMO = text(
  "A note to your future self, at most 2000 characters: it comes back in your next turn.",
);

const DELEGATION_TOOLS: Readonly<Record<string, DelegationToolSpec>> = {
  haril_delegate: {
    label: "Delegate",
    description:
      "Orchestrator only: propose the parts of the goal, one delegator each. The runtime checks the proposal against the workflow's limits; once it accepts, end your turn: the delegators run, and you run again with their reports.",
    parameters: {
      type: "object",
      properties: {
        schemaVersion: SCHEMA_VERSION,
        memo: MEMO,
        delegations: {
          type: "array",
          description: "One entry per delegator.",
          items: {
            type: "object",
            properties: {
              localId: LOCAL_ID,
              goal: text("The part's goal, in one sentence."),
              description: text("The detail the goal lacks: what to read, what to report."),
              difficulty: DIFFICULTY,
              difficultyReason: text("Why it is that difficult."),
              dependsOn: texts("localIds of parts it waits for; [] lets it run in parallel."),
              priority: { type: "integer", description: "0 (lowest) to 9 (highest)." },
              acceptanceCriteria: texts("What must be true when the part is done, in words."),
              model: CHILD_MODEL,
              budget: BUDGET,
            },
            required: [
              "localId",
              "goal",
              "description",
              "difficulty",
              "difficultyReason",
              "dependsOn",
              "priority",
              "acceptanceCriteria",
              "budget",
            ],
          },
        },
      },
      required: ["schemaVersion", "memo", "delegations"],
    },
  },
  haril_assign: {
    label: "Assign",
    description:
      "Delegator only: assign the steps of your part, one executor each; every executor gets its own auditor. Once the runtime accepts, end your turn: you run again with the executors' outcomes and verdicts.",
    parameters: {
      type: "object",
      properties: {
        schemaVersion: SCHEMA_VERSION,
        memo: MEMO,
        assignments: {
          type: "array",
          description: "One entry per executor.",
          items: {
            type: "object",
            properties: {
              localId: LOCAL_ID,
              goal: text("The step's goal, in one sentence."),
              instructions: text("The exact method: what to read and what to answer."),
              files: {
                type: "object",
                description: "The step's surface, as paths or globs relative to the project root.",
                properties: {
                  write: texts(
                    "The globs the step may write; [] when it only reads, and always [] in a read-only workflow.",
                  ),
                  read: texts("The files the step reads."),
                },
                required: ["write", "read"],
              },
              tests: text("What to check and how; an empty text when nothing runs."),
              acceptanceCriteria: texts("What the auditor checks the result against."),
              difficulty: DIFFICULTY,
              difficultyReason: text("Why it is that difficult."),
              dependsOn: texts("localIds of steps it waits for (their approval); [] for none."),
              model: CHILD_MODEL,
              budget: BUDGET,
            },
            required: [
              "localId",
              "goal",
              "instructions",
              "files",
              "tests",
              "acceptanceCriteria",
              "difficulty",
              "difficultyReason",
              "dependsOn",
              "budget",
            ],
          },
        },
      },
      required: ["schemaVersion", "memo", "assignments"],
    },
  },
  haril_report: {
    label: "Report",
    description:
      "Delegator only, after your executors finished: close your part with its status, a short summary of what was found and the open issues. Your orchestrator reads it.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["done", "partial", "failed"],
          description: "How the part ended.",
        },
        summary: text("What the part found or did, short: the orchestrator reads it."),
        issues: texts("What is still wrong or open; [] for none."),
      },
      required: ["status", "summary", "issues"],
    },
  },
  haril_verdict: {
    label: "Verdict",
    description:
      "Auditor only: approve or reject the work against each acceptance criterion, one reason per criterion. A rejection needs at least one reason that is not met.",
    parameters: {
      type: "object",
      properties: {
        approved: { type: "boolean", description: "true when every criterion is met." },
        reasons: {
          type: "array",
          description: "One reason per criterion.",
          items: {
            type: "object",
            properties: {
              criterion: text("The criterion, as written."),
              ok: { type: "boolean", description: "Whether it is met." },
              evidence: text("What shows it: a quote, a file, a fact."),
            },
            required: ["criterion", "ok", "evidence"],
          },
        },
      },
      required: ["approved", "reasons"],
    },
  },
  haril_request_audit: {
    label: "Request audit",
    description:
      "Orchestrator only, when nothing is pending: ask for the final audit of the whole workflow, with a summary of the result and what is still open.",
    parameters: {
      type: "object",
      properties: {
        summary: text("The workflow's result, short: the final auditor reads it."),
        outstanding: texts("What is still open; [] for none."),
      },
      required: ["summary", "outstanding"],
    },
  },
  haril_abort: {
    label: "Abort",
    description: "Orchestrator only: end the workflow as failed, with the reason.",
    parameters: {
      type: "object",
      properties: { reason: text("Why the workflow cannot reach its goal.") },
      required: ["reason"],
    },
  },
  // The workspace tools of a turn in a git worktree (phase F8). None of them decides the turn.
  write: {
    label: "Write",
    description:
      "Write a whole file in your worktree, creating it or replacing it, with its folders. The path is relative to the project root and must be inside your write surface; .git, .haril and secret files are refused.",
    parameters: {
      type: "object",
      properties: {
        path: text("The file's path relative to the project root."),
        content: text("The file's whole new content."),
      },
      required: ["path", "content"],
    },
  },
  edit: {
    label: "Edit",
    description:
      "Edit a file in your worktree with exact text replacements. Each edits[].oldText must appear exactly once in the file and the edits must not overlap; the path must be inside your write surface.",
    parameters: {
      type: "object",
      properties: {
        path: text("The file's path relative to the project root."),
        edits: {
          type: "array",
          description: "One or more replacements, each matched against the original file.",
          items: {
            type: "object",
            properties: {
              oldText: text("Exact text to replace; it must be unique in the file."),
              newText: text("The replacement text."),
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  haril_run: {
    label: "Run command",
    description:
      "Run one allowed command in your worktree, for example the tests: the program and its arguments, never a shell line. The answer has its exit code and the end of its output.",
    parameters: {
      type: "object",
      properties: {
        command: text('The program, for example "npm".'),
        args: texts('Its arguments, for example ["test"].'),
      },
      required: ["command"],
    },
  },
  haril_merge: {
    label: "Merge step",
    description:
      "Delegator only: merge one of your approved steps into the integration branch. When it conflicts, the answer lists the conflicting files: fix them with edit or write, then call haril_merge_continue.",
    parameters: {
      type: "object",
      properties: { localId: text("The step's localId.") },
      required: ["localId"],
    },
  },
  haril_merge_continue: {
    label: "Continue merge",
    description:
      "Delegator only: commit the merge whose conflicts you resolved; refused while a file still holds a conflict marker.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  haril_merge_abort: {
    label: "Abort merge",
    description:
      "Delegator only: give up the merge that waits for its conflicts; the integration branch stays as it was.",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

// A delegation tool sends its arguments as they came; the Runtime validates them, answers with its typed reply and,
// for a refusal, the reason, so the model can fix the call and make it again in the same turn.
function delegationTool(
  channel: Channel,
  nextId: () => string,
  name: string,
  spec: DelegationToolSpec,
): BridgeToolDefinition {
  return {
    name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_toolCallId, params) {
      const reply = await channel.request({
        id: nextId(),
        op: DELEGATION_CALL_OP,
        tool: name,
        input: params,
      });
      const typed = isRecord(reply.reply) ? reply.reply : {};
      if (reply.ok === true && typeof reply.content === "string") {
        return { content: [{ type: "text", text: reply.content }], details: { reply: typed } };
      }
      const error = typeof reply.error === "string" ? reply.error : "refused";
      return {
        content: [{ type: "text", text: `refused: ${error}` }],
        details: { reply: typed },
        isError: true,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function openChannel(pipePath: string): Promise<Channel> {
  return new Promise<Channel>((resolve, reject) => {
    const socket: Socket = connect(pipePath);
    const waiting = new Map<string, PendingReply>();
    let connected = false;
    let closed = false;
    let buffer = "";

    const closeChannel = (reason: string) => {
      if (closed) return;
      closed = true;
      for (const pending of waiting.values()) pending.reject(new Error(reason));
      waiting.clear();
    };

    socket.once("error", (error) => {
      if (!connected) reject(error);
      closeChannel("haril bridge: the channel failed");
    });
    socket.on("close", () => closeChannel("haril bridge: the channel is closed"));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let lf = buffer.indexOf(LF);
      while (lf !== -1) {
        const line = buffer.slice(0, lf).replace(/\r$/, "");
        buffer = buffer.slice(lf + 1);
        lf = buffer.indexOf(LF);
        if (line === "") continue;
        const reply = parseReply(line);
        if (reply === undefined || typeof reply.id !== "string") continue;
        const pending = waiting.get(reply.id);
        waiting.delete(reply.id);
        pending?.resolve(reply);
      }
    });

    socket.once("connect", () => {
      connected = true;
      resolve({
        send(message) {
          if (!closed) socket.write(`${JSON.stringify(message)}${LF}`);
        },
        request(message) {
          return new Promise<Record<string, unknown>>((done, fail) => {
            if (closed) {
              fail(new Error("haril bridge: the channel is closed"));
              return;
            }
            waiting.set(message.id, { resolve: done, reject: fail });
            socket.write(`${JSON.stringify(message)}${LF}`);
          });
        },
      });
    });
  });
}

function parseReply(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
