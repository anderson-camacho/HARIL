import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  commandLine,
  nodeStatus,
  parseInstallArgs,
  planSteps,
  resolveRoot,
  runInstall,
  spawnStep,
} from "../install.mjs";

// One-command installer (haril-installer). Every run goes through an injected command runner, so nothing here
// installs, builds or downloads anything. The wrapper tests only call `--help` or a run without node on PATH.

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const LINUX = Object.freeze({
  platform: "linux",
  env: Object.freeze({ HOME: "/home/ana", PATH: "/usr/bin:/bin" }),
  homeDir: "/home/ana",
  cwd: "/home/ana/haril",
  repoRoot: "/home/ana/haril",
  nodeVersion: "24.21.0",
  nodeExe: "/usr/bin/node",
});

const WINDOWS = Object.freeze({
  platform: "win32",
  env: Object.freeze({ LOCALAPPDATA: "C:\\Users\\Ana\\AppData\\Local", PATH: "C:\\Windows" }),
  homeDir: "C:\\Users\\Ana",
  cwd: "C:\\src\\haril",
  repoRoot: "C:\\src\\haril",
  nodeVersion: "24.21.0",
  nodeExe: "C:\\Program Files\\nodejs\\node.exe",
});

// Runs the installer with a fake runner. `results` maps a step id to what the runner returns for it.
async function install(argv, host = LINUX, results = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const code = await runInstall(argv, {
    exists: () => true,
    ...host,
    run: async (step) => {
      calls.push(step);
      return results[step.id] ?? { code: 0, signal: null };
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, calls, out: out.join("\n"), err: err.join("\n") };
}

test("flags: defaults, --no-runtime, --root in both forms, --dry-run and --help", () => {
  assert.deepEqual(parseInstallArgs([]), {
    ok: true,
    options: { runtime: true, dryRun: false, help: false },
  });
  assert.deepEqual(parseInstallArgs(["--no-runtime", "--dry-run", "--root", "x"]), {
    ok: true,
    options: { runtime: false, dryRun: true, help: false, root: "x" },
  });
  assert.equal(parseInstallArgs(["--root=y"]).options.root, "y");
  assert.equal(parseInstallArgs(["-h"]).options.help, true);
  assert.equal(parseInstallArgs(["--help"]).options.help, true);
});

test("flags: unknown arguments and a --root without a value are usage errors", () => {
  assert.match(parseInstallArgs(["--yes"]).message, /unknown argument: --yes/);
  assert.match(parseInstallArgs(["--root"]).message, /--root needs a directory/);
  assert.match(parseInstallArgs(["--root", "--dry-run"]).message, /--root needs a directory/);
  assert.match(parseInstallArgs(["--root="]).message, /--root needs a directory/);
});

test("node version: the root engines range, with a 24.x below it only a warning, as doctor treats it", () => {
  for (const version of ["24.21.0", "v24.25.1", "26.8.0", "27.0.0"]) {
    assert.equal(nodeStatus(version), "ok", version);
  }
  for (const version of ["24.19.0", "v24.0.0"]) assert.equal(nodeStatus(version), "warn", version);
  for (const version of ["22.12.0", "25.2.0", "26.7.9", "not-a-version"]) {
    assert.equal(nodeStatus(version), "error", version);
  }
});

test("root: --root resolved against the cwd, then HARIL_RUNTIME_DIR, then the platform default", () => {
  assert.equal(resolveRoot({ ...LINUX, flag: "../tmp/h" }), "/home/ana/tmp/h");
  assert.equal(
    resolveRoot({ ...LINUX, env: { ...LINUX.env, HARIL_RUNTIME_DIR: "/opt/h" } }),
    "/opt/h",
  );
  // A relative HARIL_RUNTIME_DIR is resolved once, against the cwd, so every child gets the same root.
  assert.equal(
    resolveRoot({ ...LINUX, env: { ...LINUX.env, HARIL_RUNTIME_DIR: "hr" } }),
    "/home/ana/haril/hr",
  );
  assert.equal(resolveRoot(LINUX), "/home/ana/.local/share/haril");
  assert.equal(
    resolveRoot({ ...LINUX, env: { ...LINUX.env, XDG_DATA_HOME: "/data" } }),
    "/data/haril",
  );
  assert.equal(resolveRoot(WINDOWS), "C:\\Users\\Ana\\AppData\\Local\\HARIL");
});

test("plan on POSIX: seven steps, the runtime before the CLI and visual tools after it", () => {
  const root = "/home/ana/.local/share/haril";
  const steps = planSteps({ ...LINUX, root, runtime: true });
  assert.deepEqual(
    steps.map((step) => step.id),
    ["preflight", "deps", "build", "runtime", "app", "visuals", "doctor"],
  );
  const byId = Object.fromEntries(steps.map((step) => [step.id, step]));
  assert.deepEqual([byId.preflight.command, ...byId.preflight.args], ["corepack", "--version"]);
  assert.deepEqual(
    [byId.deps.command, ...byId.deps.args],
    ["corepack", "pnpm", "install", "--frozen-lockfile"],
  );
  assert.deepEqual([byId.build.command, ...byId.build.args], ["corepack", "pnpm", "run", "build"]);
  assert.deepEqual(
    [byId.runtime.command, ...byId.runtime.args],
    ["/usr/bin/node", "apps/bootstrap/dist/haril-bootstrap.mjs", "install-runtime", "--root", root],
  );
  assert.deepEqual(
    [byId.app.command, ...byId.app.args],
    [
      "/usr/bin/node",
      "apps/bootstrap/dist/haril-bootstrap.mjs",
      "install",
      "--root",
      root,
      "--from",
      LINUX.repoRoot,
    ],
  );
  assert.deepEqual(
    [byId.doctor.command, ...byId.doctor.args],
    ["/home/ana/.local/share/haril/bin/haril", "doctor"],
  );
  assert.deepEqual(
    [byId.visuals.command, ...byId.visuals.args],
    ["/usr/bin/node", "scripts/install-visual-tools.mjs", "--root", root],
  );
  assert.equal(byId.doctor.env.HARIL_RUNTIME_DIR, root);
  for (const step of steps) {
    assert.equal(step.shell, false, step.id);
    assert.equal(step.cwd, LINUX.repoRoot, step.id);
  }
});

test("plan on Windows: corepack and the haril.cmd launcher go through the shell", () => {
  const root = "C:\\Users\\Ana\\AppData\\Local\\HARIL";
  const steps = planSteps({ ...WINDOWS, root, runtime: true });
  const byId = Object.fromEntries(steps.map((step) => [step.id, step]));
  assert.equal(byId.doctor.command, `${root}\\bin\\haril.cmd`);
  for (const id of ["preflight", "deps", "build", "doctor"]) assert.equal(byId[id].shell, true, id);
  for (const id of ["runtime", "app", "visuals"]) {
    assert.equal(byId[id].shell, false, id);
    assert.equal(byId[id].command, WINDOWS.nodeExe, id);
  }
});

test("shell command lines quote paths with spaces", () => {
  assert.equal(
    commandLine("C:\\Users\\Ana Lopez\\HARIL\\bin\\haril.cmd", ["doctor"]),
    '"C:\\Users\\Ana Lopez\\HARIL\\bin\\haril.cmd" doctor',
  );
  assert.equal(
    commandLine("corepack", ["pnpm", "install", "--frozen-lockfile"]),
    "corepack pnpm install --frozen-lockfile",
  );
});

test("a full run executes every step once, in order, and prints the launcher and next steps", async () => {
  const run = await install([]);
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(
    run.calls.map((step) => step.id),
    ["preflight", "deps", "build", "runtime", "app", "visuals", "doctor"],
  );
  for (const [index, title] of [
    [1, "Check Node and corepack"],
    [2, "Install dependencies"],
    [3, "Build"],
    [4, "Install the Pi runtime"],
    [5, "Install the HARIL CLI"],
    [6, "Install Matrix visual tools"],
    [7, "Check the install with doctor"],
  ]) {
    assert.match(run.out, new RegExp(`\\[${index}/7\\] ${title}`));
  }
  assert.match(run.out, /\/home\/ana\/\.local\/share\/haril\/bin\/haril/);
  assert.match(run.out, /export PATH="\$HOME\/\.local\/share\/haril\/bin:\$PATH"/);
  assert.match(run.out, /HARIL_CLIPROXYAPI_KEY/);
});

test("Windows points to the user environment dialog and prints a session-only PATH line", async () => {
  const run = await install([], WINDOWS);
  assert.equal(run.code, 0, run.err);
  // [Environment]::SetEnvironmentVariable would rewrite a REG_EXPAND_SZ user Path as an expanded REG_SZ.
  assert.doesNotMatch(run.out, /SetEnvironmentVariable/);
  assert.match(run.out, /rundll32 sysdm\.cpl,EditEnvironmentVariables/);
  assert.ok(
    run.out.includes("$env:Path += ';C:\\Users\\Ana\\AppData\\Local\\HARIL\\bin'"),
    run.out,
  );
  assert.ok(run.out.includes("& 'C:\\Users\\Ana\\AppData\\Local\\HARIL\\bin\\haril.cmd'"), run.out);
});

test("POSIX quotes a launcher path with spaces in the next steps", async () => {
  const run = await install(["--root", "/opt/my haril"]);
  assert.equal(run.code, 0, run.err);
  assert.ok(run.out.includes("'/opt/my haril/bin/haril'"), run.out);
  assert.ok(run.out.includes('export PATH="/opt/my haril/bin:$PATH"'), run.out);
});

test("a bin directory already on PATH gets no PATH line", async () => {
  const env = { ...LINUX.env, PATH: "/home/ana/.local/share/haril/bin:/usr/bin" };
  const run = await install([], { ...LINUX, env });
  assert.equal(run.code, 0, run.err);
  assert.doesNotMatch(run.out, /export PATH=/);
  assert.match(run.out, /already on PATH/);
});

test("--no-runtime skips install-runtime and still installs the CLI", async () => {
  const run = await install(["--no-runtime"]);
  assert.equal(run.code, 0, run.err);
  assert.deepEqual(
    run.calls.map((step) => step.id),
    ["preflight", "deps", "build", "app", "visuals", "doctor"],
  );
  assert.ok(run.calls.every((step) => !step.args.includes("install-runtime")));
  assert.match(run.out, /\[4\/7\] Install the Pi runtime.*skipped.*--no-runtime/);
});

test("--root goes to both bootstrap commands, and doctor gets HARIL_RUNTIME_DIR for it", async () => {
  const run = await install(["--root", "../tmp/h"]);
  assert.equal(run.code, 0, run.err);
  const byId = Object.fromEntries(run.calls.map((step) => [step.id, step]));
  for (const id of ["runtime", "app"]) {
    const at = byId[id].args.indexOf("--root");
    assert.equal(byId[id].args[at + 1], "/home/ana/tmp/h", id);
  }
  assert.equal(byId.doctor.command, "/home/ana/tmp/h/bin/haril");
  assert.equal(byId.doctor.env.HARIL_RUNTIME_DIR, "/home/ana/tmp/h");
  assert.match(run.out, /HARIL_RUNTIME_DIR/);
});

test("--dry-run prints every command and runs nothing", async () => {
  const run = await install(["--dry-run", "--root", "/opt/h"]);
  assert.equal(run.code, 0, run.err);
  assert.equal(run.calls.length, 0);
  assert.match(run.out, /dry run/);
  assert.match(run.out, /corepack pnpm install --frozen-lockfile/);
  assert.match(run.out, /corepack pnpm run build/);
  assert.match(run.out, /install-runtime --root \/opt\/h/);
  assert.match(run.out, /\/opt\/h\/bin\/haril doctor/);
});

test("--help prints the usage and runs nothing; a usage error exits 2", async () => {
  const help = await install(["--help"]);
  assert.equal(help.code, 0);
  assert.equal(help.calls.length, 0);
  assert.match(help.out, /usage: /);
  assert.match(help.out, /--no-runtime/);

  const bad = await install(["--force"]);
  assert.equal(bad.code, 2);
  assert.equal(bad.calls.length, 0);
  assert.match(bad.err, /unknown argument: --force/);
});

test("a Node outside the range exits 2 with how to get Node 24, and runs nothing", async () => {
  const run = await install([], { ...LINUX, nodeVersion: "22.12.0" });
  assert.equal(run.code, 2);
  assert.equal(run.calls.length, 0);
  assert.match(run.err, /\^24\.21\.0 \|\| >=26\.8\.0/);
  assert.match(run.err, /nodejs\.org/);
});

test("Node 24.19 warns and keeps going", async () => {
  const run = await install([], { ...LINUX, nodeVersion: "24.19.0" });
  assert.equal(run.code, 0, run.err);
  assert.match(`${run.out}\n${run.err}`, /warning: .*24\.19\.0/);
  assert.equal(run.calls.length, 7);
});

test("a missing corepack exits 2 before anything is installed", async () => {
  const run = await install([], LINUX, {
    preflight: { code: null, signal: null, error: "spawn corepack ENOENT" },
  });
  assert.equal(run.code, 2);
  assert.deepEqual(
    run.calls.map((step) => step.id),
    ["preflight"],
  );
  assert.match(run.err, /corepack/);
});

test("a failing step stops the run and names the step and its exit code", async () => {
  const run = await install([], LINUX, { build: { code: 3, signal: null } });
  assert.equal(run.code, 1);
  assert.deepEqual(
    run.calls.map((step) => step.id),
    ["preflight", "deps", "build"],
  );
  assert.match(run.err, /step 3\/7 "Build" failed with exit code 3/);
});

test("a failing runtime step suggests --no-runtime to get the CLI alone", async () => {
  const run = await install([], LINUX, { runtime: { code: 1, signal: null } });
  assert.equal(run.code, 1);
  assert.match(run.err, /step 4\/7 .* failed with exit code 1/);
  assert.match(run.err, /--no-runtime/);
});

test("a step that cannot start or is stopped by a signal also stops the run", async () => {
  const notFound = await install([], LINUX, { deps: { code: null, signal: null, error: "boom" } });
  assert.equal(notFound.code, 1);
  assert.match(notFound.err, /step 2\/7 "Install dependencies" could not start: boom/);

  const stopped = await install([], LINUX, { app: { code: null, signal: "SIGINT" } });
  assert.equal(stopped.code, 1);
  assert.match(stopped.err, /step 5\/7 "Install the HARIL CLI" was stopped by SIGINT/);
});

test("doctor warnings still count as installed; doctor errors fail step 6", async () => {
  const warned = await install([], LINUX, { doctor: { code: 1, signal: null } });
  assert.equal(warned.code, 0, warned.err);
  assert.match(warned.out, /doctor reported warnings/);

  const failed = await install([], LINUX, { doctor: { code: 2, signal: null } });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /step 7\/7 "Check the install with doctor" failed with exit code 2/);
});

test("a missing launcher fails step 6 instead of reading as a doctor warning", async () => {
  const run = await install([], { ...WINDOWS, exists: () => false });
  assert.equal(run.code, 1);
  assert.ok(run.calls.every((step) => step.id !== "doctor"));
  assert.match(run.err, /step 7\/7 .* found no launcher at .*haril\.cmd/);
});

test("no PATH edit: the installer has no write path at all", () => {
  const source = readFileSync(join(REPO, "scripts", "install.mjs"), "utf8");
  // The node:fs imports only read: nothing is written, appended or created.
  assert.deepEqual(
    [...source.matchAll(/import \{([^}]*)\} from "node:fs"/g)].map((match) => match[1].trim()),
    ["existsSync, realpathSync"],
  );
  assert.doesNotMatch(source, /process\.env(\.\w+|\[[^\]]*\])?\s*\+?=(?!=)/);
  assert.doesNotMatch(source, /Object\.assign\(\s*process\.env/);
  assert.doesNotMatch(source, /\b(setx|reg add|SetEnvironmentVariable|New-ItemProperty|sudo)\b/i);
});

test("no PATH edit: no step touches PATH, the registry or a shell profile, and PATH reaches children unchanged", async () => {
  for (const host of [LINUX, WINDOWS]) {
    for (const argv of [[], ["--root", "x"]]) {
      // The host env is frozen, so any write to it would throw.
      const run = await install(argv, host);
      assert.equal(run.code, 0, run.err);
      for (const step of run.calls) {
        const line = [step.command, ...step.args].join(" ");
        assert.doesNotMatch(
          line,
          /setx|reg(\.exe)?\s|SetEnvironmentVariable|\.profile|\.bashrc|\.zshrc|sudo/i,
        );
        assert.equal(step.env.PATH, host.env.PATH, step.id);
      }
    }
  }
});

// The real runner: exit codes come back with and without the shell, and a missing command is an error.
test("spawnStep reports exit codes, through the shell too, and start errors", async () => {
  const exit3 = { command: process.execPath, args: ["-e", "process.exit(3)"], cwd: REPO };
  const step = { ...exit3, env: process.env, shell: false };
  assert.deepEqual(await spawnStep(step), { code: 3, signal: null });
  assert.deepEqual(await spawnStep({ ...step, shell: true }), { code: 3, signal: null });
  const missing = await spawnStep({ ...step, command: join(REPO, "no-such-command") });
  assert.equal(missing.code, null);
  assert.match(missing.error, /ENOENT/);
});

// Node resolves the main module through links but keeps argv[1] as typed, as on macOS where /tmp is a link.
test("install.mjs still runs when reached through a symlink or junction", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "haril-install-link-"));
  const link = join(dir, "scripts");
  try {
    symlinkSync(join(REPO, "scripts"), link, "junction");
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    t.skip(`cannot create a link here: ${error.message}`);
    return;
  }
  try {
    const help = spawnSync(process.execPath, [join(link, "install.mjs"), "--help"], {
      encoding: "utf8",
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /usage: /);
  } finally {
    // Only the link is removed; the recursive removal runs once it is gone.
    unlinkSync(link);
    rmSync(dir, { recursive: true, force: true });
  }
});

// The wrappers only check for node and forward their arguments, so `--help` reaches install.mjs.

// Printable ASCII, tabs and line breaks: PowerShell 5.1 reads a file without a BOM as ANSI.
const NON_ASCII = /[^\t\n\r -~]/;

function available(command, args) {
  const probe = spawnSync(command, args, { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

test("install.sh is POSIX sh, executable in git, and ASCII", () => {
  const source = readFileSync(join(REPO, "install.sh"), "utf8");
  assert.ok(source.startsWith("#!/bin/sh\n"));
  assert.match(source, /^set -eu$/m);
  assert.match(source, /scripts\/install\.mjs/);
  assert.doesNotMatch(source, NON_ASCII);
  const staged = spawnSync("git", ["ls-files", "-s", "install.sh"], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (staged.status === 0 && staged.stdout !== "") assert.match(staged.stdout, /^100755 /);
});

test("install.ps1 and install.cmd are ASCII and install.cmd bypasses the execution policy", () => {
  const ps1 = readFileSync(join(REPO, "install.ps1"), "utf8");
  const cmd = readFileSync(join(REPO, "install.cmd"), "utf8");
  for (const source of [ps1, cmd]) assert.doesNotMatch(source, NON_ASCII);
  assert.match(ps1, /Get-Command node/);
  assert.match(ps1, /scripts.install\.mjs/);
  assert.match(cmd, /powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\.ps1" %\*/);
  assert.ok(
    cmd
      .split("\n")
      .slice(0, -1)
      .every((line) => line.endsWith("\r")),
    "CRLF lines",
  );
});

test("install.sh forwards --help, and without node on PATH it exits 2", {
  skip: !available("sh", ["-c", "exit 0"]) && "sh is not available",
}, () => {
  const help = spawnSync("sh", ["install.sh", "--help"], { cwd: REPO, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: /);

  // PATH is set inside the shell: the child's own PATH would also be used to find sh itself.
  const noNode = spawnSync("sh", ["-c", "PATH=/no-such-dir exec /bin/sh ./install.sh"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(noNode.status, 2, noNode.stderr);
  assert.match(noNode.stderr, /Node 24/);
});

const POWERSHELL = ["powershell", "pwsh"].find((command) =>
  available(command, ["-NoProfile", "-Command", "exit 0"]),
);

test("install.ps1 forwards --help through PowerShell", {
  skip: POWERSHELL === undefined && "PowerShell is not available",
}, () => {
  const help = spawnSync(
    POWERSHELL,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "install.ps1", "--help"],
    { cwd: REPO, encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: /);
});

test("install.cmd forwards --help on Windows", {
  skip: process.platform !== "win32" && "install.cmd runs on Windows only",
}, () => {
  // `.\`: the current directory is not searched when NoDefaultCurrentDirectoryInExePath is set.
  const help = spawnSync("cmd.exe", ["/d", "/c", ".\\install.cmd", "--help"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: /);
});

test("remote installers offer a no-checkout path and protect existing agents", () => {
  const powershell = readFileSync(join(REPO, "scripts", "install-online.ps1"), "utf8");
  const posix = readFileSync(join(REPO, "scripts", "install-online.sh"), "utf8");
  for (const source of [powershell, posix]) {
    assert.match(source, /codeload\.github\.com\/anderson-camacho\/HARIL/);
    assert.match(source, /http\.version=HTTP\/1\.1/);
    assert.match(source, /gentle-pi@4\.1\.0/);
    assert.match(source, /gentle-shell/);
    assert.doesNotMatch(source, /reset\s+--hard|git\s+pull/);
  }
  assert.match(powershell, /-NoGentleShell|\[switch\]\$NoGentleShell/);
  assert.match(powershell, /DoNotExpandEnvironmentNames/);
  assert.match(posix, /HARIL_NO_GENTLE_SHELL/);
});
