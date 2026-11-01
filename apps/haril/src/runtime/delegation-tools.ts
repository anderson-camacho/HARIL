import { createHash } from "node:crypto";
import {
  type AbortInput,
  type AssignInput,
  type DelegateInput,
  type HumanRequest,
  isDelegationToolName,
  type ReportInput,
  type RequestAuditInput,
  type VerdictInput,
  validateDelegationToolInput,
  validateWorkspaceFileInput,
} from "@haril/contracts";
import {
  COUNCIL_MIN_OPINIONS,
  canonicalJson,
  checkDelegation,
  checkVerdict,
  classifyGitCommand,
  type DelegationCaller,
  type DelegationCheck,
  type DelegationState,
  isDelegationArchetype,
  isValidOpinion,
  isWorkspaceTool,
  mayRoleUseTool,
  mayUseTool,
  proposalFromAssign,
  proposalFromDelegate,
  roleWriteProblem,
} from "@haril/core";
import type { Clock, DelegationToolHandler, DelegationToolResult, Store } from "@haril/core/ports";
import { changedPaths, headBranch, headCommit } from "@haril/git";
import { raiseHumanRequest } from "./human-requests.js";
import { createIntegration, type Integration, unmergedSteps } from "./integration.js";
import { readWebPage, type WebFetch } from "./web-read.js";
import { projectTestCommand } from "./workflow-evidence.js";
import {
  type DelegationOptions,
  type WorkflowSettings,
  WorkflowView,
  workflowSettings,
} from "./workflow-view.js";
import { type TurnWorkspace, type Workspaces, type WriteScope, worktreeGit } from "./worktrees.js";

// The host side of the delegation tools (docs/modos-y-delegacion.md 3.4, 3.5, 3.6): one handler serves every agent
// runtime, the FakeAgentRuntime option now and Pi's bridge tools in phase F2b, as plan-proposals.ts does for
// haril_propose_plan. A call is accepted only from a workflow turn the run loop opened, for itself. The handler checks
// the tool against the turn's archetype, the input against the tool contracts, and a proposal against checkDelegation
// with the workflow's limits; it answers { ok: true, ... } or { ok: false, reason }, and with a reason the agent corrects
// its call in the same turn. A turn makes one call that decides it (a proposal, a report, a verdict, an audit request or
// an abort): the same call again is the same answer, any other is refused. Nothing is created here. The accepted call
// waits in the turn's window until the turn ends, and the run loop applies it in the transaction that closes the turn
// (workflow-turns.ts), so a crash in between leaves nothing behind and the rerun makes the call again.
//
// Phase F8: a turn of a workflow that writes runs in a git worktree, which the run loop attaches to its window. Its
// workspace tools (write, edit, haril_run, haril_merge and its continue and abort) are not deciding calls: the host does
// them inside that worktree, as many times as the turn asks, and answers once each is done (a promise). An executor
// writes only inside its write surface; a delegator writes only the conflicting files of the merge it left waiting.
// A delegator's haril_report with status done is refused while an approved step's work is not merged.

export type TurnAction =
  | { readonly tool: "haril_delegate"; readonly input: DelegateInput }
  | { readonly tool: "haril_assign"; readonly input: AssignInput }
  | { readonly tool: "haril_report"; readonly input: ReportInput }
  | { readonly tool: "haril_verdict"; readonly input: VerdictInput }
  | { readonly tool: "haril_request_audit"; readonly input: RequestAuditInput }
  | { readonly tool: "haril_abort"; readonly input: AbortInput };

export interface TurnWindowReport {
  readonly action: TurnAction | null;
  // Every refusal the turn heard, in order, so a failed turn can say why.
  readonly refusals: readonly string[];
}

interface TurnAttempt {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workflowId: string;
}

export interface DelegationTools {
  readonly call: DelegationToolHandler;
  // Opens the window of one workflow turn; the returned function closes it and reports its decided call.
  open(attempt: TurnAttempt): () => TurnWindowReport;
  // Gives an open window its git worktree once the run loop made it (phase F8), with the epoch of the runtime and the
  // turn's end: when it aborts, the commands the turn runs are killed.
  attach(runId: string, workspace: TurnWorkspace | null, epoch: number, ended?: AbortSignal): void;
  // The delegators' merges (phase F8): the run loop forgets a merge whose turn ended, and the prompt names one waiting.
  readonly integration: Integration;
  // What the host refused this run so far, for the vigilante.
  refusalsOf?(runId: string): readonly string[];
}

interface Window {
  readonly attempt: TurnAttempt;
  action: TurnAction | null;
  readonly refusals: string[];
  // The turn's git worktree and the runtime epoch its writes are fenced by (phase F8); null for a read-only turn.
  workspace: TurnWorkspace | null;
  epoch: number;
  // The turn's end (phase F8): the commands it runs end with it.
  ended: AbortSignal | undefined;
}

export interface DelegationToolsDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly options?: DelegationOptions;
  // The worktrees of workflows that write (phase F8). Without them every workspace tool is refused.
  readonly workspaces?: Workspaces;
  // haril_web's fetch; default the platform's. Tests never reach the network.
  readonly webFetch?: WebFetch;
}

// The state checkDelegation reads for a calling thread (3.6).
export function delegationState(
  view: WorkflowView,
  threadId: string,
  settings: WorkflowSettings,
  now: number,
): DelegationState {
  const { workflow } = view;
  return {
    workflow: {
      state: workflow.state,
      agentsCreated: workflow.agentsCreated,
      tokensCommitted: view.tokensCommitted(),
      autonomy: { mode: workflow.autonomy.mode, stops: workflow.autonomy.stops },
    },
    thread: {
      queuedChildren: view.childThreads(threadId).filter((child) => view.unsettled(child)).length,
      proposals: view.proposalCount(threadId),
    },
    models: settings.models(now),
  };
}

function issuesText(check: Extract<DelegationCheck, { ok: false }>): string {
  return check.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
}

// The assignments of a delegator's call that name one of its existing steps: allowed once for an escalated step (the
// reformulation of 3.8) and for a blocked step (one that never ran because a step it depends on failed or escalated).
export function reassignmentProblem(
  view: WorkflowView,
  threadId: string,
  input: AssignInput,
  settings: WorkflowSettings,
): string | null {
  const steps = new Map(
    view
      .childThreads(threadId)
      .map((child) => [view.turns(child)[0]?.localId ?? "", child] as const),
  );
  for (const assignment of input.assignments) {
    const existing = steps.get(assignment.localId);
    if (existing === undefined) continue;
    if (view.reassigned(existing)) {
      return `step "${assignment.localId}" was already reassigned once; it cannot be reassigned again`;
    }
    const phase = view.rework(existing, settings.limits).phase;
    const blocked = view.latest(existing)?.state === "blocked";
    if (phase !== "awaiting_reformulation" && !blocked) {
      return `step "${assignment.localId}" already exists and is not escalated or blocked; give new work a new localId`;
    }
  }
  return null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createDelegationTools(deps: DelegationToolsDeps): DelegationTools {
  const { store, clock } = deps;
  const windows = new Map<string, Window>();
  const integration = createIntegration();

  const refuse = (window: Window | undefined, reason: string): DelegationToolResult => {
    window?.refusals.push(reason);
    return { ok: false, reason };
  };

  const check = (window: Window, tool: string, raw: unknown): DelegationToolResult => {
    const view = WorkflowView.load(store, window.attempt.workflowId);
    const task = view?.task(window.attempt.taskId);
    if (view === undefined || task === undefined || !isDelegationArchetype(task.role)) {
      return refuse(window, `run ${window.attempt.runId} is not a turn of a workflow`);
    }
    if (!isDelegationToolName(tool)) return refuse(window, `unknown tool "${tool}"`);
    if (!mayUseTool(task.role, tool, { writes: false })) {
      return refuse(window, `${tool} is not a tool of the ${task.role}`);
    }
    const valid = validateDelegationToolInput(tool, raw);
    if (!valid.ok) return refuse(window, `${tool} input: ${valid.errors.join("; ")}`);
    const action = { tool, input: valid.input } as TurnAction;
    if (window.action !== null) {
      if (
        window.action.tool === tool &&
        canonicalJson(window.action.input) === canonicalJson(raw)
      ) {
        return { ok: true, replay: true };
      }
      return refuse(
        window,
        `this turn already called ${window.action.tool}; end the turn (its result reaches your parent or your continuation)`,
      );
    }
    if (view.workflow.state !== "running") {
      return refuse(window, `the workflow is ${view.workflow.state}; it takes no call`);
    }
    const settings = workflowSettings(view.workflow, deps.options);
    const now = clock.now();
    const caller: DelegationCaller = {
      threadId: task.threadId,
      archetype: task.role,
      depth: task.layer,
    };
    let reply: DelegationToolResult;
    switch (action.tool) {
      case "haril_delegate": {
        const result = checkDelegation(
          proposalFromDelegate(caller, action.input),
          delegationState(view, task.threadId, settings, now),
          settings.limits,
        );
        if (!result.ok) return refuse(window, issuesText(result));
        reply = {
          ok: true,
          delegations: action.input.delegations.length,
          agentsToCreate: result.agentsToCreate,
          note: "applied when your turn ends; you run again with the delegators' reports",
        };
        break;
      }
      case "haril_assign": {
        const result = checkDelegation(
          proposalFromAssign(caller, action.input),
          delegationState(view, task.threadId, settings, now),
          settings.limits,
        );
        if (!result.ok) return refuse(window, issuesText(result));
        const problem = reassignmentProblem(view, task.threadId, action.input, settings);
        if (problem !== null) return refuse(window, problem);
        reply = {
          ok: true,
          assignments: action.input.assignments.length,
          agentsToCreate: result.agentsToCreate,
          note: "applied when your turn ends; you run again with the executors' outcomes",
        };
        break;
      }
      case "haril_report": {
        if (action.input.status === "done") {
          const council = view.councillors(task.threadId);
          const valid = council.filter((row) => isValidOpinion(row.text)).length;
          if (council.length > 0 && valid < COUNCIL_MIN_OPINIONS) {
            return refuse(
              window,
              `a discussion needs at least ${COUNCIL_MIN_OPINIONS} valid opinions and yours has ${valid}: add councillors, or report partial or failed`,
            );
          }
        }
        // 3.10.3: a part that writes is done once its approved work is in the integration branch.
        if (action.input.status === "done" && window.workspace?.kind === "integration") {
          const unmerged = unmergedSteps(store, view, task.threadId, settings.limits);
          if (unmerged.length > 0) {
            return refuse(
              window,
              `merge your approved steps before reporting done: haril_merge {"localId": "..."} for ${unmerged.join(", ")}`,
            );
          }
        }
        reply = { ok: true };
        break;
      }
      case "haril_verdict": {
        const verdict = checkVerdict(action.input);
        if (!verdict.ok) return refuse(window, `${verdict.code}: ${verdict.reason}`);
        reply = { ok: true, approved: action.input.approved };
        break;
      }
      case "haril_request_audit": {
        const pending = view
          .childThreads(task.threadId)
          .filter((child) => view.unsettled(child)).length;
        if (pending > 0) {
          return refuse(
            window,
            `${pending} delegators are still working; request the audit once nothing is pending`,
          );
        }
        if (view.workflow.agentsCreated + 1 > settings.limits.maxAgentsPerWorkflow) {
          return refuse(
            window,
            `workflow_agent_cap: the workflow created ${view.workflow.agentsCreated} agents; the final auditor would pass the limit of ${settings.limits.maxAgentsPerWorkflow}`,
          );
        }
        reply = { ok: true, note: "the final auditor starts when your turn ends" };
        break;
      }
      default:
        reply = { ok: true };
    }
    window.action = action;
    return reply;
  };

  // The git role's tool: the Core gives the action its level. What only reads or changes the worktree runs now; what
  // publishes or destroys becomes a request to a person and runs only if granted; what merges to main never runs.
  const gitCall = async (
    window: Window,
    view: WorkflowView,
    task: WorkflowView["tasks"][number],
    workspace: TurnWorkspace,
    workspaces: Workspaces,
    raw: unknown,
  ): Promise<DelegationToolResult> => {
    const valid = validateDelegationToolInput("haril_git", raw);
    if (!valid.ok) return refuse(window, `haril_git input: ${valid.errors.join("; ")}`);
    const { command, args, why } = valid.input;
    const git = worktreeGit(workspaces.settings.git ?? {}, workspace);
    const current = command === "git" ? ((await headBranch(workspace.root, git)) ?? null) : null;
    const decision = classifyGitCommand(command, args, current);
    const text = [command, ...args].join(" ");
    if (decision.level === "forbidden") return refuse(window, `${text}: ${decision.why}`);
    if (decision.level === "publish" || decision.level === "destructive") {
      const parent = view.parentThreadId(task.threadId);
      const request: HumanRequest = {
        schemaVersion: 1,
        reason: decision.level === "publish" ? "git_publish" : "git_destructive",
        who: view.label(task.threadId),
        delegatedBy: parent === null ? "tú" : view.label(parent),
        workflowId: view.workflow.workflowId,
        taskId: task.taskId,
        task: task.goal,
        doing: `Quiere ejecutar ${text}`,
        needs: `Permiso para ejecutar ${text}`,
        why,
        ifRefused:
          decision.level === "publish"
            ? "No se publica nada; el trabajo sigue en su rama."
            : "No se destruye nada; todo queda como está.",
        blocks: [parent === null ? "el flujo" : view.label(parent)],
        action: { program: command, args: [...args] },
        notifyThreadId: parent,
      };
      const raised = raiseHumanRequest(store, window.epoch, {
        projectId: view.workflow.projectId,
        requestedBy: window.attempt.runId,
        request,
      });
      if (!raised.ok) return refuse(window, raised.reason);
      return {
        ok: true,
        pending: true,
        requestId: raised.approvalId,
        note: "not run: a person must grant it. End your turn with what you asked for; your parent hears the answer.",
      };
    }
    const runId = window.attempt.runId;
    const result = await workspaces.runGit(workspace, command, args, {
      ...(window.ended === undefined ? {} : { signal: window.ended }),
      onSpawn: (child) => {
        try {
          store.runs.recordCommand(window.epoch, runId, child);
        } catch {
          // A command left unrecorded only leaves the sweeps blind to it.
        }
      },
      onExit: (child) => {
        try {
          store.runs.markProcessesGone(
            [{ runId, pid: child.pid, startedAt: child.startedAt }],
            clock.now(),
          );
        } catch {
          // Unmarked, the next sweep checks it once more.
        }
      },
    });
    if (!result.ok) return refuse(window, result.reason);
    store.events.append({
      aggregateType: "task",
      aggregateId: task.taskId,
      type: "git.action",
      actorKind: "system",
      actorId: `runtime:${window.epoch}`,
      payload: {
        workflowId: view.workflow.workflowId,
        level: decision.level,
        command: text,
        exitCode: result.exitCode,
        output: `${result.stdout}${result.stderr}`.slice(-2000),
      },
      projectId: view.workflow.projectId,
      taskId: task.taskId,
      runId,
    });
    return result;
  };

  // The investigador's read of a public page. Never a deciding call.
  const webCall = async (window: Window, raw: unknown): Promise<DelegationToolResult> => {
    const view = WorkflowView.load(store, window.attempt.workflowId);
    const task = view?.task(window.attempt.taskId);
    if (view === undefined || task === undefined || !isDelegationArchetype(task.role)) {
      return refuse(window, `run ${window.attempt.runId} is not a turn of a workflow`);
    }
    if (
      !mayRoleUseTool(task.role, view.roleOf(task), "haril_web", {
        writes: window.workspace !== null,
      })
    ) {
      return refuse(window, "haril_web is only for the investigador role");
    }
    const valid = validateDelegationToolInput("haril_web", raw);
    if (!valid.ok) return refuse(window, `haril_web input: ${valid.errors.join("; ")}`);
    const read = await readWebPage(valid.input.url, deps.webFetch ?? fetch);
    return read.ok
      ? { ok: true, text: read.text, truncated: read.truncated }
      : refuse(window, read.reason);
  };

  // A workspace tool (phase F8): checked like any call, then done inside the turn's worktree. Never a deciding call.
  const workspaceCall = async (
    window: Window,
    tool: string,
    raw: unknown,
  ): Promise<DelegationToolResult> => {
    const view = WorkflowView.load(store, window.attempt.workflowId);
    const task = view?.task(window.attempt.taskId);
    if (view === undefined || task === undefined || !isDelegationArchetype(task.role)) {
      return refuse(window, `run ${window.attempt.runId} is not a turn of a workflow`);
    }
    const workspace = window.workspace;
    const roleName = view.roleOf(task);
    if (!mayRoleUseTool(task.role, roleName, tool as never, { writes: workspace !== null })) {
      return refuse(
        window,
        mayRoleUseTool(task.role, roleName, tool as never, { writes: true })
          ? `${tool} works only in a workflow that writes in git worktrees; this workflow is read-only`
          : roleName === null
            ? `${tool} is not a tool of the ${task.role}`
            : `${tool} is not a tool of the ${roleName} role`,
      );
    }
    const workspaces = deps.workspaces;
    if (workspace === null || workspaces === undefined) {
      return refuse(window, `${tool} has no worktree to work in`);
    }
    if (view.workflow.state !== "running") {
      return refuse(window, `the workflow is ${view.workflow.state}; it takes no call`);
    }
    const settings = workflowSettings(view.workflow, deps.options);
    const context = {
      store,
      epoch: window.epoch,
      view,
      task,
      workspace,
      limits: settings.limits,
      workspaces,
    };
    if (tool === "write" || tool === "edit") {
      const valid = validateWorkspaceFileInput(tool, raw);
      if (!valid.ok) return refuse(window, `${tool} input: ${valid.errors.join("; ")}`);
      const forbidden = roleWriteProblem(roleName, valid.input.path);
      if (forbidden !== null) return refuse(window, forbidden);
      let surface: WriteScope = workspace.writeSurface;
      if (task.role === "delegator") {
        const waiting = integration.pending(view.workflow.workflowId);
        if (waiting === null) {
          return refuse(
            window,
            `${tool} only resolves the conflicting files of a merge, and no merge waits for its conflicts`,
          );
        }
        // Exactly the files git reported in conflict, as literal paths.
        surface = { conflicts: waiting.files };
      }
      const reply =
        valid.tool === "write"
          ? await workspaces.write(
              workspace,
              surface,
              valid.input.path,
              (valid.input as { content: string }).content,
            )
          : await workspaces.edit(
              workspace,
              surface,
              valid.input.path,
              (valid.input as { edits: { oldText: string; newText: string }[] }).edits,
            );
      return reply.ok ? reply : refuse(window, reply.reason);
    }
    if (tool === "haril_git") return gitCall(window, view, task, workspace, workspaces, raw);
    const valid = validateDelegationToolInput(tool as "haril_run", raw);
    if (!valid.ok) return refuse(window, `${tool} input: ${valid.errors.join("; ")}`);
    if (tool === "haril_run") {
      const input = valid.input;
      const args = input.args ?? [];
      const runId = window.attempt.runId;
      const testCommand = projectTestCommand(workspace.root, input.command, args);
      const git = worktreeGit(workspaces.settings.git ?? {}, workspace);
      const cleanAuditedCommit =
        testCommand !== null &&
        task.role === "auditor" &&
        task.auditedTaskId !== null &&
        (await headCommit(workspace.root, git)) === workspace.startHead &&
        (await changedPaths(workspace.root, git))?.length === 0;
      // The command's process is recorded with the run, so a stop and the sweeps find it; it ends with the turn.
      const result = await workspaces.run(workspace, input.command, args, {
        ...(window.ended === undefined ? {} : { signal: window.ended }),
        onSpawn: (child) => {
          try {
            store.runs.recordCommand(window.epoch, runId, child);
          } catch {
            // A command left unrecorded only leaves the sweeps blind to it.
          }
        },
        onExit: (child) => {
          try {
            store.runs.markProcessesGone(
              [{ runId, pid: child.pid, startedAt: child.startedAt }],
              clock.now(),
            );
          } catch {
            // Unmarked, the next sweep checks it once more.
          }
        },
      });
      if (!result.ok) return refuse(window, result.reason);
      const projectTest =
        cleanAuditedCommit && (await headCommit(workspace.root, git)) === workspace.startHead;
      store.events.append({
        aggregateType: "task",
        aggregateId: task.taskId,
        type: "workspace.command",
        actorKind: "system",
        actorId: `runtime:${window.epoch}`,
        payload: {
          workflowId: view.workflow.workflowId,
          command: input.command,
          argsSha256: sha256(JSON.stringify(args)),
          projectTest,
          testCommand: projectTest ? testCommand : null,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          truncated: result.truncated,
        },
        projectId: view.workflow.projectId,
        taskId: task.taskId,
        runId: window.attempt.runId,
      });
      return result;
    }
    const reply =
      tool === "haril_merge"
        ? await integration.merge(context, (raw as { localId: string }).localId)
        : tool === "haril_merge_continue"
          ? await integration.mergeContinue(context)
          : await integration.mergeAbort(context);
    return reply.ok ? reply : refuse(window, reply.reason);
  };

  return {
    call: (context, tool, input) => {
      const window = windows.get(context.runId);
      if (
        window === undefined ||
        window.attempt.taskId !== context.taskId ||
        window.attempt.projectId !== context.projectId
      ) {
        return refuse(
          undefined,
          `run ${context.runId} is not a running workflow turn; only a workflow turn may call the delegation tools`,
        );
      }
      if (tool === "haril_web") {
        return webCall(window, input).catch((error: unknown) =>
          refuse(
            window,
            `haril_web failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`,
          ),
        );
      }
      if (isWorkspaceTool(tool)) {
        return workspaceCall(window, tool, input).catch((error: unknown) =>
          refuse(
            window,
            `${tool} failed in the host: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`,
          ),
        );
      }
      return check(window, tool, input);
    },
    open: (attempt) => {
      const window: Window = {
        attempt,
        action: null,
        refusals: [],
        workspace: null,
        epoch: 0,
        ended: undefined,
      };
      windows.set(attempt.runId, window);
      return () => {
        windows.delete(attempt.runId);
        return { action: window.action, refusals: [...window.refusals] };
      };
    },
    attach: (runId, workspace, epoch, ended) => {
      const window = windows.get(runId);
      if (window === undefined) return;
      window.workspace = workspace;
      window.epoch = epoch;
      window.ended = ended;
    },
    integration,
    refusalsOf: (runId) => windows.get(runId)?.refusals ?? [],
  };
}
