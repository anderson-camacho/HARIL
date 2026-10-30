import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const version = "3.6.0";
const os = { win32: "windows", linux: "linux", darwin: "darwin" }[process.platform];
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!os || !arch) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
const platformRoot =
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "HARIL")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "haril");
const root = resolve(process.env.HARIL_RUNTIME_DIR ?? platformRoot);
const data = resolve(process.env.HARIL_HOME ?? join(platformRoot, "data"));
const binary = join(
  root,
  "vendor",
  "engram",
  version,
  process.platform === "win32" ? "engram.exe" : "engram",
);
const config = resolve(process.env.HARIL_CONFIG ?? join(root, "config", "haril.json"));
const name = `engram_${version}_${os}_${arch}.${os === "windows" ? "zip" : "tar.gz"}`;
const base = `https://github.com/Gentleman-Programming/engram/releases/download/v${version}`;

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
function readObject(path) {
  const object = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!object || typeof object !== "object" || Array.isArray(object))
    throw new Error(`Invalid JSON object: ${path}`);
  return object;
}
function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
// Resolve existing ancestors too: a junction must not redirect installation into ~/.engram.
function canonical(path) {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), basename(path));
}
const normalized = (path) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const userMemory = normalized(canonical(join(homedir(), ".engram")));
for (const path of [root, data, config, resolve(".pi", "mcp.json")]) {
  const target = normalized(canonical(path));
  if (target === userMemory || target.startsWith(`${userMemory}${sep}`))
    throw new Error(`Refusing to change the user's ~/.engram: ${path}`);
}
// Parse existing files before changing anything. Never overwrite unrelated settings.
const settings = readObject(config);
const agentMcpPath = join(root, "agent", "mcp.json");
const projectMcpPath = resolve(".pi", "mcp.json");
const agentMcp = readObject(agentMcpPath);
const projectMcp = readObject(projectMcpPath);
const stage = mkdtempSync(join(tmpdir(), "haril-engram-"));
try {
  const [archive, checksums] = await Promise.all([
    download(`${base}/${name}`),
    download(`${base}/checksums.txt`),
  ]);
  const line = checksums
    .toString("utf8")
    .split(/\r?\n/)
    .find((entry) => entry.trim().split(/\s+/).at(-1)?.replace(/^\*/, "") === name);
  const expected = line?.split(/\s+/)[0];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected || actual !== expected) throw new Error("Engram SHA-256 checksum mismatch");
  const archivePath = join(stage, name);
  writeFileSync(archivePath, archive);
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  execFileSync(tar, ["-xf", archivePath, "-C", stage], { stdio: "pipe" });
  const extracted = join(stage, process.platform === "win32" ? "engram.exe" : "engram");
  chmodSync(extracted, 0o755);
  const reported = execFileSync(extracted, ["version"], { encoding: "utf8" }).trim();
  if (!reported.includes(version)) throw new Error(`Unexpected Engram version: ${reported}`);
  mkdirSync(dirname(binary), { recursive: true });
  // Idempotent reinstall must not replace an executable held by an active Windows MCP process.
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  if (!existsSync(binary) || digest(binary) !== digest(extracted)) {
    copyFileSync(extracted, binary);
    chmodSync(binary, 0o755);
  }
  const server = {
    command: binary,
    args: ["mcp", "--tools=agent"],
    env: {
      ENGRAM_DATA_DIR: join(data, "memory", "engram"),
      ENGRAM_PROJECT: "haril",
      ENGRAM_STARTUP_POLICY: "deny",
      ENGRAM_NO_UPDATE_CHECK: "1",
    },
    exposure: "direct",
    description:
      "Local HARIL project memory: decisions, discoveries, preferences and session handoffs. Never store secrets.",
  };
  for (const [path, document] of [
    [agentMcpPath, agentMcp],
    [projectMcpPath, projectMcp],
  ]) {
    json(path, { ...document, mcpServers: { ...document.mcpServers, engram: server } });
  }
  json(config, { ...settings, memory: { provider: "engram", binary, version } });
  console.log(
    `Engram ${version} installed and configured.\nBinary: ${binary}\nMemory: ${join(data, "memory", "engram")}\nConfig: ${config}\nPi MCP: ${agentMcpPath}\nProject MCP: ${projectMcpPath}\nRestart HARIL/Pi (or /reload) to load memory tools. Nothing in ~/.engram was changed.`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
