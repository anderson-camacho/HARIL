import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { EditInput } from "@haril/contracts";
import { checkWorkspacePath, pathMatchesSurface, visibleText } from "@haril/core";
import type { AgentOutcome, Store, WorktreeRecord } from "@haril/core/ports";
import {
  abortMerge,
  addWorktree,
  changedPaths,
  commitPaths,
  deleteBranch,
  discardChanges,
  type GitOptions,
  mergeBranch,
  mergeInProgress,
  removeWorktree,
} from "@haril/git";
import { readConfinedFile, writeConfinedFile } from "@haril/os";
import {
  type HostCommandResult,
  type HostCommandSettings,
  runHostCommand,
} from "./host-commands.js";
import type { Task, WorkflowView } from "./workflow-view.js";

// The git worktrees of a workflow that writes (docs/modos-y-delegacion.md 3.10, phase F8). A workflow writes when it
// started with a base branch and its commit (base_branch, base_sha): its project root is the top level of a git
// repository. Then:
//   - each executor thread works in its own worktree, on its own branch, created from the base commit (P13: never from
//     another branch). A step that depends on another (or that the Core serialized after it) starts with that step's
//     branch merged in, so it sees its predecessor's work; its base is still the base commit;
//   - an executor's turn writes only inside its declared surface (the Core's lexical PathGuard, then the filesystem
//     check of @haril/os). When the turn ends, only the changed paths inside its surface are committed, and anything else
//     a command left is discarded: the branch holds exactly what the step wrote;
//   - its auditor reads that worktree and may run allowed commands there; whatever they change is discarded after it;
//   - the workflow's integration worktree, on haril/<workflow>/integration (P12), holds what the delegators merged.
//     The delegators, the final auditor and the turns that only read work there; delegator turns and the final auditor
//     hold the workflow's integration lock, so one of them at a time uses it;
//   - worktrees go away after integration: an executor's once its branch is merged (the branch with it), the rest when
//     the workflow ends, by the startup sweep or by the run loop. The integration branch stays for the user to review;
//     HARIL never merges it into the base branch and never pushes.
// Every mutating git operation on one repository runs one at a time (a lock per repository), so two worktrees are never
// added or removed at once.

export interface WorkspaceSettings {
  // The folder that holds every worktree (the data directory's worktrees folder).
  readonly root: string;
  readonly commands: HostCommandSettings;
  // How git runs (tests point it at an isolated configuration).
  readonly git?: GitOptions;
  // The environment haril_run's clean environment is taken from; defaults to this process's.
  readonly env?: NodeJS.ProcessEnv;
  // The host's verified tree kill, for a command past its time limit.
  readonly killTree?: (process: {
    readonly pid: number;
    readonly startedAt: number;
  }) => Promise<void>;
}

export interface TurnWorkspace {
  readonly kind: "executor" | "audit" | "integration";
  readonly worktreeId: string;
  // The worktree folder.
  readonly root: string;
  readonly branch: string;
  readonly baseBranch: string;
  // The repository (the project root).
  readonly repo: string;
  readonly workflowId: string;
  // An executor's write surface (its files.write globs); empty for every other turn.
  readonly writeSurface: readonly string[];
}

export type WorkspaceReply =
  | ({ readonly ok: true } & Readonly<Record<string, unknown>>)
  | { readonly ok: false; readonly reason: string };

// The longest file an edit reads back.
const EDIT_MAX_BYTES = 4 * 1024 * 1024;
// A removal the sweep makes retries a little; one that keeps failing waits for the next sweep.
const SWEEP_REMOVE_RETRIES = 3;

function short(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 12);
}

function label(text: string): string {
  return visibleText(text).replace(/\s+/g, " ").trim().slice(0, 200);
}

// P12: the workflow's integration branch.
export function integrationBranchOf(workflowId: string): string {
  return `haril/${workflowId}/integration`;
}

// An executor thread's branch: its part and step, and a short hash of its thread so a later step with the same local id
// gets a branch of its own.
function executorBranchOf(workflowId: string, view: WorkflowView, threadId: string): string {
  const first = view.turns(threadId)[0];
  const parent = view.parentThreadId(threadId);
  const part = parent === null ? "" : (view.turns(parent)[0]?.localId ?? "");
  const step = first?.localId ?? "step";
  const slug = [part, step]
    .filter((piece) => piece !== "")
    .join("-")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 80);
  return `haril/${workflowId}/step/${slug}-${short(threadId).slice(0, 6)}`;
}

function isWritingWorkflow(view: WorkflowView): boolean {
  return view.workflow.baseBranch !== null && view.workflow.baseSha !== null;
}

// Applies Pi's edit shape to a text: each oldText must appear exactly once in the original, the regions must not
// overlap, and every replacement is matched against the original, not against the result of an earlier one.
export function applyEdits(
  original: string,
  edits: EditInput["edits"],
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const ranges: { start: number; end: number; text: string }[] = [];
  for (const [index, edit] of edits.entries()) {
    const start = original.indexOf(edit.oldText);
    const quoted = JSON.stringify(edit.oldText.slice(0, 60));
    if (start === -1)
      return { ok: false, reason: `edits[${index}].oldText ${quoted} is not in the file` };
    if (original.indexOf(edit.oldText, start + 1) !== -1) {
      return {
        ok: false,
        reason: `edits[${index}].oldText ${quoted} appears more than once; give more context so it is unique`,
      };
    }
    ranges.push({ start, end: start + edit.oldText.length, text: edit.newText });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if ((ranges[index] as { start: number }).start < (ranges[index - 1] as { end: number }).end) {
      return { ok: false, reason: "two edits overlap; merge them into one" };
    }
  }
  let text = "";
  let cursor = 0;
  for (const range of ranges) {
    text += original.slice(cursor, range.start) + range.text;
    cursor = range.end;
  }
  return { ok: true, text: text + original.slice(cursor) };
}

export interface Workspaces {
  readonly settings: WorkspaceSettings;
  // The worktree a turn of a writing workflow works in, made when it does not exist yet; null for a read-only workflow.
  prepare(
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
  ): Promise<TurnWorkspace | null>;
  // After the attempt: an executor's surface changes committed (on success) and the rest discarded; an auditor's or a
  // delegator's changes discarded, and a merge left in progress aborted. Answers the outcome the turn closes with.
  finish(
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
    workspace: TurnWorkspace,
    outcome: AgentOutcome,
  ): Promise<AgentOutcome>;
  write(
    workspace: TurnWorkspace,
    surface: readonly string[],
    path: string,
    content: string,
  ): Promise<WorkspaceReply>;
  edit(
    workspace: TurnWorkspace,
    surface: readonly string[],
    path: string,
    edits: EditInput["edits"],
  ): Promise<WorkspaceReply>;
  run(
    workspace: TurnWorkspace,
    command: string,
    args: readonly string[],
  ): Promise<HostCommandResult>;
  // Runs `work` alone among the mutating git operations of the repository.
  withRepository<T>(repo: string, work: () => Promise<T>): Promise<T>;
  // Removes an executor's worktree and deletes its branch once its work is merged.
  retireExecutor(store: Store, epoch: number, record: WorktreeRecord, repo: string): Promise<void>;
  // Removes the worktrees of workflows that ended (not those in `busy`); the integration branch stays when it holds work.
  sweep(store: Store, epoch: number, busy?: ReadonlySet<string>): Promise<number>;
}

export function createWorkspaces(settings: WorkspaceSettings): Workspaces {
  const git = settings.git ?? {};
  const queues = new Map<string, Promise<unknown>>();

  const withRepository = <T>(repo: string, work: () => Promise<T>): Promise<T> => {
    const key = process.platform === "win32" ? resolve(repo).toLowerCase() : resolve(repo);
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };

  const runAbort = async (path: string): Promise<void> => {
    if (await mergeInProgress(path, git)) await abortMerge(path, git);
  };

  const repoOf = (store: Store, view: WorkflowView): string | undefined =>
    store.projects.list().find((project) => project.projectId === view.workflow.projectId)
      ?.rootPath;

  const folderOf = (workflowId: string, leaf: string): string =>
    join(settings.root, short(workflowId), leaf);

  const ensureIntegration = async (
    store: Store,
    epoch: number,
    view: WorkflowView,
    repo: string,
  ): Promise<TurnWorkspace> => {
    const workflowId = view.workflow.workflowId;
    const branch = integrationBranchOf(workflowId);
    const path = folderOf(workflowId, "integration");
    const baseSha = view.workflow.baseSha as string;
    const added = await withRepository(repo, () =>
      addWorktree(repo, { path, branch, base: baseSha }, git),
    );
    if (!added.ok) throw new Error(`the integration worktree could not be made: ${added.detail}`);
    const record = store.worktrees.record(epoch, {
      workflowId,
      kind: "integration",
      threadId: null,
      path,
      branch,
      baseSha,
    });
    return {
      kind: "integration",
      worktreeId: record.worktreeId,
      root: path,
      branch,
      baseBranch: view.workflow.baseBranch as string,
      repo,
      workflowId,
      writeSurface: [],
    };
  };

  // The executor threads whose approved branch this step waits for (its dependencies on their auditors).
  const predecessors = (view: WorkflowView, task: Task): string[] => {
    const threads: string[] = [];
    for (const dependency of task.dependsOn) {
      const auditor = view.task(dependency.taskId);
      const subject = auditor?.role === "auditor" ? view.task(auditor.parentTaskId) : undefined;
      if (subject?.role === "executor" && !threads.includes(subject.threadId)) {
        threads.push(subject.threadId);
      }
    }
    return threads;
  };

  const ensureExecutor = async (
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
    repo: string,
  ): Promise<TurnWorkspace> => {
    const workflowId = view.workflow.workflowId;
    const branch = executorBranchOf(workflowId, view, task.threadId);
    const path = folderOf(workflowId, short(task.threadId));
    const baseSha = view.workflow.baseSha as string;
    const known = store.worktrees
      .list({ workflowId, kind: "executor" })
      .find((record) => record.threadId === task.threadId);
    const added = await withRepository(repo, async () => {
      const result = await addWorktree(repo, { path, branch, base: baseSha }, git);
      if (!result.ok || result.reused || known !== undefined) return result;
      // P13: a new step that waits for others starts with their approved work merged into its own branch.
      for (const thread of predecessors(view, task)) {
        const record = store.worktrees
          .list({ workflowId, kind: "executor" })
          .find((item) => item.threadId === thread);
        if (record === undefined || record.headSha === null) continue;
        const merged = await mergeBranch(
          path,
          record.branch,
          `haril: start ${label(view.label(task.threadId))} from ${label(view.label(thread))}`,
          git,
        );
        if (!merged.ok || !merged.merged) {
          // Two predecessors that conflict: the step starts from what merged cleanly, and its prompt carries the rest.
          await runAbort(path);
          store.events.append({
            aggregateType: "workflow",
            aggregateId: workflowId,
            type: "worktree.predecessor_skipped",
            actorKind: "system",
            actorId: `runtime:${epoch}`,
            payload: { taskId: task.taskId, branch: record.branch },
            projectId: view.workflow.projectId,
          });
        }
      }
      return result;
    });
    if (!added.ok) throw new Error(`the step's worktree could not be made: ${added.detail}`);
    const record = store.worktrees.record(epoch, {
      workflowId,
      kind: "executor",
      threadId: task.threadId,
      path,
      branch,
      baseSha,
    });
    return {
      kind: "executor",
      worktreeId: record.worktreeId,
      root: path,
      branch,
      baseBranch: view.workflow.baseBranch as string,
      repo,
      workflowId,
      writeSurface: task.surfaceWrite,
    };
  };

  const prepare: Workspaces["prepare"] = async (store, epoch, view, task) => {
    if (!isWritingWorkflow(view)) return null;
    const repo = repoOf(store, view);
    if (repo === undefined) throw new Error("the workflow's project is not registered");
    if (task.role === "executor") return ensureExecutor(store, epoch, view, task, repo);
    if (task.role === "auditor") {
      const subject = view.task(task.parentTaskId);
      if (subject?.role === "executor") {
        const record = store.worktrees
          .list({ workflowId: view.workflow.workflowId, kind: "executor", state: "active" })
          .find((item) => item.threadId === subject.threadId);
        if (record === undefined)
          throw new Error("the step's worktree is gone; there is nothing to audit");
        return {
          kind: "audit",
          worktreeId: record.worktreeId,
          root: record.path,
          branch: record.branch,
          baseBranch: view.workflow.baseBranch as string,
          repo,
          workflowId: view.workflow.workflowId,
          writeSurface: [],
        };
      }
    }
    return ensureIntegration(store, epoch, view, repo);
  };

  const commitExecutor = async (
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
    workspace: TurnWorkspace,
  ): Promise<string | null> => {
    const changed = await changedPaths(workspace.root, git);
    if (changed === undefined) throw new Error("git status failed in the step's worktree");
    const inside = changed.filter((path) => pathMatchesSurface(path, workspace.writeSurface));
    const message = `haril: ${label(view.label(task.threadId))} attempt ${task.attempt}\n\n${label(task.goal)}`;
    const committed = await commitPaths(workspace.root, inside, message, git);
    if (!committed.ok)
      throw new Error(`the step's work could not be committed: ${committed.detail}`);
    await discardChanges(workspace.root, git);
    if (committed.sha !== null) store.worktrees.setHead(epoch, workspace.worktreeId, committed.sha);
    return committed.sha;
  };

  const finish: Workspaces["finish"] = async (store, epoch, view, task, workspace, outcome) => {
    return withRepository(workspace.repo, async () => {
      if (workspace.kind === "executor") {
        if (outcome.status !== "succeeded") {
          await discardChanges(workspace.root, git);
          return outcome;
        }
        try {
          await commitExecutor(store, epoch, view, task, workspace);
          return outcome;
        } catch (error) {
          await discardChanges(workspace.root, git);
          return {
            status: "failed",
            code: "workspace.commit_failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
      // Everyone else leaves nothing behind: a merge left waiting is given up, and what commands changed is discarded.
      await runAbort(workspace.root);
      await discardChanges(workspace.root, git);
      return outcome;
    });
  };

  const guardedPath = (
    surface: readonly string[],
    path: string,
  ): { ok: true; path: string } | { ok: false; reason: string } => {
    const check = checkWorkspacePath(path, surface);
    if (check.ok) return check;
    const where =
      check.reason === "outside_surface"
        ? `outside your write surface (${surface.join(", ") || "nothing"})`
        : check.reason.replace(/_/g, " ");
    return { ok: false, reason: `${path.slice(0, 200)} cannot be written: ${where}` };
  };

  const write: Workspaces["write"] = async (workspace, surface, path, content) => {
    const checked = guardedPath(surface, path);
    if (!checked.ok) return checked;
    const written = await writeConfinedFile(workspace.root, checked.path, content);
    if (!written.ok) {
      return {
        ok: false,
        reason: `${checked.path} cannot be written: ${written.reason.replace(/_/g, " ")}`,
      };
    }
    return { ok: true, path: checked.path, bytes: written.bytes, created: written.created };
  };

  const edit: Workspaces["edit"] = async (workspace, surface, path, edits) => {
    const checked = guardedPath(surface, path);
    if (!checked.ok) return checked;
    const read = await readConfinedFile(workspace.root, checked.path, EDIT_MAX_BYTES);
    if (!read.ok) {
      return {
        ok: false,
        reason: `${checked.path} cannot be edited: ${read.reason.replace(/_/g, " ")}`,
      };
    }
    const applied = applyEdits(read.content, edits);
    if (!applied.ok) return { ok: false, reason: `${checked.path}: ${applied.reason}` };
    const written = await writeConfinedFile(workspace.root, checked.path, applied.text);
    if (!written.ok) {
      return {
        ok: false,
        reason: `${checked.path} cannot be written: ${written.reason.replace(/_/g, " ")}`,
      };
    }
    return { ok: true, path: checked.path, edits: edits.length };
  };

  const run: Workspaces["run"] = (workspace, command, args) =>
    runHostCommand({
      command,
      args,
      cwd: workspace.root,
      settings: settings.commands,
      ...(settings.env === undefined ? {} : { env: settings.env }),
      ...(settings.killTree === undefined ? {} : { killTree: settings.killTree }),
    });

  const retireExecutor: Workspaces["retireExecutor"] = async (store, epoch, record, repo) => {
    const removed = await removeWorktree(repo, record.path, git);
    if (!removed.ok) return;
    await deleteBranch(repo, record.branch, git);
    store.worktrees.markRemoved(epoch, record.worktreeId);
  };

  const sweep: Workspaces["sweep"] = async (store, epoch, busy = new Set()) => {
    let removed = 0;
    for (const record of store.worktrees.list({ state: "active" })) {
      const workflow = store.workflows.get(record.workflowId);
      if (workflow === undefined || busy.has(record.workflowId)) continue;
      if (
        workflow.state !== "completed" &&
        workflow.state !== "failed" &&
        workflow.state !== "stopped"
      ) {
        continue;
      }
      const repo = store.projects
        .list()
        .find((project) => project.projectId === workflow.projectId)?.rootPath;
      if (repo === undefined) continue;
      const done = await withRepository(repo, async () => {
        const result = await removeWorktree(repo, record.path, {
          ...git,
          retries: SWEEP_REMOVE_RETRIES,
        });
        if (!result.ok) return false;
        // An executor's branch goes once merged; an unmerged one stays, as it may hold work. The integration branch
        // stays when it holds merges, for the user to review; an empty one goes.
        const keep =
          record.kind === "executor" ? record.mergedAt === null : record.headSha !== null;
        if (!keep) await deleteBranch(repo, record.branch, git);
        return true;
      });
      if (!done) continue;
      store.worktrees.markRemoved(epoch, record.worktreeId);
      removed += 1;
    }
    return removed;
  };

  return {
    settings,
    prepare,
    finish,
    write,
    edit,
    run,
    withRepository,
    retireExecutor,
    sweep,
  };
}
