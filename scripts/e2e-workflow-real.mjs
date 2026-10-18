#!/usr/bin/env node
// Real lane of the three-layer workflow (phase F2b, docs/modos-y-delegacion.md 9 F2 and 9.2): one small autonomous
// read-and-analysis workflow of real Pi agents (orchestrator, delegator, executors, auditors and the final auditor)
// through the installed Pi runtime, the Broker and a real model of the gateway (CLIProxyAPI). It is opt-in
// (npm run e2e:workflow-real), not part of npm test, and it never runs a local model. It runs only when everything it
// needs is present; otherwise it prints the reason and exits 0. A key is read from the environment only when the
// model's provider declares one, and it is never printed or stored. Everything it writes lives in one temporary folder:
// the data directory (--data-dir), an unused HARIL_HOME that must stay absent, and the fixture project. The folder is
// removed after a pass and kept after a failure, so its store and the Pi sessions can be read.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "apps", "haril", "dist", "haril.mjs");
const CHILD_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 1_500_000;
const GATEWAY_KEY_ENV = "HARIL_CLIPROXYAPI_KEY";
// The model of every agent of the workflow (each child runs on the orchestrator's model until the model catalog).
const MODEL =
  process.env.HARIL_E2E_WORKFLOW_MODEL ||
  process.env.HARIL_DEFAULT_MODEL ||
  "cliproxy/gemini-3-flash";
const FIXTURE = {
  "notes/planets.md": [
    "# Planets",
    "",
    "Mars has two moons, named Phobos and Deimos.",
    "Jupiter is the largest planet of the Solar System.",
    "",
  ].join("\n"),
  "notes/rivers.md": [
    "# Rivers",
    "",
    "The Nile flows north and ends in the Mediterranean Sea.",
    "The Amazon carries more water than any other river.",
    "",
  ].join("\n"),
};
const GOAL = [
  "Report the facts stated in the two notes of the notes folder: notes/planets.md and notes/rivers.md.",
  "Use one delegator for the whole folder; it assigns one executor per file, and each executor reads its file and",
  "quotes every fact it states. This is read-only work: nothing is written or changed.",
].join(" ");

// Same location rule as the CLI's runtime root (apps/haril/src/runtime.ts), without importing the bundle.
function runtimeRoot() {
  const env = process.env;
  if (env.HARIL_RUNTIME_DIR) return env.HARIL_RUNTIME_DIR;
  if (process.platform === "win32") {
    return win32.join(env.LOCALAPPDATA || win32.join(homedir(), "AppData", "Local"), "HARIL");
  }
  return posix.join(env.XDG_DATA_HOME || posix.join(homedir(), ".local", "share"), "haril");
}

// The environment variable that holds the key of the model's provider, or undefined when that provider needs none
// (the rule of scripts/e2e-real.mjs).
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

// Prints a step's output so a failure can be diagnosed. The CLI never prints a key.
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

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Every file under dir, relative to it, with its SHA-256; .haril (the project's HARIL folder) is left out.
function snapshot(dir, prefix = "") {
  const out = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (relative === ".haril") continue;
    if (entry.isDirectory()) Object.assign(out, snapshot(dir, relative));
    else out[relative] = digest(join(dir, relative));
  }
  return out;
}

function main() {
  const reason = skipReason();
  if (reason !== undefined) {
    console.log(`SKIP workflow real lane: ${reason}`);
    return 0;
  }
  if (!existsSync(ENTRY)) {
    console.log(`FAIL  ${ENTRY} is missing: run npm run build first`);
    return 1;
  }

  const root = mkdtempSync(join(tmpdir(), "haril-e2e-workflow-"));
  let passed = false;
  try {
    const dataDir = join(root, "data");
    const unusedHome = join(root, "home-unused");
    const projectDir = join(root, "notes-project");
    for (const [file, text] of Object.entries(FIXTURE)) {
      mkdirSync(dirname(join(projectDir, file)), { recursive: true });
      writeFileSync(join(projectDir, file), text);
    }
    const before = snapshot(projectDir);
    // Pi gets the test seam only in the hermetic lane; the real lane must never set it.
    const env = { ...process.env, HARIL_HOME: unusedHome };
    delete env.HARIL_PI_CLI_OVERRIDE;
    const data = ["--data-dir", dataDir];
    console.log(`      model ${MODEL}; scratch folder ${root}`);

    // The gateway must answer before any agent runs: an unreachable one is reported as such, never faked.
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
      "Notes",
      "--slug",
      "notes",
      "--yes",
      ...data,
    ]);
    expect(init.code === 0, `project init exited ${init.code}`);
    const start = runJson(env, [
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
      "notes",
      "--json",
      ...data,
    ]);
    expect(start.status === "queued", `workflow start answered ${JSON.stringify(start)}`);
    console.log("PASS  project init, workflow start --agent orchestrator --autonomous");

    const ran = runStep(env, ["run", "--project", "notes", ...data], RUN_TIMEOUT_MS);
    const list = runJson(env, ["workflow", "list", "--json", ...data]);
    const workflowId = list[0]?.workflowId;
    expect(typeof workflowId === "string", "no workflow was created");
    const tree = runStep(env, ["workflow", "show", workflowId, ...data]);
    expect(ran.code === 0, `run exited ${ran.code ?? ran.signal}`);
    expect(list[0].state === "completed", `the workflow ended ${list[0].state}`);
    console.log("PASS  run: the workflow completed without intervention");

    // WorkflowSnapshot v1: one node per thread; executor e<n> is judged by auditor a<n>, the final auditor is fa.
    const shown = runJson(env, ["workflow", "show", workflowId, "--json", ...data]);
    const nodes = shown.nodes;
    const of = (role) => nodes.filter((node) => node.role === role);
    const delegators = of("delegator");
    const executors = of("executor");
    const finalAudit = nodes.find((node) => node.id === "fa");
    expect(delegators.length >= 1, "no delegator ran");
    expect(executors.length >= 1, "no executor ran");
    for (const executor of executors) {
      const auditor = nodes.find((node) => node.id === `a${executor.id.slice(1)}`);
      expect(auditor?.role === "auditor", `executor ${executor.id} has no auditor`);
      expect(executor.audit?.verdict === "approved", `executor ${executor.id} was not approved`);
      expect(executor.files.write.length === 0, `executor ${executor.id} has a write surface`);
    }
    expect(finalAudit?.audit?.verdict === "approved", "the final auditor did not approve");
    expect(
      nodes.every((node) => node.state === "done"),
      `a node did not end done: ${nodes.map((node) => `${node.id} ${node.state}`).join(", ")}`,
    );
    console.log(
      `PASS  tree: ${delegators.length} delegator(s), ${executors.length} executor(s) each approved by its auditor, final audit approved`,
    );

    const rows = runJson(env, ["usage", "log", "--workflow", workflowId, "--json", ...data]).filter(
      (row) => row.table === "usage_log",
    );
    const totals = rows.reduce(
      (sum, row) => ({ in: sum.in + (row.tokensIn ?? 0), out: sum.out + (row.tokensOut ?? 0) }),
      { in: 0, out: 0 },
    );
    // Every thread ran at least one turn, and every turn's run left exactly one row.
    expect(rows.length >= nodes.length, `${rows.length} usage rows for ${nodes.length} threads`);
    expect(
      new Set(rows.map((row) => row.runId)).size === rows.length,
      "a run left more than one usage row",
    );
    expect(
      rows.every((row) => row.kind === "agent_run" && row.simulated === false),
      "a usage row is not a real agent run",
    );
    expect(
      rows.every((row) => typeof row.tokensIn === "number" && row.tokensIn > 0),
      "a usage row carries no ledger tokens",
    );
    console.log(
      `PASS  usage: ${rows.length} agent_run rows, input ${totals.in}, output ${totals.out} tokens`,
    );

    // The work was read, not invented: every executor read a file through the bridge (tool.read events carry the
    // path's hash only), and what the executors answered carries the fixture's facts.
    const events = runJson(env, [
      "events",
      "--project",
      "notes",
      "--limit",
      "5000",
      "--json",
      ...data,
    ]);
    const readsOf = (runId) =>
      events.filter(
        (event) =>
          event.runId === runId && event.type === "tool.read" && event.payload?.outcome === "ok",
      ).length;
    const executorRuns = new Map();
    for (const row of rows.filter((item) => item.role === "executor")) {
      executorRuns.set(row.threadId, [...(executorRuns.get(row.threadId) ?? []), row]);
    }
    for (const [thread, runs] of executorRuns) {
      expect(
        runs.some((row) => readsOf(row.runId) > 0),
        `executor thread ${thread} never read a file through the bridge`,
      );
    }
    const answers = [];
    for (const runs of executorRuns.values()) {
      const shownTask = runJson(env, [
        "task",
        "show",
        runs[runs.length - 1].taskId,
        "--json",
        ...data,
      ]);
      answers.push(String(shownTask.result?.text ?? ""));
    }
    const answered = answers.join("\n");
    expect(
      /Phobos|Deimos/.test(answered) && /Nile/.test(answered),
      "the executors' results do not carry the facts of the notes",
    );
    const calls = events.filter((event) => event.type.startsWith("tool.haril_"));
    const refused = calls.filter((event) => event.payload?.outcome !== "ok").length;
    console.log(
      `PASS  reads: every executor read its file through the bridge (${events.filter((event) => event.type === "tool.read").length} reads); ${calls.length - refused} delegation calls accepted, ${refused} refused and corrected`,
    );
    for (const answer of answers) show("executor result", answer, 12);

    const verify = runStep(env, ["usage", "verify", ...data]);
    expect(verify.code === 0, `usage verify exited ${verify.code}`);
    console.log("PASS  usage verify: both chains ok");

    const after = snapshot(projectDir);
    expect(
      JSON.stringify(after) === JSON.stringify(before),
      "the fixture changed: a workflow agent wrote a file",
    );
    expect(!existsSync(unusedHome), "HARIL_HOME was used although --data-dir was given");
    console.log("PASS  fixture unchanged; nothing written outside the data directory");
    console.log("PASS  workflow real lane completed");
    show("tree", tree.out, 60);
    passed = true;
    return 0;
  } catch (error) {
    console.log(`FAIL  ${error.message}`);
    return 1;
  } finally {
    if (passed) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else console.log(`      the scratch folder is kept for inspection: ${root}`);
  }
}

process.exitCode = main();
