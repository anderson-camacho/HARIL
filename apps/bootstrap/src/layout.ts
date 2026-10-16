import type { PlatformPath } from "node:path";
import { PI_PACKAGE, PI_VERSION } from "./constants.js";

// Where the runtime lives under the root (ARCH 6.1, M2-D2, M2-D3).

export interface RuntimeLayout {
  readonly runtimeDir: string;
  readonly nodeRoot: string;
  readonly manifest: string;
  readonly stagingDir: string;
  readonly npmCache: string;
  readonly piPrefix: string;
}

export function runtimeLayout(root: string, ops: PlatformPath): RuntimeLayout {
  const runtimeDir = ops.join(root, "runtime");
  return {
    runtimeDir,
    nodeRoot: ops.join(runtimeDir, "node"),
    manifest: ops.join(runtimeDir, "manifest.json"),
    stagingDir: ops.join(runtimeDir, ".staging"),
    npmCache: ops.join(root, "cache", "npm"),
    piPrefix: ops.join(root, "vendor", "pi", PI_VERSION),
  };
}

export interface PiPaths {
  readonly packageDir: string;
  readonly cliPath: string;
}

export function piPaths(prefix: string, ops: PlatformPath): PiPaths {
  const packageDir = ops.join(prefix, "node_modules", ...PI_PACKAGE.split("/"));
  return { packageDir, cliPath: ops.join(packageDir, "dist", "bundle", "cli.js") };
}
