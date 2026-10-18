import { basename, resolve, sep } from "node:path";
import { runHarilJson } from "./cli.js";

// The project of the folder Pi opened in: the registered project whose root is that folder or its nearest ancestor
// (`haril project list --json`). Paths compare case-insensitively on Windows, where the file system does.

export interface BoundProject {
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
}

interface ListedProject {
  readonly slug?: unknown;
  readonly name?: unknown;
  readonly rootPath?: unknown;
}

function comparable(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function contains(root: string, path: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}

// The nearest registered root at or above `cwd`, or undefined when none is (or the CLI cannot answer).
export async function findProject(cwd: string): Promise<BoundProject | undefined> {
  const listed = await runHarilJson(["project", "list", "--json"]);
  const projects = (listed as { projects?: unknown } | undefined)?.projects;
  if (!Array.isArray(projects)) return undefined;
  const here = comparable(cwd);
  let best: BoundProject | undefined;
  let bestLength = -1;
  for (const item of projects as ListedProject[]) {
    if (typeof item.slug !== "string" || typeof item.rootPath !== "string") continue;
    const root = comparable(item.rootPath);
    if (!contains(root, here) || root.length <= bestLength) continue;
    best = {
      slug: item.slug,
      name: typeof item.name === "string" ? item.name : item.slug,
      rootPath: item.rootPath,
    };
    bestLength = root.length;
  }
  return best;
}

// What the bar names when no project is bound: the folder itself.
export function folderName(cwd: string): string {
  return basename(resolve(cwd)) || cwd;
}
