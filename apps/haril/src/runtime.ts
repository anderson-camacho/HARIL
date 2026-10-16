import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { HostInfo, RuntimeInspection } from "./context.js";

// Runtime section of doctor (M2-T3). The root resolves like the bootstrap's, but this file does not import it.
// doctor only reads runtime/manifest.json and checks that the recorded files exist; it never runs them.

const RUNTIME_DIR_ENV = "HARIL_RUNTIME_DIR";
const NOT_INSTALLED = "not installed: run npm run runtime:install";

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function runtimeRootFor(host: HostInfo): string {
  const env = host.env ?? {};
  const fromEnv = nonEmpty(env[RUNTIME_DIR_ENV]);
  if (fromEnv !== undefined) return fromEnv;
  const home = host.homeDir ?? "";
  if (host.platform === "win32") {
    const localAppData = nonEmpty(env.LOCALAPPDATA) ?? win32.join(home, "AppData", "Local");
    return win32.join(localAppData, "HARIL");
  }
  const dataHome = nonEmpty(env.XDG_DATA_HOME) ?? posix.join(home, ".local", "share");
  return posix.join(dataHome, "haril");
}

export function readRuntime(root: string, platform: string): RuntimeInspection {
  const ops = platform === "win32" ? win32 : posix;
  const manifest = ops.join(root, "runtime", "manifest.json");
  if (!existsSync(manifest)) {
    return { status: "warn", root, manifest, detail: NOT_INSTALLED };
  }
  const recorded = parseRecorded(manifest);
  if (recorded === null) {
    return {
      status: "warn",
      root,
      manifest,
      detail: "manifest unreadable: run npm run runtime:install",
    };
  }
  const missing = [recorded.node.path, recorded.pi.cliPath].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    return {
      status: "warn",
      root,
      manifest,
      detail: `files missing: ${missing.join(", ")}; run npm run runtime:install`,
    };
  }
  return {
    status: "ok",
    root,
    manifest,
    detail: "installed",
    node: recorded.node,
    pi: recorded.pi,
  };
}

interface Recorded {
  readonly node: { readonly version: string; readonly path: string };
  readonly pi: { readonly version: string; readonly cliPath: string };
}

function parseRecorded(manifest: string): Recorded | null {
  try {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as Partial<Record<string, unknown>>;
    if (value.schemaVersion !== 1) return null;
    const node = value.node as Record<string, unknown> | undefined;
    const pi = value.pi as Record<string, unknown> | undefined;
    if (node === undefined || pi === undefined) return null;
    if (
      typeof node.version !== "string" ||
      typeof node.path !== "string" ||
      typeof pi.version !== "string" ||
      typeof pi.cliPath !== "string"
    ) {
      return null;
    }
    return {
      node: { version: node.version, path: node.path },
      pi: { version: pi.version, cliPath: pi.cliPath },
    };
  } catch {
    return null;
  }
}
