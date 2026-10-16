// Purity checker (R7): the contracts and core layers must not read the clock, randomness or the process.
// The compiler cannot see these calls when they come through the ES library, so they are matched textually
// after comments, strings and regex literals are masked. Usage: node scripts/check-purity.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isEntryPoint,
  lineAt,
  listSourceFiles,
  relPosix,
  reportAndExit,
  stripSource,
} from "./lib/scan.mjs";

const PURE_DIRS = ["packages/contracts/src", "packages/core/src"];

const FORBIDDEN_APIS = [
  [/(?<![\w$])Date\s*\.\s*now\b/g, "Date.now"],
  [/(?<![\w$])new\s+Date\s*\(/g, "new Date("],
  [/(?<![\w$])Math\s*\.\s*random\b/g, "Math.random"],
  [/(?<![\w$])performance\s*\.\s*now\b/g, "performance.now"],
  [/(?<![\w$])crypto\s*\.\s*randomUUID\b/g, "crypto.randomUUID"],
  [/(?<![\w$])process\s*\./g, "process."],
];

/**
 * @param {string} rootDir repository root
 * @returns {{ rule: string, file: string, line: number, message: string }[]}
 */
export function checkPurity(rootDir) {
  const violations = [];
  for (const dir of PURE_DIRS) {
    for (const file of listSourceFiles(join(rootDir, dir))) {
      const { code } = stripSource(readFileSync(file, "utf8"));
      for (const [pattern, label] of FORBIDDEN_APIS) {
        for (const match of code.matchAll(pattern)) {
          violations.push({
            rule: "R7",
            file: relPosix(rootDir, file),
            line: lineAt(code, match.index),
            message: `${label} is impure; contracts and core must not use it`,
          });
        }
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (isEntryPoint(import.meta.url)) {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  reportAndExit("check-purity", checkPurity(REPO_ROOT));
}
