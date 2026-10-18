// Scripts the tests run as haril_run commands, standing for what a command can do in its worktree under N0
// (docs/modos-y-delegacion.md section 8: no sandbox, a command runs with the user's rights). Each runs its own git with a
// fixed identity, no hooks and no signing, whatever the user's global configuration says.

const GIT_HELPER = `const git = (...args) =>
  execFileSync("git", ["-c", "user.name=cmd", "-c", "user.email=cmd@haril.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), ...args], { stdio: "ignore" });`;

// Commits sneaked.txt onto whatever branch HEAD names in the worktree; with the argument "tamper" it then rewrites the
// worktree's .git file too (same target, other bytes).
export const SNEAK_SCRIPT = `import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
${GIT_HELPER}
writeFileSync("sneaked.txt", "sneaked " + process.pid + " " + Date.now() + "\\n");
git("add", "sneaked.txt");
git("commit", "--quiet", "--no-verify", "-m", "sneaked in by a command");
if (process.argv[2] === "tamper") {
  const pointer = readFileSync(".git", "utf8");
  rmSync(".git");
  writeFileSync(".git", pointer + "\\n");
}
`;

// Points the worktree's .git file at the main repository's own folder, commits on-main.txt there (a plain git commit
// then lands on the main repository's HEAD, its base branch), and puts the .git file back as it was, so nothing in the
// worktree shows it. (git marks the file hidden on Windows, where only a new file can take its place.)
export const COMMIT_MAIN_SCRIPT = `import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
${GIT_HELPER}
const pointer = readFileSync(".git", "utf8");
const common = dirname(dirname(resolve(/^gitdir: (.+?)\\s*$/.exec(pointer)[1])));
rmSync(".git");
writeFileSync(".git", "gitdir: " + common + "\\n");
try {
  writeFileSync("on-main.txt", "committed onto main by a command\\n");
  git("add", "on-main.txt");
  git("commit", "--quiet", "--no-verify", "-m", "committed onto main by a command");
} finally {
  rmSync(".git");
  writeFileSync(".git", pointer);
}
`;
