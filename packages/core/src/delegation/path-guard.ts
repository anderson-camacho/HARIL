import { pathMatchesSurface } from "./globs.js";

// The lexical half of the workspace PathGuard (docs/modos-y-delegacion.md 3.10.5 and section 8; phase F8). An agent that
// writes names a path relative to its git worktree; this pure rule decides whether the path may be written before the
// host touches the filesystem: never absolute, never a drive, a share or an alternate stream, never climbing out with
// "..", never .git, .haril or .pi, never a file that looks like a secret, never a name Windows reserves or a Windows short
// name (a tilde and a digit, which NTFS may resolve to .git), and always inside
// the task's declared write surface (its files.write globs). The host then checks the filesystem itself: every existing
// component is a plain directory (no symbolic link, no junction) and the real location stays inside the worktree.
// Backslashes count as separators, so "src\a.ts" and "src/a.ts" are the same path. Never throws.

export type WorkspacePathDenial =
  | "empty_path"
  | "too_long"
  | "control_character"
  | "invalid_character"
  | "absolute_path"
  | "drive_or_stream"
  | "traversal"
  | "denied_path"
  | "secret_path"
  | "reserved_name"
  | "trailing_dot_or_space"
  | "short_name"
  | "outside_surface";

export type WorkspacePathCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: WorkspacePathDenial };

// The longest path an agent may name, in characters.
export const WORKSPACE_PATH_MAX_LENGTH = 1024;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const CONTROL = /[\u0000-\u001f\u007f]/;
// Characters Windows forbids in a name; "*" and "?" would also read as wildcards in a surface.
const INVALID = /[<>"|?*]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// A Windows 8.3 short name ("GIT~1", "ENV~1"): NTFS may answer to it for any long name, .git included, so a tilde
// followed by a digit is refused in every segment on every platform.
const SHORT_NAME = /~\d/;
// Folders HARIL never lets an agent touch: the repository's own data, HARIL's and Pi's.
const DENIED_SEGMENTS = new Set([".git", ".haril", ".pi"]);
// Folders and names that hold credentials by convention.
const SECRET_SEGMENTS = new Set([".ssh", ".aws", ".gnupg"]);
const SECRET_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const ENV_FILE = /^\.env(\..+)?$/i;
const SECRET_EXTENSION = /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i;

function deny(reason: WorkspacePathDenial): WorkspacePathCheck {
  return { ok: false, reason };
}

function segmentProblem(segment: string): WorkspacePathDenial | null {
  const lower = segment.toLowerCase();
  if (SHORT_NAME.test(segment)) return "short_name";
  if (DENIED_SEGMENTS.has(lower)) return "denied_path";
  if (SECRET_SEGMENTS.has(lower) || SECRET_NAMES.has(lower)) return "secret_path";
  if (ENV_FILE.test(segment) || SECRET_EXTENSION.test(segment)) return "secret_path";
  if (/[. ]$/.test(segment)) return "trailing_dot_or_space";
  if (RESERVED_NAME.test(segment.split(".")[0] ?? "")) return "reserved_name";
  return null;
}

// Checks a path an agent asks to write against its task's write surface. On success the path comes back normalized:
// "/" separators, no empty, "." or ".." segment, relative to the worktree.
export function checkWorkspacePath(
  requested: string,
  surface: readonly string[],
): WorkspacePathCheck {
  if (typeof requested !== "string" || requested.trim() === "") return deny("empty_path");
  if (requested.length > WORKSPACE_PATH_MAX_LENGTH) return deny("too_long");
  if (CONTROL.test(requested)) return deny("control_character");
  const text = requested.replace(/\\/g, "/");
  if (text.startsWith("/")) return deny("absolute_path");
  // A colon is a drive ("C:"), an alternate data stream ("a.txt:secret") or a device form: never part of a path here.
  if (text.includes(":")) return deny("drive_or_stream");
  if (INVALID.test(text)) return deny("invalid_character");
  const segments = text.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return deny("empty_path");
  if (segments.some((segment) => segment === "..")) return deny("traversal");
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem !== null) return deny(problem);
  }
  const path = segments.join("/");
  return pathMatchesSurface(path, surface) ? { ok: true, path } : deny("outside_surface");
}
