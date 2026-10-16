import { type PlatformPath, posix, win32 } from "node:path";
import { NODE_DIST_BASE, NODE_VERSION } from "./constants.js";

// Platform facts for the pinned Node archive and the commands that unpack and run it.

export interface NodeArchive {
  readonly fileName: string;
  readonly url: string;
  // Top-level directory inside the archive, for example node-v24.22.0-win-x64.
  readonly archiveDirName: string;
  // Directory name under runtime/node, for example v24.22.0-win-x64.
  readonly installDirName: string;
  // Binary path relative to the install directory.
  readonly binaryRelPath: string;
}

interface Target {
  readonly label: string;
  readonly extension: string;
  readonly arches: readonly string[];
}

const TARGETS: Readonly<Record<string, Target>> = {
  win32: { label: "win", extension: "zip", arches: ["x64"] },
  linux: { label: "linux", extension: "tar.xz", arches: ["x64", "arm64"] },
  darwin: { label: "darwin", extension: "tar.gz", arches: ["x64", "arm64"] },
};

export function nodeArchive(platform: string, arch: string): NodeArchive {
  const target = Object.hasOwn(TARGETS, platform) ? TARGETS[platform] : undefined;
  if (target === undefined || !target.arches.includes(arch)) {
    throw new Error(`unsupported platform ${platform}-${arch} for the pinned Node runtime`);
  }
  const archiveDirName = `node-v${NODE_VERSION}-${target.label}-${arch}`;
  const fileName = `${archiveDirName}.${target.extension}`;
  return {
    fileName,
    url: `${NODE_DIST_BASE}v${NODE_VERSION}/${fileName}`,
    archiveDirName,
    installDirName: `v${NODE_VERSION}-${target.label}-${arch}`,
    binaryRelPath: platform === "win32" ? "node.exe" : "bin/node",
  };
}

export function pathOps(platform: string): PlatformPath {
  return platform === "win32" ? win32 : posix;
}

export function systemRoot(env: Readonly<Record<string, string | undefined>>): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
}

// tar.exe ships with Windows 10 and later; an absolute path avoids any PATH lookup.
export function tarCommand(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return platform === "win32" ? win32.join(systemRoot(env), "System32", "tar.exe") : "tar";
}

// npm-cli.js bundled with the Node archive, relative to its install directory.
export function npmCliRelPath(platform: string): string {
  return platform === "win32"
    ? "node_modules/npm/bin/npm-cli.js"
    : "lib/node_modules/npm/bin/npm-cli.js";
}
