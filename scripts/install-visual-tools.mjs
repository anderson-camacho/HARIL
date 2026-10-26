// HARIL-owned optional terminal tools. The official uv executable, a managed Python,
// and TerminalTextEffects all live below the HARIL runtime root; nothing is added to
// the user's PATH and no global Python, pipx or admin permissions are required.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const UV_VERSION = "0.13.5";
export const TTE_VERSION = "0.15.0";
const TOOL_SPEC = `terminaltexteffects==${TTE_VERSION}`;
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;

const ARCHIVES = {
  "win32:x64": "uv-x86_64-pc-windows-msvc.zip",
  "win32:arm64": "uv-aarch64-pc-windows-msvc.zip",
  "linux:x64": "uv-x86_64-unknown-linux-gnu.tar.gz",
  "linux:arm64": "uv-aarch64-unknown-linux-gnu.tar.gz",
  "darwin:x64": "uv-x86_64-apple-darwin.tar.gz",
  "darwin:arm64": "uv-aarch64-apple-darwin.tar.gz",
};

export function visualToolPaths(root, platform = process.platform) {
  const ops = platform === "win32" ? win32 : posix;
  return {
    uv: ops.join(root, "tools", "uv", platform === "win32" ? "uv.exe" : "uv"),
    tte: ops.join(root, "tools", "bin", platform === "win32" ? "tte.exe" : "tte"),
    toolDir: ops.join(root, "tools", "packages"),
    binDir: ops.join(root, "tools", "bin"),
    pythonDir: ops.join(root, "tools", "python"),
    cacheDir: ops.join(root, "tools", "cache"),
  };
}

async function downloadBytes(url, limit) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { "User-Agent": "HARIL-visual-tools" },
  });
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status} for ${url}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error(`download exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function verifyUvArchive(binary, checksum) {
  const expected = /\b[a-f0-9]{64}\b/i.exec(checksum)?.[0];
  if (!expected) throw new Error("official uv checksum is missing or malformed");
  const actual = createHash("sha256").update(binary).digest("hex");
  if (expected.toLowerCase() !== actual) throw new Error("official uv SHA-256 mismatch");
}

async function officialArchive(archive) {
  const bases = [
    `https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}`,
    `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`,
  ];
  let lastError;
  for (const base of bases) {
    try {
      const digestFile = await downloadBytes(`${base}/${archive}.sha256`, 4096);
      const binary = await downloadBytes(`${base}/${archive}`, MAX_ARCHIVE_BYTES);
      verifyUvArchive(binary, digestFile.toString("utf8"));
      return binary;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("uv release is unavailable");
}

function run(command, args, env = process.env, timeoutMs = 180_000) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit", windowsHide: true });
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timeout) reject(new Error(`${command} timed out`));
      else if (code !== 0)
        reject(new Error(`${command} failed with exit ${code ?? "interrupted"}`));
      else done();
    });
  });
}

function findBinary(directory, filename, depth = 2) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return path;
    if (entry.isDirectory() && depth > 0) {
      const found = findBinary(path, filename, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function bootstrapUv(root, platform, arch, output = console.log, force = false) {
  const archive = ARCHIVES[`${platform}:${arch}`];
  if (!archive) throw new Error(`uv is not packaged for ${platform}/${arch}`);
  const paths = visualToolPaths(root, platform);
  if (existsSync(paths.uv) && !force) return paths.uv;
  output(`HARIL: preparing the managed uv ${UV_VERSION} toolchain (${platform}/${arch})...`);
  const temp = mkdtempSync(join(tmpdir(), "haril-uv-"));
  try {
    const packed = join(temp, archive);
    const unpacked = join(temp, "unpacked");
    mkdirSync(unpacked);
    writeFileSync(packed, await officialArchive(archive));
    if (platform === "win32") {
      const quoted = (value) => `'${value.replaceAll("'", "''")}'`;
      await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${quoted(packed)} -DestinationPath ${quoted(unpacked)} -Force`,
      ]);
    } else {
      await run("tar", ["-xzf", packed, "-C", unpacked]);
    }
    const file = findBinary(unpacked, platform === "win32" ? "uv.exe" : "uv");
    if (!file || !statSync(file).isFile())
      throw new Error("the verified archive has no uv executable");
    mkdirSync(dirname(paths.uv), { recursive: true });
    const staging = `${paths.uv}.installing`;
    copyFileSync(file, staging);
    if (platform !== "win32") chmodSync(staging, 0o755);
    if (force && existsSync(paths.uv)) {
      // Preserve the previous executable until its verified replacement is ready.
      const backup = `${paths.uv}.previous-${process.pid}`;
      renameSync(paths.uv, backup);
      try {
        renameSync(staging, paths.uv);
      } catch (error) {
        renameSync(backup, paths.uv);
        throw error;
      }
      rmSync(backup);
    } else {
      renameSync(staging, paths.uv);
    }
    return paths.uv;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// A file existing is not proof it works: it may be an old version, a truncated
// executable or a broken managed Python environment. Probe the actual CLI.
export function toolVersionMatches(output, version) {
  const pattern = new RegExp(`(^|[^0-9.])${version.replaceAll(".", "\\.")}($|[^0-9.])`);
  return pattern.test(output);
}

export async function probeToolVersion(binary, version, env = process.env) {
  return new Promise((done) => {
    let output = "";
    let finished = false;
    const complete = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(ok);
    };
    const child = spawn(binary, ["--version"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const read = (chunk) => {
      if (output.length < 4096) output += chunk.toString("utf8").slice(0, 4096);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    const timer = setTimeout(() => {
      child.kill();
      complete(false);
    }, 10_000);
    child.once("error", () => complete(false));
    child.once("close", (code) => complete(code === 0 && toolVersionMatches(output, version)));
  });
}

// The core HARIL installer calls this on install AND update. Callers can inject
// dependencies in tests without downloading or modifying anything outside temp.
export async function installVisualTools(root, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const output = options.output ?? console.log;
  const exists = options.exists ?? existsSync;
  const bootstrap = options.bootstrap ?? bootstrapUv;
  const execute = options.execute ?? run;
  if (
    env.CI === "true" ||
    env.HARIL_AUTO_INSTALL_VISUALS === "off" ||
    env.HARIL_STARTUP_ANIMATION === "off"
  ) {
    output("HARIL: optional Matrix tools skipped (CI or user setting).");
    return { status: "skipped" };
  }
  const paths = visualToolPaths(root, platform);
  const probe = options.probe ?? probeToolVersion;
  const toolEnv = {
    ...env,
    UV_TOOL_DIR: paths.toolDir,
    UV_TOOL_BIN_DIR: paths.binDir,
    UV_PYTHON_INSTALL_DIR: paths.pythonDir,
    UV_CACHE_DIR: paths.cacheDir,
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_PROGRESS: "1",
  };
  const uvExists = exists(paths.uv);
  const tteExists = exists(paths.tte);
  const [uvHealthy, tteHealthy] = await Promise.all([
    uvExists ? probe(paths.uv, UV_VERSION, toolEnv) : false,
    tteExists ? probe(paths.tte, TTE_VERSION, toolEnv) : false,
  ]);
  if (uvHealthy && tteHealthy) {
    output(`HARIL: Matrix ${TTE_VERSION} verified at ${paths.tte}; nothing to install.`);
    return { status: "verified", binary: paths.tte };
  }
  if (uvExists && !uvHealthy) output("HARIL: uv is damaged or outdated; repairing it...");
  if (tteExists && !tteHealthy) output("HARIL: Matrix is damaged or outdated; repairing it...");

  const uv = uvHealthy
    ? paths.uv
    : await bootstrap(root, platform, arch, output, uvExists);
  output(`HARIL: installing/repairing Matrix effect (${TOOL_SPEC}) in the HARIL runtime...`);
  await execute(uv, ["tool", "install", "--reinstall", "--python", "3.12", TOOL_SPEC], toolEnv);
  if (!exists(paths.tte))
    throw new Error(`Matrix setup completed but ${paths.tte} was not created`);
  if (!(await probe(paths.tte, TTE_VERSION, toolEnv)))
    throw new Error(`Matrix executable is present but failed the ${TTE_VERSION} version/health check`);
  output(`HARIL: Matrix ${TTE_VERSION} verified and ready at ${paths.tte}`);
  return { status: tteExists ? "repaired" : "installed", binary: paths.tte };
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== "--root" || !args[1] || args[1].startsWith("--")) {
    throw new Error(
      "usage: node scripts/install-visual-tools.mjs --root <HARIL runtime directory>",
    );
  }
  return resolve(args[1]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await installVisualTools(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `HARIL Matrix dependency setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
