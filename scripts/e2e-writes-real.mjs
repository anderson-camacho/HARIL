#!/usr/bin/env node
// Real lane of parallel writes (phase F8, docs/modos-y-delegacion.md 3.10 and 9 F8): one small autonomous workflow of
// real Pi agents changes code in a scratch git project. Two executors change different files at once, each in its own
// git worktree from main, their auditors run the project's tests through haril_run, the delegator merges both into the
// workflow's integration branch, and the final auditor judges the result. It checks the integration branch (its diff and
// its tests), that main never moved and nothing was pushed, and that the executors ran together. It is opt-in
// (npm run e2e:writes-real), not part of npm test, and it never runs a local model; it runs only when everything it
// needs is present, otherwise it prints the reason and exits 0. A key is read from the environment only when the model's
// provider declares one, and it is never printed or stored. Everything lives in one scratch folder (HARIL_E2E_SCRATCH_DIR,
// or the OS temp folder): the data directory (--data-dir), an unused HARIL_HOME that must stay absent, and the project.
// The folder is kept after the run, so the integration branch can be reviewed; pass --clean to remove it after a pass.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "apps", "haril", "dist", "haril.mjs");
const CHILD_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 1_500_000;
const GATEWAY_KEY_ENV = "HARIL_CLIPROXYAPI_KEY";
const MODEL =
  process.env.HARIL_E2E_WORKFLOW_MODEL ||
  process.env.HARIL_DEFAULT_MODEL ||
  "cliproxy/gemini-3-flash";
const CLEAN = process.argv.includes("--clean");

// A tiny Node project with two modules and their tests, run by `node --test` (no dependency to install).
const FIXTURE = {
  "package.json": `${JSON.stringify({ name: "scratch-writes", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/math.mjs": "export function add(a, b) {\n  return a + b;\n}\n",
  "src/text.mjs": 'export function shout(text) {\n  return text.toUpperCase() + "!";\n}\n',
  "test/math.test.mjs": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "../src/math.mjs";',
    "",
    'test("add sums two numbers", () => {',
    "  assert.equal(add(2, 3), 5);",
    "});",
    "",
  ].join("\n"),
  "test/text.test.mjs": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { shout } from "../src/text.mjs";',
    "",
    'test("shout upper-cases and adds an exclamation mark", () => {',
    '  assert.equal(shout("hi"), "HI!");',
    "});",
    "",
  ].join("\n"),
};
const GOAL = [
  "In this small Node.js project, make two independent code changes in parallel, with one delegator that assigns two",
  "executors, one per change. Change 1: add an exported function multiply(a, b) that returns a * b to src/math.mjs, and",
  "a test for it in test/math.test.mjs; that step may write only src/math.mjs and test/math.test.mjs. Change 2: add an",
  "exported function whisper(text) that returns text.toLowerCase() followed by three dots to src/text.mjs, and a test",
  "for it in test/text.test.mjs; that step may write only src/text.mjs and test/text.test.mjs. Keep the existing",
  'functions and tests. Each executor runs the tests with haril_run (command node, args ["--test"]) and each auditor',
  "runs them too before its verdict; the delegator merges both approved steps before it reports.",
].join(" ");

function runtimeRoot() {
  const env = process.env;
  if (env.HARIL_RUNTIME_DIR) return env.HARIL_RUNTIME_DIR;
  if (process.platform === "win32") {
    return win32.join(env.LOCALAPPDATA || win32.join(homedir(), "AppData", "Local"), "HARIL");
  }
  return posix.join(env.XDG_DATA_HOME || posix.join(homedir(), ".local", "share"), "haril");
}

function modelKeyEnv(modelRef) {
  const providerId = modelRef.split("/")[0];
  const defaultKeyEnv = providerId === "cliproxy" ? GATEWAY_KEY_ENV : undefined;
  const configPath = process.env.HARIL_CONFIG || join(runtimeRoot(), "config", "haril.json");
  if (!existsSync(configPath)) return defaultKeyEnv;
  try {
    const providers = JSON.parse(readFileSync(configPath, "utf8")).providers;
    if (providers === undefined) return defaultKeyEnv;
    const entry = providers.find((candidate) => candidate.id === providerId);
    return typeof entry?.keyEnv === "string" ? entry.keyEnv : undefined;
  } catch {
    return undefined;
  }
}

function skipReason() {
  const manifest = join(runtimeRoot(), "runtime", "manifest.json");
  if (!existsSync(manifest))
    return `Pi runtime not installed (${manifest} missing; run npm run runtime:install)`;
  if (!MODEL.includes("/")) return `the model "${MODEL}" names no provider (<provider>/<model>)`;
  const keyEnv = modelKeyEnv(MODEL);
  if (keyEnv !== undefined && !process.env[keyEnv])
    return `${keyEnv} is not set (the model's provider needs it)`;
  if (spawnSync("git", ["--version"], { windowsHide: true }).status !== 0)
    return "git is not on PATH";
  return undefined;
}

function harilWith(env, args, timeoutMs) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    signal: result.signal,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
  };
}

function show(label, text, maxLines = 80) {
  if (text.trim() === "") return;
  const lines = text.trimEnd().split("\n");
  console.log(`      ${label}:`);
  for (const line of lines.slice(-maxLines)) console.log(`        ${line}`);
  if (lines.length > maxLines)
    console.log(`        (${lines.length - maxLines} earlier lines left out)`);
}

function runStep(env, args, timeoutMs = CHILD_TIMEOUT_MS, quiet = false) {
  console.log(`      $ haril ${args.join(" ")}`);
  const result = harilWith(env, args, timeoutMs);
  if (!quiet) show("stdout", result.out);
  show("stderr", result.err);
  return result;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function runJson(env, args) {
  const result = runStep(env, args, CHILD_TIMEOUT_MS, true);
  expect(result.code === 0, `"haril ${args.join(" ")}" exited ${result.code ?? result.signal}`);
  try {
    return JSON.parse(result.out);
  } catch {
    throw new Error(`"haril ${args.join(" ")}" did not print JSON`);
  }
}

// git in the scratch project, with an identity on the command line so the user's config is never written.
function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=HARIL e2e",
      "-c",
      "user.email=e2e@haril.invalid",
      "-c",
      "core.longpaths=true",
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  return (result.stdout ?? "").trim();
}

function nodeTest(cwd) {
  return spawnSync(process.execPath, ["--test"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
}

function main() {
  const reason = skipReason();
  if (reason !== undefined) {
    console.log(`SKIP writes real lane: ${reason}`);
    return 0;
  }
  if (!existsSync(ENTRY)) {
    console.log(`FAIL  ${ENTRY} is missing: run npm run build first`);
    return 1;
  }
  const parent = process.env.HARIL_E2E_SCRATCH_DIR || tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "haril-e2e-writes-"));
  let passed = false;
  try {
    const dataDir = join(root, "data");
    const unusedHome = join(root, "home-unused");
    const projectDir = join(root, "project");
    for (const [file, text] of Object.entries(FIXTURE)) {
      mkdirSync(dirname(join(projectDir, file)), { recursive: true });
      writeFileSync(join(projectDir, file), text);
    }
    git(projectDir, "init", "--quiet", "--initial-branch=main");
    git(projectDir, "add", ".");
    git(projectDir, "commit", "--quiet", "-m", "scratch project");
    const mainBefore = git(projectDir, "rev-parse", "main");
    expect(nodeTest(projectDir).status === 0, "the scratch project's own tests do not pass");
    const env = { ...process.env, HARIL_HOME: unusedHome };
    delete env.HARIL_PI_CLI_OVERRIDE;
    const data = ["--data-dir", dataDir];
    console.log(`      model ${MODEL}; scratch folder ${root}`);

    const provider = MODEL.split("/")[0];
    const models = runStep(
      env,
      ["models", "--provider", provider, "--json"],
      CHILD_TIMEOUT_MS,
      true,
    );
    if (models.code !== 0) {
      console.log(
        `FAIL  the gateway of provider ${provider} is not reachable (haril models exited ${models.code})`,
      );
      return 1;
    }
    console.log(`PASS  the gateway of provider ${provider} answers`);

    const init = runStep(env, [
      "project",
      "init",
      projectDir,
      "--name",
      "Scratch",
      "--slug",
      "scratch",
      "--yes",
      ...data,
    ]);
    expect(init.code === 0, `project init exited ${init.code}`);
    const started = runStep(env, [
      "workflow",
      "start",
      GOAL,
      "--model",
      MODEL,
      "--agent",
      "orchestrator",
      "--autonomous",
      "--budget-tokens",
      "300000",
      "--project",
      "scratch",
      ...data,
    ]);
    expect(started.code === 0, `workflow start exited ${started.code}`);
    expect(
      started.out.includes("writes     in git worktrees from main"),
      "the workflow does not write in worktrees",
    );
    console.log("PASS  workflow start: writes in git worktrees from main");

    const t0 = Date.now();
    const ran = runStep(env, ["run", "--project", "scratch", ...data], RUN_TIMEOUT_MS);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const list = runJson(env, ["workflow", "list", "--json", ...data]);
    const workflowId = list[0]?.workflowId;
    expect(typeof workflowId === "string", "no workflow was created");
    const tree = runStep(env, ["workflow", "show", workflowId, ...data]);
    expect(
      list[0].state === "completed",
      `the workflow ended ${list[0].state} (${list[0].stopReason ?? ""})`,
    );
    expect(ran.code === 0, `run exited ${ran.code ?? ran.signal}`);
    console.log(`PASS  run: the workflow completed without intervention in ${elapsed} s`);

    const shown = runJson(env, ["workflow", "show", workflowId, "--json", ...data]);
    const gitBlock = shown.git;
    expect(
      gitBlock?.integrationBranch === `haril/${workflowId}/integration`,
      "the snapshot names no integration branch",
    );
    expect(gitBlock.merged >= 2, `only ${gitBlock?.merged} steps were merged`);
    const integration = gitBlock.integrationBranch;
    const executors = shown.nodes.filter((node) => node.role === "executor");
    expect(executors.length >= 2, `${executors.length} executors ran`);
    console.log(`PASS  integration branch ${integration}: ${gitBlock.merged} steps merged`);

    // The executors ran together: their runs overlap in time.
    const rows = runJson(env, ["usage", "log", "--workflow", workflowId, "--json", ...data]).filter(
      (row) => row.table === "usage_log" && row.role === "executor",
    );
    const overlapping = rows.some((a) =>
      rows.some((b) => a.runId !== b.runId && a.startedAt < b.endedAt && b.startedAt < a.endedAt),
    );
    expect(overlapping, "the two executors never ran at the same time");
    console.log(
      `PASS  parallel: ${rows.length} executor runs, at least two of them at the same time`,
    );

    // The auditors ran the tests through haril_run.
    const events = runJson(env, [
      "events",
      "--project",
      "scratch",
      "--limit",
      "5000",
      "--json",
      ...data,
    ]);
    const commands = events.filter((event) => event.type === "workspace.command");
    const auditorTasks = new Set(
      runJson(env, ["usage", "log", "--workflow", workflowId, "--json", ...data])
        .filter((row) => row.table === "usage_log" && row.role === "auditor")
        .map((row) => row.taskId),
    );
    const byAuditors = commands.filter((event) => auditorTasks.has(event.taskId));
    expect(byAuditors.length >= 2, `${byAuditors.length} haril_run calls came from auditors`);
    console.log(
      `PASS  haril_run: ${commands.length} commands, ${byAuditors.length} by auditors (exit codes ${commands.map((event) => event.payload?.exitCode).join(", ")})`,
    );

    // The integration branch: its diff against main, and its tests in a checkout of its own.
    const diffStat = git(projectDir, "diff", "--stat", `main...${integration}`);
    const changed = git(projectDir, "diff", "--name-only", `main...${integration}`)
      .split(/\r?\n/)
      .filter(Boolean);
    for (const file of ["src/math.mjs", "src/text.mjs"]) {
      expect(changed.includes(file), `${file} did not change on the integration branch`);
    }
    const review = join(root, "review");
    git(projectDir, "worktree", "add", "--detach", "--quiet", review, integration);
    const tested = nodeTest(review);
    git(projectDir, "worktree", "remove", "--force", review);
    show(
      "node --test on the integration branch",
      `${tested.stdout ?? ""}${tested.stderr ?? ""}`,
      30,
    );
    expect(tested.status === 0, "the tests fail on the integration branch");
    const math = git(projectDir, "show", `${integration}:src/math.mjs`);
    const text = git(projectDir, "show", `${integration}:src/text.mjs`);
    expect(
      /multiply/.test(math) && /whisper/.test(text),
      "multiply or whisper is missing on the integration branch",
    );
    console.log("PASS  the integration branch holds both changes and its tests pass");

    expect(git(projectDir, "rev-parse", "main") === mainBefore, "main moved");
    expect(git(projectDir, "remote") === "", "the project has a remote");
    expect(!existsSync(unusedHome), "HARIL_HOME was used although --data-dir was given");
    console.log("PASS  main untouched, nothing pushed, nothing written outside the scratch folder");
    show("diff --stat main...integration", diffStat, 30);
    show("integration log", git(projectDir, "log", "--oneline", "--graph", integration), 30);
    show("tree", tree.out, 60);
    console.log(
      `PASS  writes real lane completed; review the branch: git -C "${projectDir}" log ${integration}`,
    );
    passed = true;
    return 0;
  } catch (error) {
    console.log(`FAIL  ${error.message}`);
    return 1;
  } finally {
    if (passed && CLEAN)
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else console.log(`      the scratch folder is kept: ${root}`);
  }
}

process.exitCode = main();
