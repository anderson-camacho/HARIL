#!/usr/bin/env node
// Real check of the emergency stop (phase F3, docs/modos-y-delegacion.md 3.14 and the F3 stop of section 9): a small
// real workflow of Pi agents runs through the installed Pi runtime, the Broker and a real model of the gateway
// (CLIProxyAPI); while its agents run, `haril stop --now` must leave no agent process alive. The proof does not trust
// the CLI: it reads the pids the runs recorded straight from the store, and it lists the operating system's processes
// whose command line names this run's scratch folder (every Pi process gets its session folder there). It is opt-in
// (npm run e2e:stop-real), not part of npm test, and it never runs a local model. It runs only when everything it needs
// is present; otherwise it prints the reason and exits 0. A key is read from the environment only when the model's
// provider declares one, and it is never printed or stored. Everything lives in one temporary folder, removed after a
// pass and kept after a failure.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "apps", "haril", "dist", "haril.mjs");
const CHILD_TIMEOUT_MS = 60_000;
const AGENTS_WAIT_MS = 240_000;
const STOP_BUDGET_MS = 2_000;
const GATEWAY_KEY_ENV = "HARIL_CLIPROXYAPI_KEY";
const MODEL =
  process.env.HARIL_E2E_WORKFLOW_MODEL ||
  process.env.HARIL_DEFAULT_MODEL ||
  "cliproxy/gemini-3-flash";
// Enough reading for two delegators with two executors each, so several agents are in flight when the stop comes.
const NOTES = {
  "notes/planets.md":
    "# Planets\n\nMars has two moons, named Phobos and Deimos.\nJupiter is the largest planet.\n",
  "notes/rivers.md":
    "# Rivers\n\nThe Nile flows north into the Mediterranean.\nThe Amazon carries the most water.\n",
  "notes/mountains.md":
    "# Mountains\n\nEverest is the highest mountain above sea level.\nK2 is the second highest.\n",
  "notes/deserts.md":
    "# Deserts\n\nThe Sahara is the largest hot desert.\nAntarctica is the largest cold desert.\n",
};
const GOAL = [
  "Report every fact stated in the four notes of the notes folder.",
  "Use two delegators: one for planets.md and rivers.md, one for mountains.md and deserts.md; each delegator assigns",
  "one executor per file, and each executor reads its file and quotes every fact. Read-only work: nothing is written.",
].join(" ");

function runtimeRoot() {
  const env = process.env;
  if (env.HARIL_RUNTIME_DIR) return env.HARIL_RUNTIME_DIR;
  if (process.platform === "win32") {
    return win32.join(env.LOCALAPPDATA || win32.join(homedir(), "AppData", "Local"), "HARIL");
  }
  return posix.join(env.XDG_DATA_HOME || posix.join(homedir(), ".local", "share"), "haril");
}

// The rule of scripts/e2e-workflow-real.mjs: the variable that holds the key of the model's provider, if any.
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

function haril(env, args, timeoutMs = CHILD_TIMEOUT_MS) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function show(label, text, maxLines = 40) {
  if (text.trim() === "") return;
  const lines = text.trimEnd().split("\n");
  console.log(`      ${label}:`);
  for (const line of lines.slice(-maxLines)) console.log(`        ${line}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The OS processes whose command line names this run's scratch folder: the Pi agents (their --session-dir lives under
// the data folder) and the runtime (its --data-dir). A read-only listing; nothing is killed by it.
function processesNaming(root) {
  if (process.platform === "win32") {
    const powershell = join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${root}') } | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }`;
    const out =
      spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
      }).stdout ?? "";
    return out
      .split(/\r?\n/)
      .filter((line) => line.includes("|"))
      .map((line) => {
        const [pid, ppid, name] = line.trim().split("|");
        return { pid: Number(pid), ppid: Number(ppid), name };
      });
  }
  const out = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .filter((line) => line.includes(root))
    .map((line) => {
      const [pid, ppid, ...args] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), name: args[0] };
    });
}

// The store, read only: the pids the runs recorded, the workflow, the tasks, the halt and the open reservations.
function readStore(dataDir) {
  const db = new DatabaseSync(join(dataDir, "haril.db"), { readOnly: true });
  try {
    const runs = db
      .prepare(
        "SELECT run_id AS runId, status, pid, pid_started_at AS startedAt FROM runs WHERE pid IS NOT NULL",
      )
      .all();
    const workflows = db
      .prepare("SELECT workflow_id AS workflowId, state, stop_reason AS stopReason FROM workflows")
      .all();
    const tasks = db
      .prepare(
        "SELECT state, COUNT(*) AS n FROM tasks WHERE workflow_id IS NOT NULL GROUP BY state",
      )
      .all();
    const halted =
      db.prepare("SELECT value FROM meta WHERE key = 'runtime.halted'").get() !== undefined;
    const open = db
      .prepare(
        "SELECT COUNT(DISTINCT reservation_id) AS n FROM budget_ledger WHERE kind = 'reserve' AND reservation_id NOT IN (SELECT reservation_id FROM budget_ledger WHERE kind IN ('commit','release'))",
      )
      .get().n;
    return { runs, workflows, tasks, halted, openReservations: Number(open) };
  } finally {
    db.close();
  }
}

async function main() {
  const reason = skipReason();
  if (reason !== undefined) {
    console.log(`SKIP stop real check: ${reason}`);
    return 0;
  }
  if (!existsSync(ENTRY)) {
    console.log(`FAIL  ${ENTRY} is missing: run npm run build first`);
    return 1;
  }
  const root = mkdtempSync(join(tmpdir(), "haril-e2e-stop-"));
  let runtime;
  let passed = false;
  try {
    const dataDir = join(root, "data");
    const projectDir = join(root, "notes-project");
    for (const [file, text] of Object.entries(NOTES)) {
      mkdirSync(dirname(join(projectDir, file)), { recursive: true });
      writeFileSync(join(projectDir, file), text);
    }
    const env = { ...process.env, HARIL_HOME: join(root, "home-unused") };
    delete env.HARIL_PI_CLI_OVERRIDE;
    const data = ["--data-dir", dataDir];
    console.log(`      model ${MODEL}; scratch folder ${root}`);

    const provider = MODEL.split("/")[0];
    const models = haril(env, ["models", "--provider", provider, "--json"]);
    if (models.code !== 0) {
      console.log(
        `PARTIAL the gateway of provider ${provider} is not reachable (haril models exited ${models.code})`,
      );
      return 2;
    }
    console.log(`PASS  the gateway of provider ${provider} answers`);
    expect(
      haril(env, [
        "project",
        "init",
        projectDir,
        "--name",
        "Notes",
        "--slug",
        "notes",
        "--yes",
        ...data,
      ]).code === 0,
      "project init failed",
    );
    const started = haril(env, [
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
    expect(started.code === 0, `workflow start exited ${started.code}: ${started.err}`);

    // The runtime runs in the background, as haril start does for the console.
    const out = [];
    runtime = spawn(process.execPath, [ENTRY, "start", "--idle-exit-sec", "60", ...data], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runtime.stdout.on("data", (chunk) => out.push(chunk.toString("utf8")));
    runtime.stderr.on("data", (chunk) => out.push(chunk.toString("utf8")));
    const exited = new Promise((resolve) => runtime.once("exit", (code) => resolve(code)));

    // Wait for agents in flight: the more the better, at least two Pi processes (the orchestrator plays first).
    const deadline = Date.now() + AGENTS_WAIT_MS;
    let inFlight = [];
    let best = [];
    while (Date.now() < deadline && runtime.exitCode === null) {
      inFlight = readStore(dataDir).runs.filter(
        (run) => run.status === "running" && alive(run.pid),
      );
      if (inFlight.length > best.length) best = inFlight;
      if (inFlight.length >= 3) break;
      if (inFlight.length >= 2 && Date.now() > deadline - AGENTS_WAIT_MS / 2) break;
      await sleep(250);
    }
    if (inFlight.length === 0) inFlight = best;
    expect(runtime.exitCode === null, `the runtime exited before the stop:\n${out.join("")}`);
    expect(inFlight.length >= 1, "no agent was running in time");
    const before = processesNaming(root);
    const agentsBefore = before.filter((item) => item.pid !== runtime.pid);
    console.log(
      `PASS  ${inFlight.length} agents in flight (pids ${inFlight.map((run) => run.pid).join(", ")}); ${agentsBefore.length} processes name the scratch folder besides the runtime (pid ${runtime.pid})`,
    );

    // The stop runs as the user would type it, while this script watches the recorded pids die.
    const watched = readStore(dataDir)
      .runs.filter((run) => run.status === "running")
      .map((run) => run.pid);
    const stopAt = Date.now();
    const stopChild = spawn(process.execPath, [ENTRY, "stop", "--now", "--json", ...data], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stopOut = [];
    stopChild.stdout.on("data", (chunk) => stopOut.push(chunk.toString("utf8")));
    stopChild.stderr.on("data", (chunk) => stopOut.push(chunk.toString("utf8")));
    const stopExit = new Promise((resolve) =>
      stopChild.once("exit", (exitCode) => resolve(exitCode)),
    );
    let goneMs = null;
    while (Date.now() - stopAt < 15_000) {
      if (goneMs === null && watched.every((pid) => !alive(pid))) goneMs = Date.now() - stopAt;
      if (goneMs !== null && stopChild.exitCode !== null) break;
      await sleep(20);
    }
    const stopCode = await stopExit;
    const stopMs = Date.now() - stopAt;
    const stop = { code: stopCode, out: stopOut.join("") };
    show("stop --now", stop.out);
    expect(stop.code === 0, `stop --now exited ${stop.code}`);
    const report = JSON.parse(stop.out.trim().split(/\r?\n/).pop());
    // Every pid any run recorded, read again after the stop.
    const recorded = readStore(dataDir).runs.map((run) => run.pid);
    const after = processesNaming(root).filter((item) => item.pid !== runtime.pid);
    const code = await Promise.race([exited, sleep(10_000).then(() => "still running")]);
    const state = readStore(dataDir);
    console.log(
      `      stop --now returned in ${stopMs} ms; the ${watched.length} agents in flight were gone ${goneMs} ms after the command; runtime exit ${code}`,
    );
    console.log(
      `      recorded agent pids: ${recorded.join(", ") || "(none)"}; alive now: ${recorded.filter(alive).join(", ") || "none"}`,
    );
    console.log(
      `      OS processes naming the scratch folder after the stop: ${after.length === 0 ? "none" : after.map((item) => `${item.pid} ${item.name}`).join(", ")}`,
    );
    expect(
      recorded.every((pid) => !alive(pid)),
      "a recorded agent process is still alive",
    );
    expect(after.length === 0, "a process naming the scratch folder is still alive");
    expect(
      goneMs !== null && goneMs <= STOP_BUDGET_MS,
      `the agents took ${goneMs} ms to die (budget ${STOP_BUDGET_MS} ms)`,
    );
    expect(code === 0, `the runtime exited ${code}`);
    expect(
      report.runtime === "stopped" && report.processes.alive === 0,
      `stop --now reported ${stop.out}`,
    );
    console.log(
      `PASS  no agent process left: the recorded pids and the OS list agree (${goneMs} ms)`,
    );

    const workflow = state.workflows[0];
    const live = state.tasks.filter((row) => ["pending", "ready", "running"].includes(row.state));
    expect(
      workflow?.state === "stopped" && workflow.stopReason === "user_stop",
      `the workflow is ${JSON.stringify(workflow)}`,
    );
    expect(live.length === 0, `turns left live: ${JSON.stringify(state.tasks)}`);
    expect(state.halted, "the runtime is not halted");
    expect(state.openReservations === 0, `${state.openReservations} reservations left open`);
    expect(
      state.runs.every((run) => run.status !== "running"),
      "a run is still open",
    );
    console.log(
      `PASS  store: workflow stopped (user_stop), turns ${state.tasks.map((row) => `${row.state} ${row.n}`).join(", ")}, runtime halted, no open reservation`,
    );

    const again = haril(env, ["stop", "--now", ...data]);
    expect(
      again.code === 0 && again.out.includes("already halted"),
      `the second stop answered ${again.out}`,
    );
    const resume = haril(env, ["resume", ...data]);
    expect(resume.code === 0, `resume exited ${resume.code}`);
    const verify = haril(env, ["usage", "verify", ...data]);
    expect(verify.code === 0, `usage verify exited ${verify.code}`);
    console.log("PASS  a second stop is harmless; resume is queued; usage verify: both chains ok");
    show("runtime", out.join(""), 25);
    passed = true;
    return 0;
  } catch (error) {
    console.log(`FAIL  ${error.message}`);
    return 1;
  } finally {
    // Never leave this run's own processes behind: the runtime child, and any process naming this unique folder.
    if (runtime !== undefined && runtime.exitCode === null && runtime.pid !== undefined) {
      if (process.platform === "win32") {
        const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
        spawnSync(taskkill, ["/F", "/T", "/PID", String(runtime.pid)], { windowsHide: true });
      } else {
        runtime.kill("SIGKILL");
      }
    }
    if (!passed) {
      for (const item of processesNaming(root)) {
        try {
          process.kill(item.pid, "SIGKILL");
        } catch {}
      }
    }
    if (passed) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else console.log(`      the scratch folder is kept for inspection: ${root}`);
  }
}

process.exitCode = await main();
