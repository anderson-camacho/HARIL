import { MANIFEST_SCHEMA_VERSION, NODE_VERSION, PI_VERSION } from "./constants.js";
import { piPaths, type RuntimeLayout, runtimeLayout } from "./layout.js";
import { type Manifest, parseManifest, serializeManifest } from "./manifest.js";
import { type InstalledNode, installNode } from "./node-step.js";
import { installPi } from "./pi-step.js";
import { pathOps } from "./platform.js";
import type { InstallDeps, StepReport } from "./ports.js";

// `install-runtime` (M2-T3): node, then pi, then the manifest. Every step is idempotent: a step that is
// already verified reports "skipped" and does no network or npm work. A failed step stops the later ones.

export interface InstallResult {
  readonly ok: boolean;
  readonly root: string;
  readonly steps: readonly StepReport[];
}

export async function installRuntime(deps: InstallDeps): Promise<InstallResult> {
  const layout = runtimeLayout(deps.root, pathOps(deps.platform));
  const steps: StepReport[] = [];

  const node = await installNode(deps);
  steps.push(node.report);

  const pi: StepReport =
    node.node === null
      ? { name: "pi", status: "failed", detail: "not attempted: the node step failed" }
      : await installPi(deps, node.node);
  steps.push(pi);

  if (node.node === null || pi.status === "failed") {
    steps.push({
      name: "manifest",
      status: "failed",
      detail: "not written: a previous step failed",
    });
  } else {
    steps.push(await writeManifest(deps, layout, node.node));
  }

  return { ok: steps.every((step) => step.status !== "failed"), root: deps.root, steps };
}

async function writeManifest(
  deps: InstallDeps,
  layout: RuntimeLayout,
  node: InstalledNode,
): Promise<StepReport> {
  const ops = pathOps(deps.platform);
  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    node: { version: NODE_VERSION, path: node.binaryPath, sha256: node.sha256 },
    pi: {
      version: PI_VERSION,
      cliPath: piPaths(layout.piPrefix, ops).cliPath,
    },
    installedAt: deps.now(),
  };

  const existing = await readManifest(deps, layout.manifest);
  if (existing !== null && sameInstall(existing, manifest)) {
    return { name: "manifest", status: "skipped", detail: layout.manifest };
  }
  const temporary = `${layout.manifest}.tmp`;
  await deps.fs.writeFile(temporary, serializeManifest(manifest));
  await deps.fs.rename(temporary, layout.manifest);
  return { name: "manifest", status: "ok", detail: layout.manifest };
}

async function readManifest(deps: InstallDeps, path: string): Promise<Manifest | null> {
  try {
    return parseManifest(await deps.fs.readText(path));
  } catch {
    return null;
  }
}

// The installed versions and paths decide the manifest; the install timestamp does not.
function sameInstall(a: Manifest, b: Manifest): boolean {
  return (
    a.node.version === b.node.version &&
    a.node.path === b.node.path &&
    a.node.sha256 === b.node.sha256 &&
    a.pi.version === b.pi.version &&
    a.pi.cliPath === b.pi.cliPath
  );
}
