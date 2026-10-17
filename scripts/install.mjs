// One-command installer (haril-installer). install.sh, install.ps1 and install.cmd only check that node exists
// and run this file from the repository root. It installs the dependencies, builds, installs the Pi runtime and
// the CLI under the runtime root, and checks the result with doctor through the installed launcher.
// It never edits PATH, the registry or a shell profile, never installs Node and never reads a key: it prints the
// PATH line instead. Re-running it is an update.
//
//   node scripts/install.mjs [--no-runtime] [--root <dir>] [--dry-run] [--help]
//
// Exit 0 when HARIL is installed (doctor warnings included), 1 when a step fails, 2 when Node or corepack is
// missing or too old, or on a usage error.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_REQUIREMENT = "^24.21.0 || >=26.8.0";
const BOOTSTRAP = "apps/bootstrap/dist/haril-bootstrap.mjs";
const EXIT_OK = 0;
const EXIT_STEP_FAILED = 1;
const EXIT_ENVIRONMENT = 2;
// doctor exits 0 when everything is ok and 1 on warnings (for example, no provider key yet); 2 is an error.
const DOCTOR_WARN = 1;

const USAGE = [
  "usage: install.sh | install.ps1 | install.cmd [--no-runtime] [--root <dir>] [--dry-run] [--help]",
  "       node scripts/install.mjs [the same flags]",
  "",
  "Installs HARIL for this user from this repository, in six steps:",
  `  1. check Node (${NODE_REQUIREMENT}) and corepack`,
  "  2. corepack pnpm install --frozen-lockfile",
  "  3. corepack pnpm run build",
  "  4. install the Pi runtime (a pinned Node and Pi) under the root",
  "  5. install the HARIL CLI under <root>/app, with its launchers in <root>/bin",
  "  6. run doctor through the installed launcher",
  "",
  "  --no-runtime  skip step 4",
  "  --root <dir>  install under <dir>; else HARIL_RUNTIME_DIR, else %LOCALAPPDATA%\\HARIL on Windows,",
  "                else XDG_DATA_HOME/haril (by default ~/.local/share/haril)",
  "  --dry-run     print the commands and run nothing",
  "  --help        print this help",
  "",
  "PATH, the registry and shell profiles are never edited. Re-running the installer updates HARIL.",
];

function pathOps(platform) {
  return platform === "win32" ? win32 : posix;
}

function nonEmpty(value) {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * @param {readonly string[]} argv
 * @returns {{ ok: true, options: { runtime: boolean, dryRun: boolean, help: boolean, root?: string } }
 *   | { ok: false, message: string }}
 */
export function parseInstallArgs(argv) {
  const options = { runtime: true, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--no-runtime") {
      options.runtime = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      const inline = arg.startsWith("--root=");
      const value = inline ? arg.slice("--root=".length) : argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { ok: false, message: "--root needs a directory" };
      }
      options.root = value;
      if (!inline) index++;
    } else {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
  }
  return { ok: true, options };
}

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? null : match.slice(1).map(Number);
}

function atLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

// The root engines range, judged as doctor does: a 24.x below 24.21.0 only warns, anything else outside is an error.
export function nodeStatus(version) {
  const parsed = parseVersion(version);
  if (parsed === null) return "error";
  const onLine24 = parsed[0] === 24 && atLeast(parsed, [24, 21, 0]);
  if (onLine24 || atLeast(parsed, [26, 8, 0])) return "ok";
  return parsed[0] === 24 ? "warn" : "error";
}

// The same order as haril-bootstrap (apps/bootstrap/src/root.ts): --root, HARIL_RUNTIME_DIR, the platform default.
// A relative value is resolved here, against the user's cwd, because the children run from the repository root.
export function resolveRoot({ flag, env, platform, homeDir, cwd }) {
  const ops = pathOps(platform);
  if (nonEmpty(flag) !== undefined) return ops.resolve(cwd, flag);
  const fromEnv = nonEmpty(env.HARIL_RUNTIME_DIR);
  if (fromEnv !== undefined) return ops.resolve(cwd, fromEnv);
  if (platform === "win32") {
    return win32.join(
      nonEmpty(env.LOCALAPPDATA) ?? win32.join(homeDir, "AppData", "Local"),
      "HARIL",
    );
  }
  return posix.join(nonEmpty(env.XDG_DATA_HOME) ?? posix.join(homeDir, ".local", "share"), "haril");
}

function launcherPath(platform, root) {
  return pathOps(platform).join(root, "bin", platform === "win32" ? "haril.cmd" : "haril");
}

// Steps 1 to 6. Windows runs corepack (a .cmd shim) and haril.cmd through the shell; every other command is
// spawned directly. The runtime goes before the CLI so the launchers pin its Node from the first install.
// Every child gets the root resolved once: bootstrap through --root, doctor through HARIL_RUNTIME_DIR, which is
// how haril finds its runtime.
export function planSteps({ platform, env, repoRoot, nodeExe, root, runtime }) {
  const shell = platform === "win32";
  const rootArgs = ["--root", root];
  const step = (id, title, command, args, extra = {}) => ({
    id,
    title,
    command,
    args,
    cwd: repoRoot,
    env,
    shell: false,
    display: commandLine(command === nodeExe ? "node" : command, args),
    ...extra,
  });
  return [
    step("preflight", "Check Node and corepack", "corepack", ["--version"], { shell }),
    step("deps", "Install dependencies", "corepack", ["pnpm", "install", "--frozen-lockfile"], {
      shell,
    }),
    step("build", "Build", "corepack", ["pnpm", "run", "build"], { shell }),
    step(
      "runtime",
      "Install the Pi runtime (pinned Node and Pi)",
      nodeExe,
      [BOOTSTRAP, "install-runtime", ...rootArgs],
      runtime ? {} : { skip: "--no-runtime" },
    ),
    step("app", "Install the HARIL CLI", nodeExe, [
      BOOTSTRAP,
      "install",
      ...rootArgs,
      "--from",
      repoRoot,
    ]),
    step("doctor", "Check the install with doctor", launcherPath(platform, root), ["doctor"], {
      shell,
      env: { ...env, HARIL_RUNTIME_DIR: root },
    }),
  ];
}

// A command line for the shell and for display: tokens with spaces or shell characters go in double quotes.
export function commandLine(command, args) {
  return [command, ...args]
    .map((token) => (token === "" || /[\s&|<>^()]/.test(token) ? `"${token}"` : token))
    .join(" ");
}

function failure(step, label, result) {
  if (result.error !== undefined)
    return `step ${label} "${step.title}" could not start: ${result.error}`;
  if (result.signal) return `step ${label} "${step.title}" was stopped by ${result.signal}`;
  return `step ${label} "${step.title}" failed with exit code ${result.code}`;
}

function onPath(dir, env, platform) {
  const ops = pathOps(platform);
  const normalize = (entry) => {
    const trimmed = entry.replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const wanted = normalize(dir);
  return (env.PATH ?? env.Path ?? "")
    .split(ops.delimiter)
    .some((entry) => entry !== "" && normalize(entry) === wanted);
}

function psQuote(text) {
  return `'${text.replaceAll("'", "''")}'`;
}

function shQuote(text) {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

// The line the user can run by hand; the installer only prints it. On Windows it lasts for the session: the
// .NET user-environment setter would rewrite a REG_EXPAND_SZ user Path as an expanded REG_SZ, so the permanent
// change goes through the Windows dialog instead.
function pathLine(bin, platform, homeDir) {
  if (platform === "win32") return `$env:Path += ${psQuote(`;${bin}`)}`;
  const escapeShell = (text) => text.replace(/[\\"$`]/g, (char) => `\\${char}`);
  const home = homeDir.replace(/\/+$/, "");
  const shown =
    home !== "" && bin.startsWith(`${home}/`)
      ? `$HOME/${escapeShell(bin.slice(home.length + 1))}`
      : escapeShell(bin);
  return `export PATH="${shown}:$PATH"`;
}

function printSummary(deps, root, options) {
  const { out, platform, env } = deps;
  const launcher = launcherPath(platform, root);
  const bin = pathOps(platform).join(root, "bin");
  out("");
  out("HARIL is installed. Run this installer again to update it.");
  out(`  root      ${root}`);
  out(`  launcher  ${launcher}`);
  const named = onPath(bin, env, platform);
  if (named) {
    out(`${bin} is already on PATH, so haril runs by name.`);
  } else {
    out(`PATH is not edited. To run haril by name, add ${bin} to PATH yourself:`);
    if (platform === "win32") {
      // The dialog command goes on its own line, so it copies without the sentence around it.
      out(
        "  for your user, run this, select Path, then New, paste the folder and open a new terminal:",
      );
      out("    rundll32 sysdm.cpl,EditEnvironmentVariables");
      out("  for this PowerShell session only:");
    } else {
      out(
        "  add this line to your shell profile (~/.profile, ~/.bashrc or ~/.zshrc), then open a new terminal:",
      );
    }
    out(`    ${pathLine(bin, platform, deps.homeDir)}`);
  }
  if (root !== resolveRoot({ ...deps, flag: undefined })) {
    out(
      `This root is not the default one: set HARIL_RUNTIME_DIR to ${root} when you run haril, so it finds this runtime and its config.`,
    );
  }
  if (!options.runtime) {
    out(
      "The Pi runtime was skipped (--no-runtime). Real agents need it: run the installer again without it.",
    );
  }
  out("Next steps:");
  const call = platform === "win32" ? `& ${psQuote(launcher)}` : shQuote(launcher);
  out(`  ${named ? "haril" : call}`);
  out("    opens the console");
  out("  set the HARIL_CLIPROXYAPI_KEY environment variable");
  out("    to run real agents through CLIProxyAPI (README, section M3)");
}

function printDryRun(steps, deps, root) {
  const { out } = deps;
  out("HARIL installer, dry run: nothing is run.");
  out(`  repository  ${deps.repoRoot}`);
  out(`  root        ${root}`);
  for (const [index, step] of steps.entries()) {
    const label = `[${index + 1}/${steps.length}] ${step.title}`;
    if (step.skip !== undefined) {
      out(`${label}: skipped (${step.skip})`);
      continue;
    }
    out(label);
    if (step.id === "preflight")
      out(`      node v${stripV(deps.nodeVersion)} must satisfy ${NODE_REQUIREMENT}`);
    const withRoot = step.env === deps.env ? "" : ` (with HARIL_RUNTIME_DIR=${root})`;
    out(`      > ${step.display}${withRoot}`);
  }
  return EXIT_OK;
}

function stripV(version) {
  return version.replace(/^v/, "");
}

// Step 1 before corepack runs: the Node that runs this file must satisfy the root engines range.
function checkNode(deps) {
  const version = `v${stripV(deps.nodeVersion)}`;
  const status = nodeStatus(version);
  if (status === "error") {
    deps.err(`install: HARIL needs Node ${NODE_REQUIREMENT}; this is Node ${version}.`);
    deps.err(
      "install: get Node 24 from https://nodejs.org/en/download (or a version manager such as fnm or nvm), then run the installer again. The installer never installs Node for you.",
    );
    return false;
  }
  if (status === "warn") {
    deps.err(
      `warning: Node ${version} is below ${NODE_REQUIREMENT}; HARIL runs, and doctor warns too.`,
    );
  }
  deps.out(`node      ${version} (${status === "ok" ? "ok" : "warning"}) ${deps.nodeExe}`);
  return true;
}

/**
 * @param {readonly string[]} argv
 * @param {{
 *   platform: string, env: Readonly<Record<string, string | undefined>>, homeDir: string, cwd: string,
 *   repoRoot: string, nodeVersion: string, nodeExe: string,
 *   run: (step: object) => Promise<{ code: number | null, signal: string | null, error?: string }>,
 *   exists?: (path: string) => boolean, out: (line: string) => void, err: (line: string) => void,
 * }} deps
 * @returns {Promise<number>}
 */
export async function runInstall(argv, deps) {
  const parsed = parseInstallArgs(argv);
  if (!parsed.ok) {
    deps.err(`install: ${parsed.message}`);
    deps.err(USAGE[0]);
    return EXIT_ENVIRONMENT;
  }
  const { options } = parsed;
  if (options.help) {
    for (const line of USAGE) deps.out(line);
    return EXIT_OK;
  }

  const root = resolveRoot({ ...deps, flag: options.root });
  const steps = planSteps({ ...deps, root, runtime: options.runtime });
  if (options.dryRun) return printDryRun(steps, deps, root);

  const exists = deps.exists ?? existsSync;
  deps.out(`HARIL installer: ${deps.repoRoot} -> ${root}`);
  for (const [index, step] of steps.entries()) {
    const label = `${index + 1}/${steps.length}`;
    deps.out("");
    if (step.skip !== undefined) {
      deps.out(`[${label}] ${step.title}: skipped (${step.skip})`);
      continue;
    }
    deps.out(`[${label}] ${step.title}`);
    if (step.id === "preflight" && !checkNode(deps)) return EXIT_ENVIRONMENT;
    // A missing launcher would reach cmd.exe as "not recognized" (exit 1), which reads like a doctor warning.
    if (step.id === "doctor" && !exists(step.command)) {
      deps.err(`install: step ${label} "${step.title}" found no launcher at ${step.command}`);
      return EXIT_STEP_FAILED;
    }
    deps.out(`> ${step.display}`);
    const result = await deps.run(step);
    if (result.error === undefined && !result.signal && result.code === 0) continue;

    if (step.id === "preflight") {
      deps.err(`install: corepack did not run: ${failure(step, label, result)}.`);
      deps.err(
        "install: Node 24 ships corepack. Use Node 24, or install corepack yourself (https://github.com/nodejs/corepack), then run the installer again.",
      );
      return EXIT_ENVIRONMENT;
    }
    if (step.id === "doctor" && result.error === undefined && result.code === DOCTOR_WARN) {
      deps.out("doctor reported warnings (exit code 1), listed above; HARIL is installed.");
      continue;
    }
    deps.err(`install: ${failure(step, label, result)}`);
    if (step.id === "doctor") {
      deps.err(
        `install: HARIL is installed in ${root}, but doctor found errors: fix them and run ${step.display}`,
      );
    } else {
      deps.err("install: fix the problem above and run the installer again; re-running is safe.");
    }
    if (step.id === "runtime") {
      deps.err("install: to install the CLI without the Pi runtime for now, add --no-runtime.");
    }
    return EXIT_STEP_FAILED;
  }

  printSummary(deps, root, options);
  return EXIT_OK;
}

// Runs one step with inherited stdio. A shell step gets a single command line: Node deprecates passing
// arguments together with shell: true (DEP0190).
export function spawnStep(step) {
  return new Promise((done) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    const options = { cwd: step.cwd, env: step.env, stdio: "inherit" };
    try {
      const child = step.shell
        ? spawn(commandLine(step.command, step.args), { ...options, shell: true })
        : spawn(step.command, step.args, options);
      child.on("error", (error) => settle({ code: null, signal: null, error: error.message }));
      child.on("close", (code, signal) => settle({ code, signal }));
    } catch (error) {
      settle({
        code: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

// Compared through realpath: Node resolves links in the main module's URL but keeps argv[1] as typed, so a plain
// comparison would make a run through a symlink or junction (macOS /tmp, for one) a silent no-op.
function isMain(metaUrl) {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await runInstall(process.argv.slice(2), {
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
    cwd: process.cwd(),
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    nodeVersion: process.versions.node,
    nodeExe: process.execPath,
    run: spawnStep,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
