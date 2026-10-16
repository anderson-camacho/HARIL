import { NODE_DIST_BASE, NODE_VERSION } from "./constants.js";
import { ARCHIVE_TIMEOUT_MS, getOfficial, SHASUMS_TIMEOUT_MS } from "./download.js";
import { isolatedEnv } from "./env.js";
import { type RuntimeLayout, runtimeLayout } from "./layout.js";
import { parseManifest } from "./manifest.js";
import { type NodeArchive, nodeArchive, pathOps, tarCommand } from "./platform.js";
import type { InstallDeps, StepReport } from "./ports.js";
import { parseShasums, sha256Hex } from "./shasums.js";
import { messageOf, tail } from "./text.js";

// Step 1 (M2-D2): the isolated Node, fetched from nodejs.org, verified against SHASUMS256.txt, unpacked
// into a temporary directory and renamed into runtime/node/<version>-<platform>-<arch>.

const TAR_TIMEOUT_MS = 300_000;
const CHECK_TIMEOUT_MS = 30_000;

export interface InstalledNode {
  readonly installDir: string;
  readonly binaryPath: string;
  readonly sha256: string | null;
}

export interface NodeOutcome {
  readonly report: StepReport;
  readonly node: InstalledNode | null;
}

export async function installNode(deps: InstallDeps): Promise<NodeOutcome> {
  try {
    const ops = pathOps(deps.platform);
    const archive = nodeArchive(deps.platform, deps.arch);
    const layout = runtimeLayout(deps.root, ops);
    const installDir = ops.join(layout.nodeRoot, archive.installDirName);
    const binaryPath = ops.join(installDir, ...archive.binaryRelPath.split("/"));

    if (await reportsPinnedVersion(deps, binaryPath)) {
      const sha256 = await recordedDigest(deps, layout, binaryPath);
      return {
        report: { name: "node", status: "skipped", detail: `v${NODE_VERSION} at ${installDir}` },
        node: { installDir, binaryPath, sha256 },
      };
    }

    const sha256 = await downloadAndUnpack(deps, archive, layout, installDir);
    if (!(await reportsPinnedVersion(deps, binaryPath))) {
      throw new Error(`installed Node does not report v${NODE_VERSION}`);
    }
    return {
      report: { name: "node", status: "ok", detail: `v${NODE_VERSION} at ${installDir}` },
      node: { installDir, binaryPath, sha256 },
    };
  } catch (error) {
    return { report: { name: "node", status: "failed", detail: messageOf(error) }, node: null };
  }
}

async function downloadAndUnpack(
  deps: InstallDeps,
  archive: NodeArchive,
  layout: RuntimeLayout,
  installDir: string,
): Promise<string> {
  const ops = pathOps(deps.platform);
  const releaseUrl = `${NODE_DIST_BASE}v${NODE_VERSION}/`;
  const shasums = new TextDecoder().decode(
    await getOfficial(deps.fetch, `${releaseUrl}SHASUMS256.txt`, SHASUMS_TIMEOUT_MS),
  );
  const expected = parseShasums(shasums).get(archive.fileName);
  if (expected === undefined)
    throw new Error(`SHASUMS256.txt has no entry for ${archive.fileName}`);

  const bytes = await getOfficial(deps.fetch, archive.url, ARCHIVE_TIMEOUT_MS);
  const archivePath = ops.join(layout.stagingDir, archive.fileName);
  await deps.fs.mkdirp(layout.stagingDir);
  await deps.fs.writeFile(archivePath, bytes);
  // Verify the bytes that are on disk, the ones that will be extracted.
  const actual = sha256Hex(await deps.fs.readBytes(archivePath));
  if (actual !== expected) {
    await deps.fs.remove(archivePath);
    throw new Error(`SHA-256 mismatch for ${archive.fileName}; the archive was deleted`);
  }

  const extractDir = ops.join(layout.stagingDir, "extract");
  await deps.fs.remove(extractDir);
  await deps.fs.mkdirp(extractDir);
  const tar = await deps.exec.run(
    tarCommand(deps.platform, deps.env),
    ["-xf", archivePath, "-C", extractDir],
    {
      env: isolatedEnv(deps.platform, deps.env, undefined),
      timeoutMs: TAR_TIMEOUT_MS,
    },
  );
  if (tar.exitCode !== 0) throw new Error(`tar failed (exit ${tar.exitCode}): ${tail(tar.stderr)}`);

  const extracted = ops.join(extractDir, archive.archiveDirName);
  if (!(await deps.fs.exists(extracted))) {
    throw new Error(`the archive does not contain ${archive.archiveDirName}`);
  }
  await deps.fs.remove(installDir);
  await deps.fs.mkdirp(layout.nodeRoot);
  await deps.fs.rename(extracted, installDir);
  await deps.fs.remove(layout.stagingDir);
  return actual;
}

async function reportsPinnedVersion(deps: InstallDeps, binaryPath: string): Promise<boolean> {
  if (!(await deps.fs.exists(binaryPath))) return false;
  try {
    const ops = pathOps(deps.platform);
    const result = await deps.exec.run(binaryPath, ["--version"], {
      env: isolatedEnv(deps.platform, deps.env, ops.dirname(binaryPath)),
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.trim() === `v${NODE_VERSION}`;
  } catch {
    return false;
  }
}

// An already-installed Node keeps the digest its manifest recorded, when that manifest describes it.
async function recordedDigest(
  deps: InstallDeps,
  layout: RuntimeLayout,
  binaryPath: string,
): Promise<string | null> {
  try {
    const manifest = parseManifest(await deps.fs.readText(layout.manifest));
    return manifest.node.path === binaryPath ? manifest.node.sha256 : null;
  } catch {
    return null;
  }
}
