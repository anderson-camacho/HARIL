// Reading the version of an installed binary by running its read-only version command.

export interface ExecResult {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  // The process could not start (missing, not executable).
  readonly error?: string;
}

export type RunCommand = (file: string, args: readonly string[]) => Promise<ExecResult>;

export type VersionRead = { readonly version: string } | { readonly error: string };

// `engram version` and `gentle-ai version` print "<name> <x.y.z>" and exit 0 without any network access (both
// observed on engram 3.3.2 and gentle-ai 4.0.0); `--version` prints the same, so it is the fallback.
const VERSION_COMMANDS: readonly (readonly string[])[] = [["version"], ["--version"]];

// The first x.y.z after the tool's name on the same line, or an output that is nothing but a version. Another
// program's version (a "go version" line, another tool's name) is never taken for the tool's.
export function parseToolVersion(output: string, tool: string): string | undefined {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(
    `(?<![\\w-])${escaped}(?![\\w-])[^\\n\\d]{0,80}?v?(\\d+\\.\\d+\\.\\d+)`,
    "i",
  );
  const match = named.exec(output);
  if (match?.[1] !== undefined) return match[1];
  return /^\s*v?(\d+\.\d+\.\d+)\s*$/.exec(output)?.[1];
}

export async function readInstallVersion(
  path: string,
  tool: string,
  run: RunCommand,
): Promise<VersionRead> {
  let failure = "no version in the output";
  for (const args of VERSION_COMMANDS) {
    const result = await run(path, args);
    // A binary that cannot start will not start with other arguments either.
    if (result.error !== undefined) return { error: result.error };
    if (result.timedOut) return { error: "timed out" };
    if (result.code === 0) {
      const version = parseToolVersion(result.output, tool);
      if (version !== undefined) return { version };
      failure = "no version in the output";
    } else {
      failure = `exit ${result.code ?? "unknown"}`;
    }
  }
  return { error: failure };
}
