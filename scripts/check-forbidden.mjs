// Forbidden-construct checker: no eval, no new Function, and no import() whose argument is not a single
// string literal, in any workspace src. Usage: node scripts/check-forbidden.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverWorkspaces,
  isEntryPoint,
  lineAt,
  listSourceFiles,
  relPosix,
  reportAndExit,
  scanSource,
  stripSource,
} from "./lib/scan.mjs";

const FORBIDDEN_CALLS = [
  [/(?<![\w$])eval\s*\(/g, "eval("],
  [/(?<![\w$])new\s+Function\s*\(/g, "new Function("],
];

/**
 * @param {string} rootDir repository root
 * @returns {{ rule: string, file: string, line: number, message: string }[]}
 */
export function checkForbidden(rootDir) {
  const violations = [];
  for (const ws of discoverWorkspaces(rootDir)) {
    if (ws.kind === undefined) continue;
    for (const file of listSourceFiles(join(ws.dir, "src"))) {
      const source = readFileSync(file, "utf8");
      const rel = relPosix(rootDir, file);
      const { code } = stripSource(source);
      for (const [pattern, label] of FORBIDDEN_CALLS) {
        for (const match of code.matchAll(pattern)) {
          violations.push({
            rule: "FORBIDDEN",
            file: rel,
            line: lineAt(code, match.index),
            message: `${label} is forbidden`,
          });
        }
      }
      for (const edge of scanSource(source).edges) {
        if (edge.kind === "dynamic" && !edge.literal) {
          violations.push({
            rule: "FORBIDDEN",
            file: rel,
            line: edge.line,
            message: "import() argument must be a single string literal",
          });
        }
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (isEntryPoint(import.meta.url)) {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  reportAndExit("check-forbidden", checkForbidden(REPO_ROOT));
}
