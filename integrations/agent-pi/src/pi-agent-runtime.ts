// AgentRuntime adapter for Pi 1.2.0 in `--mode rpc` (ADR-0004). One Pi process per attempt. The adapter
// owns the bridge channel (named pipe or unix socket with a 256-bit token), the RPC JSONL stream, the
// handshake (fail closed), the bridge read operation through PathGuard, the plan.propose operation of a plan
// task through the host's proposer (LD-T4), the delegation.call operation of a workflow turn through the host's
// delegation tools (phase F2b), and the abort/kill escalation. A workflow turn is read-only until writing arrives
// (phase F8): it launches only with read and the delegation tools, whatever its spec asks.
// It never sends new_session, switch_session, fork or clone, and it never logs the token or the key.

import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type {
  AgentHandle,
  AgentHello,
  AgentOutcome,
  AgentProcess,
  AgentRuntime,
  AgentSpec,
  BootStart,
  DelegationToolHandler,
  DelegationToolResult,
  HarilError,
  PlanProposalResult,
  PlanProposer,
  Result,
} from "@haril/core/ports";
import { JsonlReader } from "./jsonl.js";
import {
  buildPiArgv,
  buildPiEnv,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  defaultSpawn,
  killProcessTree,
  type SpawnFn,
} from "./launch.js";
import { createPathGuard, type PathGuard } from "./path-guard.js";
import { readGuardedFile } from "./read-guarded.js";

export interface PiTimings {
  readonly helloTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly graceMs?: number;
}

// plan_refused: the host refused a plan.propose (an invalid plan, a closed attempt); the agent hears the reason.
// delegation_refused: the host refused a delegation.call (a bad input, a limit, a second deciding call).
export type BridgeOperationOutcome =
  | "ok"
  | "path_denied"
  | "too_large"
  | "read_failed"
  | "plan_refused"
  | "delegation_refused"
  | "unsupported";

// Event-friendly record of one bridge operation: the path is hashed and the content is never included.
// A path_denied operation carries the PathGuard reason (a fixed code such as outside_root), never the path.
// A plan.propose has no path (pathSha256 hashes ""): it carries the plan's SHA-256 and UTF-8 size, and the approval an
// accepted plan became, never the plan. A refused one also carries the reason the host gave the agent (LD-T7c), cut to
// MAX_REFUSAL_REASON_CHARS, so the refusal is audited outside the Pi session log. The reason is HARIL's own validation
// message: it may name a task's local id, its agent or the paths it lists, never a goal or a description.
// A delegation.call names its tool and carries its input's SHA-256 and UTF-8 size, and the refusal reason the agent
// heard (capped the same way), never the input.
export interface BridgeOperationEvent {
  readonly runId: string;
  readonly op: string;
  readonly pathSha256: string;
  readonly outcome: BridgeOperationOutcome;
  readonly reason?: string;
  readonly planSha256?: string;
  readonly planBytes?: number;
  readonly approvalId?: string;
  readonly tool?: string;
  readonly inputSha256?: string;
  readonly inputBytes?: number;
}

type OperationDetail = Pick<
  BridgeOperationEvent,
  "reason" | "planSha256" | "planBytes" | "approvalId" | "tool" | "inputSha256" | "inputBytes"
>;

export interface PiAgentRuntimeOptions {
  readonly nodePath: string;
  readonly piCliPath: string;
  readonly bridgePath: string;
  readonly brokerUrl: string;
  readonly projectRoot: string;
  readonly runsDir: string;
  // Expected active model: passed as --model and checked with get_state before the first prompt.
  readonly model: string;
  // Virtual key for the Broker. Reserve delivery through HARIL_VKEY (ADR-0005 BR-4); never argv or events.
  readonly virtualKey: string;
  // Limits the bridge registers for the model (HARIL_MODEL_CONTEXT, HARIL_MODEL_MAX_TOKENS). Positive integers.
  readonly modelContextWindow?: number;
  readonly modelMaxTokens?: number;
  readonly spawn?: SpawnFn;
  readonly pathGuard?: PathGuard;
  readonly timings?: PiTimings;
  readonly onBridgeOperation?: (event: BridgeOperationEvent) => void;
  // The host side of haril_propose_plan (LD-T4). Without it, plan.propose is unsupported and a plan task cannot propose.
  readonly proposePlan?: PlanProposer;
  // The host side of the delegation tools (phase F2b). Without it, delegation.call is unsupported and a workflow turn
  // cannot make its deciding call.
  readonly delegationTools?: DelegationToolHandler;
  // Linux (3.14): reads the spawned pid's boot ticks right after the spawn, recorded with its start time so a wall-clock
  // step never makes the live agent look like a reused pid. Absent or undefined elsewhere.
  readonly bootStartOf?: (pid: number) => BootStart | undefined;
  // The host's verified tree kill (3.14): one snapshot of the processes, the root checked against its recorded start and
  // each descendant against its parent's, every pid killed on its own, root first. "gone": the root no longer runs as
  // recorded; "unreadable": the process table could not be read. Without it, or when it answers "unreadable", the OS's
  // own tree kill (taskkill /T, or the POSIX process group) is the fallback.
  readonly killTree?: (process: AgentProcess) => Promise<"killed" | "gone" | "unreadable">;
}

export interface PiDiagnostics {
  readonly ignoredEvents: number;
  readonly warnings: readonly string[];
}

export interface PiAgentHandle extends AgentHandle {
  readonly diagnostics: PiDiagnostics;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_READ_BYTES = 1024 * 1024;
// The bridge tool of a plan task and its operation (LD-T4). Core values stay out of this adapter, so the name is local.
const PROPOSE_PLAN_TOOL = "haril_propose_plan";
const PLAN_PROPOSE_OP = "plan.propose";
// The delegation tools the bridge serves to a workflow turn and their one operation (phase F2b). Kept local like the
// plan tool's name; the host's handler checks the tool against the turn's archetype again.
const DELEGATION_CALL_OP = "delegation.call";
const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  "haril_delegate",
  "haril_assign",
  "haril_report",
  "haril_verdict",
  "haril_request_audit",
  "haril_abort",
]);
// What a workflow turn may be offered until writing arrives (phase F8): read and the delegation tools. Nothing that
// writes, edits or runs a command (Pi's write, edit or bash, HARIL's haril_run or haril_merge) launches.
const WORKFLOW_TOOLS: ReadonlySet<string> = new Set(["read", ...DELEGATION_TOOLS]);
// Pi waits for an answer only to these extension dialogs; every other extension_ui_request is fire-and-forget.
const DIALOG_METHODS: ReadonlySet<unknown> = new Set(["select", "confirm", "input", "editor"]);
const DEFAULT_HELLO_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_GRACE_MS = 5_000;
// A bridge that drops while Pi is still running is a loss; a Pi that exits on its own is reported first.
const BRIDGE_LOST_GRACE_MS = 250;

type Timer = ReturnType<typeof setTimeout>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sameTokenBytes(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameTools(received: readonly string[], allowed: readonly string[]): boolean {
  const left = [...received].sort();
  const right = [...allowed].sort();
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

function assistantText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) => asRecord(part))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part?.text as string);
  return parts.length > 0 ? parts.join("") : undefined;
}

function validate(spec: AgentSpec, options: PiAgentRuntimeOptions): HarilError | undefined {
  const invalid = (message: string): HarilError => ({ code: "agent.invalid_spec", message });
  if (!RUN_ID.test(spec.runId)) return invalid("runId must be 1-64 characters of [A-Za-z0-9_-]");
  for (const [name, value] of [
    ["nodePath", options.nodePath],
    ["piCliPath", options.piCliPath],
    ["bridgePath", options.bridgePath],
    ["projectRoot", options.projectRoot],
    ["runsDir", options.runsDir],
  ] as const) {
    if (!isAbsolutePath(value)) return invalid(`${name} must be an absolute path`);
  }
  if (options.model.length === 0 || options.virtualKey.length === 0) {
    return invalid("model and virtualKey must be non-empty");
  }
  if (!spec.allowedTools.every((tool) => tool.length > 0 && !tool.includes(","))) {
    return invalid("allowedTools must be non-empty names without commas");
  }
  if (spec.delegation !== undefined) {
    const unsafe = spec.allowedTools.find((tool) => !WORKFLOW_TOOLS.has(tool));
    if (unsafe !== undefined) {
      return invalid(
        `a workflow agent is read-only until writing arrives: ${unsafe} is not one of read and the delegation tools`,
      );
    }
  }
  if (!(spec.timeoutMs > 0) || !Number.isFinite(spec.timeoutMs)) {
    return invalid("timeoutMs must be a positive number");
  }
  if (options.modelContextWindow !== undefined && !isPositiveInteger(options.modelContextWindow)) {
    return invalid("modelContextWindow must be a positive integer");
  }
  if (options.modelMaxTokens !== undefined && !isPositiveInteger(options.modelMaxTokens)) {
    return invalid("modelMaxTokens must be a positive integer");
  }
  return undefined;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

// What the agent reads after an accepted proposal (LD-T4): the approval it became, which a person decides.
function proposalText(approvalId: string, created: boolean): string {
  return created
    ? `proposed plan ${approvalId}; it waits for a person (haril approve ${approvalId})`
    : `plan ${approvalId} was already proposed; it waits for a person (haril approve ${approvalId})`;
}

// What the agent reads after an accepted delegation call: the host's typed reply, its fields as JSON, then the rule that
// a turn decides once.
function delegationText(result: Extract<DelegationToolResult, { ok: true }>): string {
  const { ok: _ok, ...fields } = result;
  return `accepted: ${JSON.stringify(fields)}. This call decides your turn: end it now with a short final message.`;
}

// The longest refusal reason a plan.propose record keeps, in code points (LD-T7c).
const MAX_REFUSAL_REASON_CHARS = 500;

// A refusal reason as the record keeps it: whole, or cut to MAX_REFUSAL_REASON_CHARS code points ending with "…".
function cappedReason(reason: string): string {
  const chars = [...reason];
  if (chars.length <= MAX_REFUSAL_REASON_CHARS) return reason;
  return `${chars.slice(0, MAX_REFUSAL_REASON_CHARS - 1).join("")}…`;
}

// Pi 1.2.0 reads a leading "/" as one of its own commands, so a task that starts with it goes behind a fixed prefix.
function promptMessage(text: string): string {
  return text.startsWith("/") ? `Task: ${text}` : text;
}

function isAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"))
  );
}

export function createPiAgentRuntime(options: PiAgentRuntimeOptions): AgentRuntime {
  const spawnFn = options.spawn ?? defaultSpawn;
  return {
    async start(spec: AgentSpec): Promise<Result<AgentHandle, HarilError>> {
      const invalid = validate(spec, options);
      if (invalid !== undefined) return { ok: false, error: invalid };
      const run = new PiRun(spec, options, spawnFn);
      try {
        await run.init();
      } catch (error) {
        await run.abandon();
        const reason = error instanceof Error ? error.message : "unknown error";
        return { ok: false, error: { code: "agent.spawn_failed", message: reason } };
      }
      return { ok: true, value: run };
    },
  };
}

class PiRun implements PiAgentHandle {
  readonly runId: string;
  readonly hello: Promise<AgentHello>;
  readonly settled: Promise<AgentOutcome>;

  private readonly spec: AgentSpec;
  private readonly options: PiAgentRuntimeOptions;
  private readonly spawnFn: SpawnFn;
  private readonly helloTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly graceMs: number;
  private readonly guard: PathGuard;
  private readonly runDir: string;
  private readonly token = randomBytes(32).toString("hex");
  private readonly pipeName: string;
  private readonly helloD = deferred<AgentHello>();
  private readonly readyD = deferred<void>();
  private readonly settledD = deferred<AgentOutcome>();
  private readonly exitedD = deferred<void>();
  private readonly pending = new Map<
    string,
    { command: string; resolve(reply: Json | undefined): void }
  >();
  private readonly warnings: string[] = [];
  private readonly osEnv: NodeJS.ProcessEnv = process.env;

  private server: Server | undefined;
  private bridgeSocket: Socket | undefined;
  private child: ChildProcess | undefined;
  private spawnedAt: number | undefined;
  private spawnBoot: BootStart | undefined;
  private stderrLog: WriteStream | undefined;
  private stdoutReader: JsonlReader | undefined;
  private stdinOpen = false;
  private childClosed = false;
  private killedByUs = false;
  private finished = false;
  private failure: HarilError | undefined;
  private stopRequest: "abort" | "timeout" | undefined;
  private helloDone = false;
  private promptStarted = false;
  private settledSeen = false;
  private finalText: string | undefined;
  // The last assistant message_end before agent_settled decides the run; an earlier one may be a retried error.
  private lastAssistant:
    | { stopReason: string | undefined; errorMessage: string | undefined }
    | undefined;
  private streamedText = "";
  private ignoredEvents = 0;
  private seq = 0;
  private helloTimer: Timer | undefined;
  private startupTimer: Timer | undefined;
  private deadlineTimer: Timer | undefined;
  private graceTimer: Timer | undefined;
  private bridgeLostTimer: Timer | undefined;

  constructor(spec: AgentSpec, options: PiAgentRuntimeOptions, spawnFn: SpawnFn) {
    this.spec = spec;
    this.runId = spec.runId;
    this.options = options;
    this.spawnFn = spawnFn;
    this.helloTimeoutMs = options.timings?.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.startupTimeoutMs = options.timings?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.graceMs = options.timings?.graceMs ?? DEFAULT_GRACE_MS;
    this.guard = options.pathGuard ?? createPathGuard(options.projectRoot);
    this.runDir = join(options.runsDir, spec.runId);
    const suffix = randomBytes(8).toString("hex");
    this.pipeName =
      process.platform === "win32"
        ? `\\\\.\\pipe\\haril-${spec.runId}-${suffix}`
        : join(this.runDir, "bridge.sock");
    this.hello = this.helloD.promise;
    this.settled = this.settledD.promise;
    // Rejections are read by prompt() and by settled; this stops an early rejection from being unhandled.
    this.hello.catch(() => {});
    this.readyD.promise.catch(() => {});
  }

  get diagnostics(): PiDiagnostics {
    return { ignoredEvents: this.ignoredEvents, warnings: [...this.warnings] };
  }

  async init(): Promise<void> {
    mkdirSync(join(this.runDir, "agent"), { recursive: true });
    mkdirSync(join(this.runDir, "pi"), { recursive: true });
    this.stderrLog = createWriteStream(join(this.runDir, "pi", "stderr.log"), { flags: "a" });
    this.stderrLog.on("error", () => {});

    const server = createServer((socket) => this.onBridgeConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.pipeName, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const bridge = `${this.pipeName}#${this.token}`;
    const env = buildPiEnv({
      nodePath: this.options.nodePath,
      agentDir: join(this.runDir, "agent"),
      runId: this.runId,
      bridge,
      tools: this.spec.allowedTools,
      brokerUrl: this.options.brokerUrl,
      model: this.options.model,
      modelContextWindow: this.options.modelContextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
      modelMaxTokens: this.options.modelMaxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
      virtualKey: this.options.virtualKey,
      osEnv: this.osEnv,
    });
    const argv = buildPiArgv({
      piCliPath: this.options.piCliPath,
      bridgePath: this.options.bridgePath,
      sessionDir: join(this.runDir, "pi"),
      model: this.options.model,
    });
    const child = this.spawnFn(this.options.nodePath, argv, {
      cwd: this.runDir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    // Read right after the spawn returned: the OS created the process during the call, so its own start time is within
    // milliseconds of this one, which the startup sweep compares before it kills a recorded pid (3.14.5).
    this.spawnedAt = Date.now();
    this.spawnBoot = child.pid === undefined ? undefined : this.bootOf(child.pid);
    this.child = child;
    this.stdinOpen = child.stdin !== null;
    this.wireChild(child);
    this.helloTimer = setTimeout(
      () => this.fail("agent.handshake_timeout", "the bridge did not send hello in time"),
      this.helloTimeoutMs,
    );
  }

  // Start failed after resources were created: release them without a settled outcome to report.
  async abandon(): Promise<void> {
    this.clearTimers();
    this.server?.close();
    this.stderrLog?.end();
    this.finished = true;
    this.settledD.resolve({ status: "aborted" });
    this.exitedD.resolve();
  }

  prompt(text: string): Promise<Result<void, HarilError>> {
    return this.sendPrompt(text);
  }

  async abort(): Promise<void> {
    this.stop("abort");
    await this.exitedD.promise;
  }

  async dispose(): Promise<void> {
    this.stop("abort");
    await this.exitedD.promise;
  }

  // The process serving the run (3.14): its pid and the time taken right after the spawn returned it, with its boot
  // ticks on Linux.
  get process(): AgentProcess | undefined {
    const pid = this.child?.pid;
    if (pid === undefined || this.spawnedAt === undefined) return undefined;
    return {
      pid,
      startedAt: this.spawnedAt,
      ...(this.spawnBoot === undefined ? {} : { boot: this.spawnBoot }),
    };
  }

  // The host's reading of the boot ticks; a failed reading records none.
  private bootOf(pid: number): BootStart | undefined {
    try {
      return this.options.bootStartOf?.(pid);
    } catch {
      return undefined;
    }
  }

  // The emergency stop and the watchdog's close (3.14, 3.16): no abort request and no grace period, the tree is killed
  // now. An unsettled run settles as aborted once Pi is gone.
  async kill(): Promise<void> {
    if (!this.finished && this.stopRequest === undefined) {
      this.stopRequest = "abort";
      clearTimeout(this.deadlineTimer);
    }
    if (this.stdinOpen) {
      this.stdinOpen = false;
      this.child?.stdin?.end();
    }
    clearTimeout(this.graceTimer);
    this.killNow();
    await this.exitedD.promise;
  }

  private async sendPrompt(text: string): Promise<Result<void, HarilError>> {
    if (this.finished) return { ok: false, error: this.closedError() };
    if (this.promptStarted) {
      return {
        ok: false,
        error: { code: "agent.prompt_repeated", message: "a run takes one prompt" },
      };
    }
    this.promptStarted = true;
    try {
      await this.hello;
      await this.readyD.promise;
    } catch {
      return { ok: false, error: this.closedError() };
    }
    if (this.finished) return { ok: false, error: this.closedError() };

    const reply = await this.request("prompt", { message: promptMessage(text) });
    if (reply === undefined) return { ok: false, error: this.closedError() };
    if (reply.success !== true) {
      const message = "Pi did not accept the prompt";
      this.fail("agent.prompt_rejected", message);
      return { ok: false, error: { code: "agent.prompt_rejected", message } };
    }
    // Only "started" opens a run: "handled" and "queued" never send agent_settled (contract 4.3).
    if (asRecord(reply.data)?.disposition !== "started") {
      const message = "Pi did not start a run for the prompt";
      this.fail("agent.prompt_not_run", message);
      return { ok: false, error: { code: "agent.prompt_not_run", message } };
    }
    // The reply and agent_settled can arrive in one chunk: the run may already be finished, and a timer armed
    // now would never be cleared, which keeps the runtime process alive for the whole timeout (M2-T6).
    if (this.finished) return { ok: true, value: undefined };
    this.deadlineTimer = setTimeout(() => this.stop("timeout"), this.spec.timeoutMs);
    return { ok: true, value: undefined };
  }

  private closedError(): HarilError {
    return (
      this.failure ?? { code: "agent.closed", message: "the run closed before it was accepted" }
    );
  }

  private wireChild(child: ChildProcess): void {
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer) => this.stderrLog?.write(chunk));
    this.stdoutReader = new JsonlReader({
      onLine: (line) => this.onStdoutLine(line),
      onOverflow: () => this.fail("protocol_line_too_long", "a Pi stdout line exceeded 8 MiB"),
    });
    child.stdout?.on("data", (chunk: Buffer) => this.stdoutReader?.push(chunk));
    child.stdout?.on("end", () => this.stdoutReader?.end());
    child.on("error", (error) => {
      this.fail("agent.spawn_failed", `Pi could not be started: ${error.message}`);
      if (child.pid === undefined) this.onClose(null, null);
    });
    child.on("close", (code, signal) => this.onClose(code, signal));
  }

  private onBridgeConnection(socket: Socket): void {
    if (this.bridgeSocket !== undefined || this.finished) {
      socket.destroy();
      return;
    }
    this.bridgeSocket = socket;
    socket.on("error", () => {});
    const reader = new JsonlReader({
      onLine: (line) => this.onBridgeLine(line),
      onOverflow: () => this.fail("protocol_line_too_long", "a bridge line exceeded 8 MiB"),
    });
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("end", () => reader.end());
    socket.on("close", () => {
      this.bridgeSocket = undefined;
      if (this.finished || this.stopRequest !== undefined) return;
      this.bridgeLostTimer = setTimeout(() => {
        if (!this.childClosed) {
          this.fail("agent.bridge_lost", "the bridge channel closed before the run settled");
        }
      }, BRIDGE_LOST_GRACE_MS);
    });
  }

  private onBridgeLine(line: string): void {
    if (line.trim() === "" || this.finished) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail("agent.bridge_protocol_error", "a bridge message is not JSON");
      return;
    }
    const message = asRecord(parsed);
    if (message === undefined) {
      this.fail("agent.bridge_protocol_error", "a bridge message is not an object");
      return;
    }
    if (!this.helloDone) {
      this.onHello(message);
      return;
    }
    if (message.op !== undefined) void this.onBridgeOperation(message);
  }

  private onHello(message: Json): void {
    const reject = (reason: string): void => {
      this.fail("agent.handshake_mismatch", `hello rejected: ${reason}`);
    };
    if (message.type !== "hello") {
      reject("first message is not hello");
      return;
    }
    if (!sameTokenBytes(message.token, this.token)) {
      reject("wrong token");
      return;
    }
    if (message.runId !== this.runId) {
      reject("wrong runId");
      return;
    }
    if (typeof message.bridgeVersion !== "string") {
      reject("missing bridgeVersion");
      return;
    }
    const tools = Array.isArray(message.tools) ? message.tools : undefined;
    if (tools === undefined || !tools.every((tool) => typeof tool === "string")) {
      reject("tools is not a list of names");
      return;
    }
    if (!sameTools(tools as string[], this.spec.allowedTools)) {
      reject("tools differ from allowedTools");
      return;
    }

    this.helloDone = true;
    clearTimeout(this.helloTimer);
    this.helloD.resolve({ tools: [...(tools as string[])] });
    this.startupTimer = setTimeout(
      () => this.fail("agent.startup_timeout", "Pi did not answer get_state in time"),
      this.startupTimeoutMs,
    );
    void this.runStartup();
  }

  private async runStartup(): Promise<void> {
    const reply = await this.request("get_state", {});
    if (this.finished || reply === undefined) return;
    if (reply.success !== true) return this.fail("agent.startup_failed", "get_state failed");
    const model = asRecord(reply.data)?.model;
    const activeModel = typeof model === "string" ? model : asRecord(model)?.id;
    if (activeModel !== this.options.model) {
      return this.fail("agent.model_mismatch", "Pi reports a different active model");
    }
    clearTimeout(this.startupTimer);
    this.readyD.resolve();
  }

  private async onBridgeOperation(message: Json): Promise<void> {
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    if (message.op === PLAN_PROPOSE_OP) {
      this.onProposePlan(id, message.plan);
      return;
    }
    if (message.op === DELEGATION_CALL_OP) {
      await this.onDelegationCall(id, message.tool, message.input);
      return;
    }
    if (message.op !== "read") {
      this.recordOperation(String(message.op), sha256(""), "unsupported");
      this.replyBridge(id, { ok: false, error: "unsupported" });
      return;
    }
    const requested = typeof message.path === "string" ? message.path : "";
    const pathSha256 = sha256(requested);
    const check = this.guard(requested);
    if (!check.ok) {
      this.recordOperation("read", pathSha256, "path_denied", { reason: check.reason });
      this.replyBridge(id, { ok: false, error: "path_denied" });
      return;
    }
    const read = await readGuardedFile(check.absolutePath, { maxBytes: MAX_READ_BYTES });
    if (read.ok) {
      this.recordOperation("read", pathSha256, "ok");
      this.replyBridge(id, { ok: true, content: read.content.toString("utf8") });
      return;
    }
    // A link or a swapped file found after the guard is a denial too: the path is refused, never read.
    if (read.reason === "link" || read.reason === "identity_changed") {
      this.recordOperation("read", pathSha256, "path_denied", { reason: read.reason });
      this.replyBridge(id, { ok: false, error: "path_denied" });
      return;
    }
    if (read.reason === "too_large") {
      this.recordOperation("read", pathSha256, "too_large");
      this.replyBridge(id, { ok: false, error: "too_large" });
      return;
    }
    this.recordOperation("read", pathSha256, "read_failed");
    this.replyBridge(id, { ok: false, error: "read_failed" });
  }

  // haril_propose_plan (LD-T4): the plan goes to the host's proposer untouched, with the run's own context; the host
  // checks it and the reply carries its reason, so the agent can fix the plan. Only a run allowed the tool reaches the
  // proposer; without one, the operation is unsupported like any other the adapter does not serve.
  private onProposePlan(id: string | number, plan: unknown): void {
    const body = JSON.stringify(plan) ?? "";
    const fingerprint = { planSha256: sha256(body), planBytes: Buffer.byteLength(body, "utf8") };
    const proposer = this.options.proposePlan;
    if (proposer === undefined || !this.spec.allowedTools.includes(PROPOSE_PLAN_TOOL)) {
      this.recordOperation(PLAN_PROPOSE_OP, sha256(""), "unsupported", fingerprint);
      this.replyBridge(id, { ok: false, error: "unsupported" });
      return;
    }
    const projectId = this.spec.projectId;
    let result: PlanProposalResult;
    if (projectId === undefined) {
      result = { ok: false, reason: "the run has no project" };
    } else {
      try {
        result = proposer({ projectId, taskId: this.spec.taskId, runId: this.runId }, plan);
      } catch {
        // The host failed, not the plan: the agent hears a fixed reason, never the host's error.
        result = { ok: false, reason: "the plan could not be recorded" };
      }
    }
    if (!result.ok) {
      this.recordOperation(PLAN_PROPOSE_OP, sha256(""), "plan_refused", {
        ...fingerprint,
        reason: cappedReason(result.reason),
      });
      this.replyBridge(id, { ok: false, error: result.reason });
      return;
    }
    this.recordOperation(PLAN_PROPOSE_OP, sha256(""), "ok", {
      ...fingerprint,
      approvalId: result.approvalId,
    });
    this.replyBridge(id, { ok: true, content: proposalText(result.approvalId, result.created) });
  }

  // A delegation tool (phase F2b): the call goes to the host's handler untouched, with the run's own context, only for a
  // tool this run was offered; the handler checks it and its typed reply goes back, a refusal with its reason, so the
  // agent can fix the call in the same turn. A host failure is a fixed reason, never the host's error. A workspace tool
  // (phase F8) is answered once the host finished it.
  private async onDelegationCall(
    id: string | number,
    tool: unknown,
    input: unknown,
  ): Promise<void> {
    const name = typeof tool === "string" ? tool : "";
    const body = JSON.stringify(input) ?? "";
    const fingerprint = {
      tool: name,
      inputSha256: sha256(body),
      inputBytes: Buffer.byteLength(body, "utf8"),
    };
    const handler = this.options.delegationTools;
    const projectId = this.spec.projectId;
    if (
      handler === undefined ||
      projectId === undefined ||
      !DELEGATION_TOOLS.has(name) ||
      !this.spec.allowedTools.includes(name)
    ) {
      this.recordOperation(DELEGATION_CALL_OP, sha256(""), "unsupported", fingerprint);
      this.replyBridge(id, { ok: false, error: "unsupported" });
      return;
    }
    let result: DelegationToolResult;
    try {
      result = await handler(
        { projectId, taskId: this.spec.taskId, runId: this.runId },
        name,
        input,
      );
    } catch {
      result = { ok: false, reason: "the call could not be recorded" };
    }
    if (!result.ok) {
      this.recordOperation(DELEGATION_CALL_OP, sha256(""), "delegation_refused", {
        ...fingerprint,
        reason: cappedReason(result.reason),
      });
      this.replyBridge(id, { ok: false, error: result.reason, reply: result });
      return;
    }
    this.recordOperation(DELEGATION_CALL_OP, sha256(""), "ok", fingerprint);
    this.replyBridge(id, { ok: true, content: delegationText(result), reply: result });
  }

  private recordOperation(
    op: string,
    pathSha256: string,
    outcome: BridgeOperationOutcome,
    detail: OperationDetail = {},
  ): void {
    try {
      this.options.onBridgeOperation?.({ runId: this.runId, op, pathSha256, outcome, ...detail });
    } catch {
      // A failing observer must not change the operation's answer.
    }
  }

  private replyBridge(id: string | number, reply: Json): void {
    const socket = this.bridgeSocket;
    if (socket === undefined || socket.destroyed || this.finished) return;
    socket.write(`${JSON.stringify({ id, ...reply })}\n`);
  }

  private onStdoutLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.ignoredEvents++;
      return;
    }
    const message = asRecord(parsed);
    if (message === undefined) {
      this.ignoredEvents++;
      return;
    }
    switch (message.type) {
      case "response":
        this.onResponse(message);
        return;
      case "extension_ui_request":
        if (
          DIALOG_METHODS.has(message.method) &&
          (typeof message.id === "string" || typeof message.id === "number")
        ) {
          this.writeLine({ type: "extension_ui_response", id: message.id, cancelled: true });
        }
        return;
      case "agent_settled":
        this.onSettled(message.aborted === true);
        return;
      case "message_update": {
        const event = asRecord(message.assistantMessageEvent);
        if (event?.type === "text_delta" && typeof event.delta === "string") {
          this.streamedText += event.delta;
        }
        return;
      }
      case "message_end": {
        const assistant = asRecord(message.message);
        if (assistant?.role === "assistant") {
          this.lastAssistant = {
            stopReason: typeof assistant.stopReason === "string" ? assistant.stopReason : undefined,
            errorMessage:
              typeof assistant.errorMessage === "string" ? assistant.errorMessage : undefined,
          };
          const text = assistantText(assistant.content);
          if (text !== undefined) this.finalText = text;
        }
        return;
      }
      case "agent_start":
      case "turn_end":
        return;
      default:
        this.ignoredEvents++;
    }
  }

  private onResponse(message: Json): void {
    const id = typeof message.id === "string" ? message.id : undefined;
    let entry = id === undefined ? undefined : this.pending.get(id);
    if (entry === undefined) {
      for (const [key, candidate] of this.pending) {
        if (candidate.command === message.command) {
          entry = candidate;
          this.pending.delete(key);
          break;
        }
      }
    } else if (id !== undefined) {
      this.pending.delete(id);
    }
    if (entry === undefined) {
      this.ignoredEvents++;
      return;
    }
    entry.resolve(message);
  }

  private request(command: string, payload: Json): Promise<Json | undefined> {
    const id = `r${++this.seq}`;
    const reply = deferred<Json | undefined>();
    if (this.finished || !this.writeLine({ type: command, id, ...payload })) {
      reply.resolve(undefined);
      return reply.promise;
    }
    this.pending.set(id, { command, resolve: reply.resolve });
    return reply.promise;
  }

  private writeLine(message: Json): boolean {
    const stdin = this.child?.stdin;
    if (!this.stdinOpen || stdin === undefined || stdin === null || stdin.destroyed) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private onSettled(aborted: boolean): void {
    if (this.finished) return;
    this.settledSeen = true;
    let outcome: AgentOutcome;
    if (this.stopRequest === "timeout") {
      outcome = { status: "timed_out" };
    } else if (this.stopRequest === "abort") {
      outcome = { status: "aborted" };
    } else if (aborted) {
      outcome = { status: "failed", code: "aborted", message: "Pi settled with aborted=true" };
    } else {
      outcome = this.judgeLastAssistant();
    }
    this.finish(outcome);
    this.beginGracefulShutdown();
  }

  // Pi retries a failed model call up to 3 times, so only the last assistant message decides: stop, toolUse and
  // length succeed, error fails with the provider's cause (a Broker refusal, for example), aborted fails as aborted.
  private judgeLastAssistant(): AgentOutcome {
    const last = this.lastAssistant;
    if (last?.stopReason === "aborted") {
      return { status: "failed", code: "aborted", message: "Pi ended the reply as aborted" };
    }
    if (last?.stopReason === "error") {
      const message = last.errorMessage ?? "Pi reported a failed model call";
      return {
        status: "failed",
        code: message.includes("insufficient_quota") ? "insufficient_quota" : "provider_error",
        message,
      };
    }
    return { status: "succeeded", summary: this.finalText ?? this.streamedText };
  }

  private stop(reason: "abort" | "timeout"): void {
    if (this.childClosed) return;
    if (!this.finished && this.stopRequest === undefined) {
      this.stopRequest = reason;
      clearTimeout(this.deadlineTimer);
      this.writeLine({ type: "abort" });
    }
    this.beginGracefulShutdown();
  }

  // EOF on stdin, then a tree kill after the grace period (ADR-0004 decision 8).
  private beginGracefulShutdown(): void {
    if (this.stdinOpen) {
      this.stdinOpen = false;
      this.child?.stdin?.end();
    }
    if (this.graceTimer === undefined && !this.childClosed) {
      this.graceTimer = setTimeout(() => this.killNow(), this.graceMs);
    }
  }

  // Every kill of the run (the emergency stop, the watchdog's close, the end of the grace period, a failure) goes through
  // the host's verified tree kill when it has one. taskkill /T walks the tree by parent pid alone, and Windows keeps a dead
  // parent's pid in its children's ParentProcessId, so a stranger under a reused pid could be taken along; that path stays
  // only as the fallback for a process table that cannot be read. The child's own handle is killed at the end either way:
  // it names this process and no other.
  private killNow(): void {
    if (this.childClosed || this.child === undefined) return;
    this.killedByUs = true;
    const child = this.child;
    const target = this.process;
    const verified = this.options.killTree;
    if (verified === undefined || target === undefined) {
      killProcessTree(child, this.osEnv);
      return;
    }
    const finish = (result: "killed" | "gone" | "unreadable"): void => {
      if (this.childClosed) return;
      if (result === "unreadable") killProcessTree(child, this.osEnv);
      else child.kill("SIGKILL");
    };
    verified(target).then(finish, () => finish("unreadable"));
  }

  private fail(code: string, message: string): void {
    if (this.finished) return;
    this.failure = { code, message };
    this.finish({ status: "failed", code, message });
    this.killNow();
  }

  private finish(outcome: AgentOutcome): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.bridgeLostTimer);
    const error = this.closedError();
    this.helloD.reject(error);
    this.readyD.reject(error);
    this.settledD.resolve(outcome);
    this.flushPending();
  }

  private flushPending(): void {
    for (const entry of this.pending.values()) entry.resolve(undefined);
    this.pending.clear();
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.childClosed) return;
    this.childClosed = true;
    this.clearTimers();
    if (!this.finished) {
      if (this.stopRequest === "abort") {
        this.finish({ status: "aborted" });
      } else if (this.stopRequest === "timeout") {
        this.finish({ status: "timed_out" });
      } else {
        this.finish({
          status: "failed",
          code: "pi_exited",
          message: `Pi exited before agent_settled (code ${code ?? "none"}, signal ${signal ?? "none"})`,
        });
      }
    } else if (this.settledSeen && code !== null && code !== 0 && !this.killedByUs) {
      this.warnings.push(
        `Pi exited with code ${code} after agent_settled (#9507); the run is accepted`,
      );
    }
    this.flushPending();
    this.server?.close();
    this.bridgeSocket?.destroy();
    if (this.stderrLog === undefined) {
      this.exitedD.resolve();
      return;
    }
    this.stderrLog.end(() => this.exitedD.resolve());
  }

  private clearTimers(): void {
    clearTimeout(this.helloTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.graceTimer);
    clearTimeout(this.bridgeLostTimer);
  }
}
