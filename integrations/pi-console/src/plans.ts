import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { type SavedResearch, saveResearch } from "./research.js";

// Saved plans: the plans the user keeps for DELEGATION, one Markdown file each under <project root>/docs/planes. A plan
// is saved on request (/save-plan, or haril_save_plan when the user asks the model), with the same rules as a research
// file (research.ts): a title, never a path; never over an existing file; at most 200 KB; nothing outside the project.
// DELEGATION lists them first when it asks for the plan a workflow starts from, newest first.

export const PLANS_DIR = join("docs", "planes");
// How many saved plans DELEGATION offers at once.
const PLANS_LISTED = 10;
const TITLE_MAX = 60;

export interface SavedPlanFile {
  // The path from the project root, as DELEGATION shows it and its source id names it.
  readonly relative: string;
  readonly title: string;
  readonly modifiedAt: number;
}

export function savePlan(
  root: string,
  input: { readonly title: unknown; readonly content: unknown },
  now: Date = new Date(),
): SavedResearch {
  return saveResearch(root, input, now, PLANS_DIR);
}

// The plan's first heading or first line, without Markdown marks: the title a save takes when none is given and the
// label DELEGATION shows.
export function planTitle(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((item) =>
        item
          .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
          .replace(/[*_`]/g, "")
          .trim(),
      )
      .find((item) => item !== "") ?? "";
  const clean = line
    .replace(/[\\/]/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/^[A-Za-z]:/, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean || "plan";
}

function plansDir(root: string): string | undefined {
  try {
    const realRoot = realpathSync(root);
    const dir = realpathSync(join(root, PLANS_DIR));
    const fold = (text: string): string =>
      process.platform === "win32" ? text.toLowerCase() : text;
    return fold(dir).startsWith(fold(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`))
      ? dir
      : undefined;
  } catch {
    return undefined;
  }
}

// The saved plans of the project, newest first. A folder that is missing or resolves outside the project lists none.
export function listPlans(root: string, limit: number = PLANS_LISTED): SavedPlanFile[] {
  const dir = plansDir(root);
  if (dir === undefined) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  const plans: SavedPlanFile[] = [];
  for (const name of names) {
    try {
      const path = join(dir, name);
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      plans.push({
        relative: join(PLANS_DIR, name),
        title: planTitle(readFileSync(path, "utf8")),
        modifiedAt: stat.mtimeMs,
      });
    } catch {
      // A file that cannot be read is not offered.
    }
  }
  return plans
    .sort((a, b) => b.modifiedAt - a.modifiedAt || b.relative.localeCompare(a.relative))
    .slice(0, limit);
}

// The text of a saved plan DELEGATION listed; undefined when it is gone, empty or not one of the listed files.
export function readPlan(root: string, relative: string): string | undefined {
  const dir = plansDir(root);
  if (dir === undefined) return undefined;
  const name = relative.split(/[\\/]/).at(-1) ?? "";
  if (join(PLANS_DIR, name) !== relative || !name.toLowerCase().endsWith(".md")) return undefined;
  try {
    const text = readFileSync(join(dir, name), "utf8");
    return text.trim() === "" ? undefined : text;
  } catch {
    return undefined;
  }
}
