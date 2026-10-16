import { PI_PACKAGE, PI_VERSION } from "./constants.js";
import { isolatedEnv } from "./env.js";
import { piPaths, runtimeLayout } from "./layout.js";
import type { InstalledNode } from "./node-step.js";
import { npmCliRelPath, pathOps } from "./platform.js";
import type { InstallDeps, StepReport } from "./ports.js";
import { messageOf, tail } from "./text.js";

// Step 2 (M2-D3): Pi 1.2.0 with the isolated Node and its bundled npm-cli.js. Scripts are off, dev
// dependencies are omitted, and npm reads an empty user config so no user .npmrc or token applies.

const NPM_TIMEOUT_MS = 600_000;

interface NpmInstallArgs {
  readonly npmCli: string;
  readonly prefix: string;
  readonly userconfig: string;
  readonly cache: string;
  readonly spec: string;
}

export function npmInstallArgv(args: NpmInstallArgs): string[] {
  return [
    args.npmCli,
    "install",
    "--prefix",
    args.prefix,
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--userconfig",
    args.userconfig,
    "--cache",
    args.cache,
    args.spec,
  ];
}

export async function installPi(deps: InstallDeps, node: InstalledNode): Promise<StepReport> {
  try {
    const ops = pathOps(deps.platform);
    const layout = runtimeLayout(deps.root, ops);
    const prefix = layout.piPrefix;
    if (await isVerifiedPi(deps, prefix)) {
      return { name: "pi", status: "skipped", detail: `${PI_VERSION} at ${prefix}` };
    }

    const npmCli = ops.join(node.installDir, ...npmCliRelPath(deps.platform).split("/"));
    if (!(await deps.fs.exists(npmCli)))
      throw new Error("npm-cli.js is missing from the isolated Node");

    const userconfig = ops.join(layout.stagingDir, "npm-userconfig");
    await deps.fs.writeFile(userconfig, "");
    try {
      const argv = npmInstallArgv({
        npmCli,
        prefix,
        userconfig,
        cache: layout.npmCache,
        spec: `${PI_PACKAGE}@${PI_VERSION}`,
      });
      const result = await deps.exec.run(node.binaryPath, argv, {
        env: isolatedEnv(deps.platform, deps.env, ops.dirname(node.binaryPath)),
        timeoutMs: NPM_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        throw new Error(`npm install failed (exit ${result.exitCode}): ${tail(result.stderr)}`);
      }
    } finally {
      await deps.fs.remove(userconfig);
    }

    if (!(await isVerifiedPi(deps, prefix))) {
      throw new Error(`installed Pi is not ${PI_VERSION} with dist/bundle/cli.js`);
    }
    return { name: "pi", status: "ok", detail: `${PI_VERSION} at ${prefix}` };
  } catch (error) {
    return { name: "pi", status: "failed", detail: messageOf(error) };
  }
}

async function isVerifiedPi(deps: InstallDeps, prefix: string): Promise<boolean> {
  const { packageDir, cliPath } = piPaths(prefix, pathOps(deps.platform));
  try {
    const pkg = JSON.parse(
      await deps.fs.readText(pathOps(deps.platform).join(packageDir, "package.json")),
    ) as { version?: unknown };
    return pkg.version === PI_VERSION && (await deps.fs.exists(cliPath));
  } catch {
    return false;
  }
}
