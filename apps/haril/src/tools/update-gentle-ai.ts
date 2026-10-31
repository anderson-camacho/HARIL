import { compareVersions } from "../version-compare.js";
import { goInstallDir } from "./detect.js";
import { pathOps } from "./paths.js";
import { collectToolsReport, type ToolsDeps, type ToolsInput } from "./status.js";
import { type ExecFn, type InstallFn, type InstallRun, lastLines } from "./system.js";
import type { ToolStatus, ToolsReport } from "./types.js";

// `haril tools update gentle-ai`: installs or updates gentle-ai with `go install` and checks the result. On Windows
// gentle-ai ships no binary (nothing is signed yet), so it is built from source at the exact release tag with the Go
// of the machine; Go verifies the module against its checksum database, and nothing here weakens that (the
// environment, GOFLAGS, GOPROXY and GOSUMDB included, goes through as it is). Updating is always an explicit action,
// never part of a start-up check, and it never touches an install other than the one `go install` writes.

const MODULE = "github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai";
const GO_VERSION_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 600_000;
const GO_DOWNLOAD = "https://go.dev/dl/";

type UpdateAction = "installed" | "updated" | "none" | "aborted" | "failed";

export interface GentleAiUpdateResult {
  readonly action: UpdateAction;
  readonly from?: string;
  readonly to?: string;
  readonly path?: string;
  readonly message?: string;
  // Things that did not stop the install but that a person has to know, such as an older gentle-ai that still wins.
  readonly warnings: readonly string[];
}

// What is about to run, shown before the question.
export interface UpdatePlan {
  // The version of the install that runs today; null when there is none or its version cannot be read.
  readonly from: string | null;
  readonly to: string;
  readonly goVersion: string;
  readonly command: string;
  // The file `go install` is expected to write.
  readonly destination: string;
}

export interface UpdateInput {
  readonly tools: ToolsInput;
  // The question is skipped.
  readonly yes: boolean;
  // There is a terminal to ask on.
  readonly interactive: boolean;
}

export interface UpdateServices {
  // Runs `go version`.
  readonly exec: ExecFn;
  // Runs `go install`.
  readonly install: InstallFn;
  // Stops the install when it aborts (Ctrl+C).
  readonly signal?: AbortSignal;
}

export interface UpdateDeps extends ToolsDeps, UpdateServices {
  // Shows the plan and asks whether to go on.
  readonly confirm: (plan: UpdatePlan) => Promise<boolean>;
}

export interface UpdateOutcome {
  readonly gentleAi: GentleAiUpdateResult;
  // The tools status: after the install when one ran, else as it was found.
  readonly report: ToolsReport;
  // The question could not be asked (no terminal, no --yes): nothing ran.
  readonly refused?: UpdatePlan;
}

function gentleAiOf(report: ToolsReport): ToolStatus {
  const status = report.tools.find((tool) => tool.id === "gentle-ai");
  if (status === undefined) throw new Error("the tools report has no gentle-ai entry");
  return status;
}

function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

// "go version go1.27.0 windows/amd64" -> "go1.27.0".
function parseGoVersion(output: string): string | undefined {
  return /\bgo version (?:devel )?(go\d\S*)/.exec(output)?.[1];
}

function goProblem(go: Awaited<ReturnType<ExecFn>>): string | undefined {
  if (go.error !== undefined) {
    const missing = /ENOENT|not found|cannot find/i.test(go.error);
    const what = missing ? "Go was not found on PATH" : `Go could not be started (${go.error})`;
    return `${what}. gentle-ai is built from source with Go: install it from ${GO_DOWNLOAD} and retry`;
  }
  if (go.timedOut) return "go version timed out after 10 seconds";
  if (go.code !== 0) {
    const tail = lastLines(go.output, 3);
    return `go version failed (exit ${go.code ?? "unknown"})${tail === "" ? "" : `: ${tail}`}`;
  }
  return parseGoVersion(go.output) === undefined
    ? `go version printed something unexpected: ${lastLines(go.output, 1) || "nothing"}`
    : undefined;
}

// Replacing the file of a program that is running: Windows refuses with these words, and so does a busy text file.
function fileInUse(tail: string): boolean {
  return (
    /access is denied|being used by another process|text file busy|ETXTBSY/i.test(tail) &&
    /gentle-ai/i.test(tail)
  );
}

function installFailure(run: InstallRun): string {
  const tail = lastLines(run.output);
  const detail = tail === "" ? "" : `\n${tail}`;
  if (run.aborted === true) {
    return "go install was interrupted before it finished; the installed gentle-ai may be unchanged";
  }
  if (run.timedOut) return `go install did not finish within 10 minutes and was stopped${detail}`;
  if (run.error !== undefined) return `could not start go: ${run.error}`;
  if (fileInUse(tail)) {
    const last = tail.split("\n").at(-1) ?? "";
    return `gentle-ai is running: close it and retry (go said: ${last})`;
  }
  return `go install failed (exit ${run.code ?? "unknown"})${detail}`;
}

function latestProblem(status: ToolStatus): string {
  const reasons = status.notes.filter((note) => /latest version|last check failed/.test(note));
  return `the latest gentle-ai version is unknown${reasons.length === 0 ? "" : `: ${reasons.join("; ")}`}; check the network and retry`;
}

export async function updateGentleAi(input: UpdateInput, deps: UpdateDeps): Promise<UpdateOutcome> {
  const { tools } = input;
  const windows = tools.platform === "win32";
  const ops = pathOps(tools.platform);
  const samePath = (path: string) => {
    const real = deps.detect.realPath(path);
    return windows ? real.toLowerCase() : real;
  };

  const before = await collectToolsReport(tools, deps, "if-due");
  const status = gentleAiOf(before);
  const failed = (message: string, report: ToolsReport = before): UpdateOutcome => ({
    gentleAi: { action: "failed", message, warnings: [] },
    report,
  });

  // The exact release tag, never @latest: what is installed is what was looked up and what is verified afterwards.
  const target = status.latest;
  if (target === null) return failed(latestProblem(status));
  const active = status.active;
  if (active !== null && active.version !== null && compareVersions(active.version, target) >= 0) {
    const same = compareVersions(active.version, target) === 0;
    return {
      gentleAi: {
        action: "none",
        to: active.version,
        path: active.path,
        message: same
          ? `gentle-ai ${active.version} is already the latest version`
          : `gentle-ai ${active.version} is newer than the latest published release (${target}); nothing to do`,
        warnings: [],
      },
      report: before,
    };
  }

  const env = childEnv(tools.env);
  const go = await deps.exec("go", ["version"], { timeoutMs: GO_VERSION_TIMEOUT_MS, env });
  const problem = goProblem(go);
  if (problem !== undefined) return failed(problem);

  const directory = goInstallDir(tools);
  if (directory === undefined) {
    return failed(
      "cannot tell where go install puts its binaries: set GOBIN (or GOPATH) and retry",
    );
  }
  const destination = ops.join(directory, windows ? "gentle-ai.exe" : "gentle-ai");
  const plan: UpdatePlan = {
    from: active?.version ?? null,
    to: target,
    goVersion: parseGoVersion(go.output) ?? "go",
    command: `go install ${MODULE}@v${target}`,
    destination,
  };

  if (!input.yes) {
    if (!input.interactive) {
      return {
        gentleAi: {
          action: "aborted",
          message: "confirmation required: there is no terminal to ask on",
          warnings: [],
        },
        report: before,
        refused: plan,
      };
    }
    if (!(await deps.confirm(plan))) {
      return {
        gentleAi: { action: "aborted", message: "nothing was changed", warnings: [] },
        report: before,
      };
    }
  }

  const run = await deps.install("go", ["install", `${MODULE}@v${target}`], {
    timeoutMs: INSTALL_TIMEOUT_MS,
    env,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  if (run.code !== 0 || run.timedOut || run.aborted === true || run.error !== undefined) {
    return failed(installFailure(run));
  }

  // Detection runs again from scratch: the version that counts is the one the new binary prints.
  const after = await collectToolsReport(tools, deps, "never");
  const afterStatus = gentleAiOf(after);
  const installed = afterStatus.installs.find(
    (install) => samePath(install.path) === samePath(destination),
  );
  if (installed === undefined) {
    return failed(
      `go install finished, but there is no gentle-ai at ${destination}; if Go is set to install elsewhere (go env GOBIN), set GOBIN and retry`,
      after,
    );
  }
  if (installed.version === null) {
    return failed(
      `could not read the version of ${installed.path} after the install: ${installed.versionError ?? "unknown"}`,
      after,
    );
  }
  if (installed.version !== target) {
    return failed(
      `after go install, ${installed.path} reports gentle-ai ${installed.version} instead of ${target}`,
      after,
    );
  }

  const warnings: string[] = [];
  const running = afterStatus.active;
  if (running !== null && samePath(running.path) !== samePath(destination)) {
    const was =
      running.version === null ? "could not be read" : `(${running.version}) was not updated`;
    if (running.version === null || compareVersions(running.version, target) < 0) {
      warnings.push(
        `the active gentle-ai at ${running.path} ${was}; the new one is at ${destination} (${target}); remove the old one or put ${directory} before it on PATH`,
      );
    }
  } else if (running !== null && !running.origins.includes("path")) {
    warnings.push(
      `${directory} is not on PATH, so running gentle-ai by name will not start the new install; add it to PATH`,
    );
  }

  // "updated" is the program that ran being replaced in place; anything else is a new copy.
  const replaced =
    active !== null && active.version !== null && samePath(active.path) === samePath(destination);
  return {
    gentleAi: {
      action: replaced ? "updated" : "installed",
      ...(replaced ? { from: active.version } : {}),
      to: target,
      path: destination,
      warnings,
    },
    report: after,
  };
}
