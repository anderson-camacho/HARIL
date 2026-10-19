import { createHash } from "node:crypto";
import { rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { EditInput } from "@haril/contracts";
import {
  checkWorkspacePath,
  normalizeWorkspacePath,
  pathMatchesSurface,
  visibleText,
} from "@haril/core";
import type { AgentOutcome, Store, WorktreeRecord } from "@haril/core/ports";
import {
  abortMerge,
  addWorktree,
  branchCommit,
  changedPaths,
  checkPointer,
  commitPaths,
  deleteBranch,
  discardChanges,
  type GitOptions,
  headBranch,
  headCommit,
  isAncestor,
  isTracked,
  mergeBranch,
  mergeInProgress,
  pathsChangedSince,
  removeWorktree,
  restoreBranch,
  worktreeIdentity,
} from "@haril/git";
import { readConfinedFile, writeConfinedFile } from "@haril/os";
import {
  type HostCommandProcess,
  type HostCommandResult,
  type HostCommandSettings,
  runHostCommand,
} from "./host-commands.js";
import type { Task, WorkflowView } from "./workflow-view.js";

// The git worktrees of a workflow that writes (docs/modos-y-delegacion.md 3.10, phase F8). A workflow writes when it
// started with a base branch and its commit (base_branch, base_sha): its project root is the top level of a git
// repository. Then:
//   - each executor thread works in its own worktree, on its own branch, created from the base commit (P13: never from
//     another branch). A step whose dependencies wait on another step's audit (its own dependsOn, or the order the
//     Core adds between overlapping steps of one assignment) starts with that step's approved commit merged in, so it
//     sees its predecessor's work; its base is still the base commit. A step that only waited for a surface lock (an
//     overlapping step of another part or another workflow) starts from the base commit alone: the delegators' merges
//     into the integration branch bring that work together;
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
// added or removed at once. Every git run on a worktree names the worktree's own git folder and its work tree
// (--git-dir, --work-tree), taken from the main repository when the worktree is opened, never from the worktree's .git
// pointer file: a command run in the worktree could rewrite that file to point at the main repository. After each turn
// the pointer file must still hold the bytes git wrote; if not, the turn fails, its changes are discarded, the file is
// put back and the event worktree.tampered says so. An executor's commit also checks that HEAD is the step's branch.
// A branch HARIL owns only ever holds commits HARIL verified. An executor's branch has a verified commit, recorded in the
// store (verifiedSha): where the step started, then each commit the end of a successful turn checked. Every turn of the
// step, its auditor's too, starts there: a HEAD a command moved in a turn whose end never ran (a crash) is put back
// first. A turn that does not succeed, or that was tampered with, puts the branch back there, so a commit a command made
// never survives into a retry; an auditor's turn always does. A turn that holds the integration lock keeps its own
// verified commit of the integration branch, where it started and then each merge HARIL made in it: a command's commit
// on that branch is dropped before a merge and at the turn's end. Each putting back is the event worktree.restored.
// HARIL never moves the base branch, but a command can (N0). Its commit is read when a turn starts and compared at the
// turn's end: a move is the event base.moved, and when the turn ran a command it fails the turn and stops the workflow.

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
  // The worktree's own git folder, found from the main repository, and the bytes of its .git pointer file.
  readonly gitDir: string;
  readonly pointer: string;
  // The branch's verified commit when the turn started (the step's last verified commit for an executor and an auditor;
  // the integration branch's commit as the turn found it otherwise): what the turn added is checked against it, and a
  // turn that does not succeed puts the branch back on it.
  readonly startHead: string;
  // The base branch's commit (refs/heads/<base>) when the turn started; null when it could not be read. The turn's end
  // compares it: HARIL's own git never moves the base branch, but under N0 a command can (it may point the worktree's
  // .git file at the main repository and commit itself).
  readonly baseTip: string | null;
}

// The failure of a turn during which the base branch moved while it ran a command: the run loop then stops the workflow.
export const BASE_MOVED_CODE = "workspace.base_moved";

// What the user is told when the base branch moved during a turn that ran commands. HARIL never moves it back: the user
// may have committed on it.
function baseMovedMessage(
  base: string,
  from: string,
  to: string | undefined,
  commands: number,
): string {
  const ran = `while a turn ran ${commands} ${commands === 1 ? "command" : "commands"} (haril_run)`;
  if (to === undefined) {
    return `the base branch ${base} (at ${from}) was deleted or cannot be read ${ran}; HARIL never touches it and stopped the workflow. If you did not delete it, restore it with "git branch ${base} ${from}"`;
  }
  return `the base branch ${base} moved from ${from} to ${to} ${ran}; HARIL never moves it back and stopped the workflow. Inspect the new commits with "git log ${from}..${to}"; if they are not yours, put ${base} back with "git branch -f ${base} ${from}" (where ${base} is checked out, run "git reset --keep ${from}" on it instead)`;
}

// A turn's commits reached outside its write surface (a command staged or committed other files).
class OutsideSurface extends Error {}

// A turn's worktree before the base branch's commit is added to it.
type PreparedWorkspace = Omit<TurnWorkspace, "baseTip">;

// How git runs on a turn's worktree: its own git folder and work tree, named on every run.
export function worktreeGit(
  git: GitOptions,
  workspace: Pick<TurnWorkspace, "gitDir" | "root">,
): GitOptions {
  return { ...git, gitDir: workspace.gitDir, workTree: workspace.root };
}

// What a turn may write: its write surface's globs, or, for a delegator resolving a merge, exactly the conflicting files
// (literal paths, so "app/[id]/page.tsx" or "café.md" is the file it names; a tracked file whose name looks secret,
// such as .env.example, may be resolved too).
export type WriteScope = readonly string[] | { readonly conflicts: readonly string[] };

interface CommandHooks {
  // The turn's end: an aborted turn kills the command's tree.
  readonly signal?: AbortSignal;
  readonly onSpawn?: (process: HostCommandProcess) => void;
  readonly onExit?: (process: HostCommandProcess) => void;
}

export type WorkspaceReply =
  | ({ readonly ok: true } & Readonly<Record<string, unknown>>)
  | { readonly ok: false; readonly reason: string };

// Letter case counts in a surface wherever the file system tells names apart by it (everywhere but Windows).
const SURFACE_MATCH = { caseSensitive: process.platform !== "win32" } as const;

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

// The turns that use the integration worktree under the workflow's integration lock: the delegators and the final
// auditor. Only they run commands there; the other turns in it only read.
function holdsIntegrationLock(view: WorkflowView, task: Task): boolean {
  return (
    task.role === "delegator" ||
    (task.role === "auditor" && view.task(task.auditedTaskId)?.role !== "executor")
  );
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
    scope: WriteScope,
    path: string,
    content: string,
  ): Promise<WorkspaceReply>;
  edit(
    workspace: TurnWorkspace,
    scope: WriteScope,
    path: string,
    edits: EditInput["edits"],
  ): Promise<WorkspaceReply>;
  // Runs an allowed command in the turn's worktree; `hooks` end it with the turn and report its process.
  run(
    workspace: TurnWorkspace,
    command: string,
    args: readonly string[],
    hooks?: CommandHooks,
  ): Promise<HostCommandResult>;
  // Runs `work` alone among the mutating git operations of the repository.
  withRepository<T>(repo: string, work: () => Promise<T>): Promise<T>;
  // The commit the turn's branch must hold now: where the turn started, moved on by each merge HARIL made in it.
  verifiedHead(workspace: TurnWorkspace): string;
  // A merge HARIL made in the turn (haril_merge, haril_merge_continue): its commit becomes the branch's verified head.
  recordMerge(workspace: TurnWorkspace, sha: string): void;
  // Puts the turn's branch back on its verified head when a command moved it, and leaves the worktree clean. The caller
  // already runs inside withRepository. Answers whether the branch had moved.
  putBack(
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
    workspace: TurnWorkspace,
  ): Promise<boolean>;
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

  // Each turn's verified commit of its branch once a merge HARIL made moved it on from startHead (phase F8, 0.20.1).
  const turnHeads = new WeakMap<TurnWorkspace, string>();
  const verifiedOf = (workspace: TurnWorkspace): string =>
    turnHeads.get(workspace) ?? workspace.startHead;
  // How many commands each turn started through haril_run (a process spawned): the base branch's move is the turn's
  // failure only when one ran.
  const commandsRan = new WeakMap<TurnWorkspace, number>();

  // Compares the base branch with its commit when the turn started. A move is recorded as base.moved; when the turn ran a
  // command it is also the turn's failure (BASE_MOVED_CODE), and the run loop stops the workflow. A move during a turn
  // that ran none was the user's own work: only recorded. HARIL never moves the base branch back.
  const checkBase = async (
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
    workspace: TurnWorkspace,
  ): Promise<AgentOutcome | null> => {
    if (workspace.baseTip === null) return null;
    const now = await branchCommit(workspace.repo, workspace.baseBranch, git);
    if (now === workspace.baseTip) return null;
    const commands = commandsRan.get(workspace) ?? 0;
    store.events.append({
      aggregateType: "workflow",
      aggregateId: view.workflow.workflowId,
      type: "base.moved",
      actorKind: "system",
      actorId: `runtime:${epoch}`,
      payload: {
        workflowId: view.workflow.workflowId,
        worktreeId: workspace.worktreeId,
        baseBranch: workspace.baseBranch,
        fromSha: workspace.baseTip,
        toSha: now ?? null,
        commands,
        stopped: commands > 0,
      },
      projectId: view.workflow.projectId,
      taskId: task.taskId,
    });
    if (commands === 0) return null;
    return {
      status: "failed",
      code: BASE_MOVED_CODE,
      message: baseMovedMessage(workspace.baseBranch, workspace.baseTip, now, commands),
    };
  };

  const runAbort = async (path: string, options: GitOptions): Promise<void> => {
    if (await mergeInProgress(path, options)) await abortMerge(path, options);
  };

  // Puts a worktree's branch back on `verified` when HEAD names another branch (or none) or another commit: a command
  // checked out, committed, reset or deleted it. Records worktree.restored; throws when git could not put it back.
  const restoreIfMoved = async (
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
    target: { readonly root: string; readonly branch: string; readonly worktreeId: string },
    own: GitOptions,
    verified: string,
  ): Promise<boolean> => {
    const branch = await headBranch(target.root, own);
    const head = await headCommit(target.root, own);
    if (branch === target.branch && head === verified) return false;
    const restored = await restoreBranch(target.root, target.branch, verified, own);
    store.events.append({
      aggregateType: "task",
      aggregateId: task.taskId,
      type: "worktree.restored",
      actorKind: "system",
      actorId: `runtime:${epoch}`,
      payload: {
        workflowId: view.workflow.workflowId,
        worktreeId: target.worktreeId,
        branch: target.branch,
        // What HEAD named and held before: the branch (null when detached or deleted) and its commit.
        fromBranch: branch ?? null,
        fromSha: head ?? null,
        toSha: verified,
        restored,
      },
      projectId: view.workflow.projectId,
      taskId: task.taskId,
    });
    if (!restored) {
      throw new Error(
        `the branch ${target.branch} could not be put back on its verified commit ${verified.slice(0, 12)}`,
      );
    }
    return true;
  };

  const putBack: Workspaces["putBack"] = async (store, epoch, view, task, workspace) => {
    const own = worktreeGit(git, workspace);
    const moved = await restoreIfMoved(
      store,
      epoch,
      view,
      task,
      workspace,
      own,
      verifiedOf(workspace),
    );
    // restoreBranch already left the worktree clean.
    if (!moved) await discardChanges(workspace.root, own);
    return moved;
  };

  // The identity of a worktree HARIL made: its own git folder and its .git pointer file, from the main repository, and
  // the commit it holds now.
  const identify = async (
    repo: string,
    path: string,
  ): Promise<{ gitDir: string; pointer: string; startHead: string }> => {
    const identity = await worktreeIdentity(repo, path, git);
    if (identity === undefined) {
      throw new Error(
        "the worktree's .git file does not point at its repository's own folder for it",
      );
    }
    const head = await headCommit(path, { ...git, gitDir: identity.gitDir, workTree: path });
    if (head === undefined) throw new Error("the worktree has no commit checked out");
    return { ...identity, startHead: head };
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
  ): Promise<PreparedWorkspace> => {
    const workflowId = view.workflow.workflowId;
    const branch = integrationBranchOf(workflowId);
    const path = folderOf(workflowId, "integration");
    const baseSha = view.workflow.baseSha as string;
    const added = await withRepository(repo, () =>
      addWorktree(repo, { path, branch, base: baseSha }, git),
    );
    if (!added.ok) throw new Error(`the integration worktree could not be made: ${added.detail}`);
    const identity = await identify(repo, path);
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
      ...identity,
    };
  };

  // The executor threads whose approved branch this step waits for (its dependencies on their auditors).
  const predecessors = (view: WorkflowView, task: Task): string[] => {
    const threads: string[] = [];
    for (const dependency of task.dependsOn) {
      const auditor = view.task(dependency.taskId);
      const subject = auditor?.role === "auditor" ? view.task(auditor.auditedTaskId) : undefined;
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
  ): Promise<PreparedWorkspace> => {
    const workflowId = view.workflow.workflowId;
    const branch = executorBranchOf(workflowId, view, task.threadId);
    const path = folderOf(workflowId, short(task.threadId));
    const baseSha = view.workflow.baseSha as string;
    const known = store.worktrees
      .list({ workflowId, kind: "executor" })
      .find((record) => record.threadId === task.threadId);
    let identity: { gitDir: string; pointer: string; startHead: string } | undefined;
    const added = await withRepository(repo, async () => {
      const result = await addWorktree(repo, { path, branch, base: baseSha }, git);
      if (!result.ok) return result;
      const found = await identify(repo, path);
      identity = found;
      const own: GitOptions = { ...git, gitDir: found.gitDir, workTree: path };
      // A recorded worktree got its predecessors' work before it was recorded. Its next turn starts from the step's last
      // verified commit: a HEAD a command moved in a turn whose end never ran is put back first. A record from before
      // 0.20.1 has none: its recorded head, else HEAD as found.
      if (known !== undefined) {
        const verified = known.verifiedSha ?? known.headSha ?? found.startHead;
        await restoreIfMoved(
          store,
          epoch,
          view,
          task,
          { root: path, branch, worktreeId: known.worktreeId },
          own,
          verified,
        );
        identity = { ...found, startHead: verified };
        return result;
      }
      // One made but never recorded (a crash between the add and the record) gets it now: each predecessor commit its
      // HEAD does not hold yet is merged.
      if (result.reused) await runAbort(path, own);
      // P13: a new step that waits for others starts with their approved work merged into its own branch.
      for (const thread of predecessors(view, task)) {
        const record = store.worktrees
          .list({ workflowId, kind: "executor" })
          .find((item) => item.threadId === thread);
        if (record === undefined || record.headSha === null) continue;
        if ((await isAncestor(path, record.headSha, "HEAD", own)) === true) continue;
        // The predecessor's commit, not its branch: a merged step's branch may already be gone.
        const merged = await mergeBranch(
          path,
          record.headSha,
          `haril: start ${label(view.label(task.threadId))} from ${label(view.label(thread))}`,
          own,
        );
        if (!merged.ok || !merged.merged) {
          // Two predecessors that conflict: the step starts from what merged cleanly, and its prompt carries the rest.
          await runAbort(path, own);
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
      // The step starts from what merged: its turn's work is checked against that commit.
      const head = await headCommit(path, own);
      if (head !== undefined) identity = { ...found, startHead: head };
      return result;
    });
    if (!added.ok) throw new Error(`the step's worktree could not be made: ${added.detail}`);
    if (identity === undefined) throw new Error("the step's worktree has no identity");
    const record = store.worktrees.record(epoch, {
      workflowId,
      kind: "executor",
      threadId: task.threadId,
      path,
      branch,
      baseSha,
    });
    // A new step's first verified commit: where it starts, its predecessors' work merged.
    if (known === undefined)
      store.worktrees.setVerified(epoch, record.worktreeId, identity.startHead);
    return {
      kind: "executor",
      worktreeId: record.worktreeId,
      root: path,
      branch,
      baseBranch: view.workflow.baseBranch as string,
      repo,
      workflowId,
      writeSurface: task.surfaceWrite,
      ...identity,
    };
  };

  const prepare: Workspaces["prepare"] = async (store, epoch, view, task) => {
    if (!isWritingWorkflow(view)) return null;
    const repo = repoOf(store, view);
    if (repo === undefined) throw new Error("the workflow's project is not registered");
    // Read before the turn's agent starts: the turn's end compares the base branch with it.
    const baseTip = (await branchCommit(repo, view.workflow.baseBranch as string, git)) ?? null;
    return { ...(await prepareIn(store, epoch, view, task, repo)), baseTip };
  };

  const prepareIn = async (
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
    repo: string,
  ): Promise<PreparedWorkspace> => {
    if (task.role === "executor") return ensureExecutor(store, epoch, view, task, repo);
    if (task.role === "auditor") {
      const subject = view.task(task.auditedTaskId);
      if (subject?.role === "executor") {
        const record = store.worktrees
          .list({ workflowId: view.workflow.workflowId, kind: "executor", state: "active" })
          .find((item) => item.threadId === subject.threadId);
        if (record === undefined)
          throw new Error("the step's worktree is gone; there is nothing to audit");
        const found = await identify(repo, record.path);
        // The auditor judges the step's last verified commit, never what a command added after it.
        const verified = record.verifiedSha ?? record.headSha ?? found.startHead;
        const own: GitOptions = { ...git, gitDir: found.gitDir, workTree: record.path };
        const target = { root: record.path, branch: record.branch, worktreeId: record.worktreeId };
        await withRepository(repo, () =>
          restoreIfMoved(store, epoch, view, task, target, own, verified),
        );
        return {
          kind: "audit",
          worktreeId: record.worktreeId,
          root: record.path,
          branch: record.branch,
          baseBranch: view.workflow.baseBranch as string,
          repo,
          workflowId: view.workflow.workflowId,
          writeSurface: [],
          ...found,
          startHead: verified,
        };
      }
    }
    const integration = await ensureIntegration(store, epoch, view, repo);
    if (holdsIntegrationLock(view, task)) {
      // A turn that holds the integration lock starts clean: a merge a crashed runtime left half done is given up, and
      // nothing uncommitted stays (every merge a delegator finished is a commit).
      const own = worktreeGit(git, integration);
      await withRepository(repo, async () => {
        await runAbort(integration.root, own);
        await discardChanges(integration.root, own);
      });
    }
    return integration;
  };

  const commitExecutor = async (
    store: Store,
    epoch: number,
    view: WorkflowView,
    task: Task,
    workspace: TurnWorkspace,
  ): Promise<string | null> => {
    const own = worktreeGit(git, workspace);
    // The commit goes onto the step's branch only: a command that checked out another branch leaves nothing committed.
    const head = await headBranch(workspace.root, own);
    if (head !== workspace.branch) {
      throw new Error(
        `the step's worktree is on ${head === undefined ? "no branch" : `the branch ${head}`}, not ${workspace.branch}; nothing was committed`,
      );
    }
    // The branch still holds the commit the turn started from: a command that reset or rewrote it below that commit
    // leaves nothing committed.
    if ((await isAncestor(workspace.root, workspace.startHead, "HEAD", own)) !== true) {
      throw new Error(
        `the step's branch no longer holds the commit its turn started from (${workspace.startHead.slice(0, 12)}): a command reset or rewrote it; nothing was committed`,
      );
    }
    const changed = await changedPaths(workspace.root, own);
    if (changed === undefined) throw new Error("git status failed in the step's worktree");
    const inside = changed.filter((path) =>
      pathMatchesSurface(path, workspace.writeSurface, SURFACE_MATCH),
    );
    const message = `haril: ${label(view.label(task.threadId))} attempt ${task.attempt}\n\n${label(task.goal)}`;
    const committed = await commitPaths(workspace.root, inside, message, own);
    if (!committed.ok)
      throw new Error(`the step's work could not be committed: ${committed.detail}`);
    // Everything the branch gained in the turn (a command's own commits too) must stay inside the surface.
    const gained = await pathsChangedSince(workspace.root, workspace.startHead, own);
    const outside =
      gained === undefined
        ? ["(git could not list the changes)"]
        : gained.filter((path) => !pathMatchesSurface(path, workspace.writeSurface, SURFACE_MATCH));
    if (outside.length > 0) {
      // Silent here: the event worktree.outside_surface says it.
      await restoreBranch(workspace.root, workspace.branch, workspace.startHead, own);
      throw new OutsideSurface(
        `the turn's commits reach outside its write surface (${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""}); the branch was put back`,
      );
    }
    await discardChanges(workspace.root, own);
    const tip = await headCommit(workspace.root, own);
    if (tip !== undefined) {
      // Checked: the step's next turn starts here.
      store.worktrees.setVerified(epoch, workspace.worktreeId, tip);
      if (tip !== workspace.startHead) store.worktrees.setHead(epoch, workspace.worktreeId, tip);
      if (tip !== workspace.startHead && gained !== undefined && gained.length > 0) {
        const claim = [...store.events.list({ taskId: task.taskId })]
          .reverse()
          .find(
            (event) =>
              event.type === "task.claimed" &&
              event.actorKind === "system" &&
              event.payload.attempt === task.attempt &&
              typeof event.runId === "string",
          );
        if (claim?.runId === undefined) {
          throw new Error(
            "the executor's changed commit has no host-recorded attempt; evidence was not recorded",
          );
        }
        store.events.append({
          aggregateType: "task",
          aggregateId: task.taskId,
          type: "worktree.committed",
          actorKind: "system",
          actorId: `runtime:${epoch}`,
          payload: {
            workflowId: view.workflow.workflowId,
            attempt: task.attempt,
            sha: tip,
            paths: gained,
          },
          projectId: view.workflow.projectId,
          taskId: task.taskId,
          runId: claim.runId,
        });
      }
    }
    return committed.sha;
  };

  const finish: Workspaces["finish"] = async (store, epoch, view, task, workspace, outcome) => {
    const own = worktreeGit(git, workspace);
    // The branches a turn's end puts back on their verified commit: an executor's and an auditor's (the step's branch),
    // and the integration branch of a turn that holds the integration lock. The other turns in the integration worktree
    // run no command and share it with the lock's holder: they only clean up.
    const guarded = workspace.kind !== "integration" || holdsIntegrationLock(view, task);
    const restoreGuarded = async (): Promise<void> => {
      if (guarded) {
        await restoreIfMoved(store, epoch, view, task, workspace, own, verifiedOf(workspace));
      }
    };
    return withRepository(workspace.repo, async () => {
      // Before any git run: the .git pointer file must still be the one git wrote. A rewritten one fails the turn.
      const pointer = await checkPointer(workspace.root, workspace.pointer);
      // The base branch must still be where the turn found it (git runs in the main repository here, never through the
      // worktree's .git file). A move while a command ran fails the turn whatever else it did: nothing is committed.
      const stop = await checkBase(store, epoch, view, task, workspace);
      if (pointer !== "intact") {
        await runAbort(workspace.root, own);
        await restoreGuarded();
        await discardChanges(workspace.root, own);
        store.events.append({
          aggregateType: "task",
          aggregateId: task.taskId,
          type: "worktree.tampered",
          actorKind: "system",
          actorId: `runtime:${epoch}`,
          payload: {
            workflowId: view.workflow.workflowId,
            worktreeId: workspace.worktreeId,
            branch: workspace.branch,
            restored: pointer === "restored",
          },
          projectId: view.workflow.projectId,
          taskId: task.taskId,
        });
        return (
          stop ?? {
            status: "failed",
            code: "workspace.tampered",
            message:
              "the worktree's .git file was changed during the turn; its work was discarded and nothing was committed",
          }
        );
      }
      if (workspace.kind === "executor") {
        // A turn that did not succeed commits nothing: a commit a command made goes too, so its retry starts clean.
        if (outcome.status !== "succeeded" || stop !== null) {
          await restoreGuarded();
          await discardChanges(workspace.root, own);
          return stop ?? outcome;
        }
        try {
          await commitExecutor(store, epoch, view, task, workspace);
          return outcome;
        } catch (error) {
          await restoreGuarded();
          await discardChanges(workspace.root, own);
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof OutsideSurface) {
            store.events.append({
              aggregateType: "task",
              aggregateId: task.taskId,
              type: "worktree.outside_surface",
              actorKind: "system",
              actorId: `runtime:${epoch}`,
              payload: {
                workflowId: view.workflow.workflowId,
                worktreeId: workspace.worktreeId,
                branch: workspace.branch,
              },
              projectId: view.workflow.projectId,
              taskId: task.taskId,
            });
            return { status: "failed", code: "workspace.outside_surface", message };
          }
          return { status: "failed", code: "workspace.commit_failed", message };
        }
      }
      // Everyone else leaves nothing behind: a merge left waiting is given up, what commands changed is discarded, and a
      // commit or a branch move a command made is undone (the merges HARIL made in the turn stay).
      await runAbort(workspace.root, own);
      await restoreGuarded();
      await discardChanges(workspace.root, own);
      return stop ?? outcome;
    });
  };

  const guardedPath = (
    surface: readonly string[],
    path: string,
  ): { ok: true; path: string } | { ok: false; reason: string } => {
    const check = checkWorkspacePath(path, surface, SURFACE_MATCH);
    if (check.ok) return check;
    const where =
      check.reason === "outside_surface"
        ? `outside your write surface (${surface.join(", ") || "nothing"})`
        : check.reason.replace(/_/g, " ");
    return { ok: false, reason: `${path.slice(0, 200)} cannot be written: ${where}` };
  };

  // A conflicting file of the merge in progress: the literal path git reported, and a name that looks secret only when
  // the repository tracks it. .git, .haril and .pi are never written.
  const conflictPath = async (
    workspace: TurnWorkspace,
    conflicts: readonly string[],
    path: string,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
    const refused = (why: string) => ({
      ok: false as const,
      reason: `${path.slice(0, 200)} cannot be written: ${why}`,
    });
    const checked = normalizeWorkspacePath(path, { allowSecret: true });
    if (!checked.ok) return refused(checked.reason.replace(/_/g, " "));
    const wanted = checked.path.normalize("NFC");
    const listed = conflicts.find((file) => file.normalize("NFC") === wanted);
    if (listed === undefined) {
      return refused(`not one of the conflicting files (${conflicts.join(", ") || "none"})`);
    }
    const strict = normalizeWorkspacePath(listed);
    if (!strict.ok && !(await isTracked(workspace.root, listed, worktreeGit(git, workspace)))) {
      return refused(strict.reason.replace(/_/g, " "));
    }
    return { ok: true, path: listed };
  };

  const scopedPath = (
    workspace: TurnWorkspace,
    scope: WriteScope,
    path: string,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> =>
    "conflicts" in scope
      ? conflictPath(workspace, scope.conflicts, path)
      : Promise.resolve(guardedPath(scope as readonly string[], path));

  const write: Workspaces["write"] = async (workspace, scope, path, content) => {
    const checked = await scopedPath(workspace, scope, path);
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

  const edit: Workspaces["edit"] = async (workspace, scope, path, edits) => {
    const checked = await scopedPath(workspace, scope, path);
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

  const run: Workspaces["run"] = (workspace, command, args, hooks = {}) =>
    runHostCommand({
      command,
      args,
      cwd: workspace.root,
      settings: settings.commands,
      ...(settings.env === undefined ? {} : { env: settings.env }),
      ...(settings.killTree === undefined ? {} : { killTree: settings.killTree }),
      ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
      onSpawn: (process) => {
        commandsRan.set(workspace, (commandsRan.get(workspace) ?? 0) + 1);
        hooks.onSpawn?.(process);
      },
      ...(hooks.onExit === undefined ? {} : { onExit: hooks.onExit }),
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
        // Whether a branch holds work is git's answer, not the store's (a crash may have left a merge unrecorded): its
        // tip differs from the base commit. An executor's branch goes once merged; an unmerged one with work stays. The
        // integration branch stays when it holds work, for the user to review; an empty one goes.
        const tip = await branchCommit(repo, record.branch, git);
        const holdsWork = tip !== undefined && tip !== record.baseSha;
        const keep = record.kind === "executor" ? record.mergedAt === null && holdsWork : holdsWork;
        if (!keep) await deleteBranch(repo, record.branch, git);
        return true;
      });
      if (!done) continue;
      store.worktrees.markRemoved(epoch, record.worktreeId);
      removed += 1;
      // The workflow's folder goes with its last worktree (rmdir refuses a folder that still holds one).
      await rmdir(dirname(record.path)).catch(() => undefined);
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
    verifiedHead: verifiedOf,
    recordMerge: (workspace, sha) => {
      turnHeads.set(workspace, sha);
    },
    putBack,
    retireExecutor,
    sweep,
  };
}
