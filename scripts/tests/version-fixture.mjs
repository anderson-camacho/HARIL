// Shared fixture for the version script tests: a temporary tree with every version string, and an optional git
// repository around it. Nothing here touches the real repository; every tree lives under the OS temp folder.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function writeAt(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function readAt(root, relative) {
  return readFileSync(join(root, relative), "utf8");
}

const manifest = (name, version) =>
  `{\n  "name": "${name}",\n  "version": "${version}",\n  "private": true\n}\n`;

export function changelog(entries) {
  const body = entries
    .map(
      ({ version, date = "2026-10-01", estado = "Listo." }) =>
        `## ${version}\n\n- **Fecha:** ${date}\n- **Estado:** ${estado}\n\n### Añadido\n\n- Algo de ${version}.\n`,
    )
    .join("\n---\n\n");
  return `# Changelog de HARIL, versión mayor 0\n\nLas versiones van de la más reciente a la más antigua.\n\n---\n\n${body}`;
}

export function versionsReadme(version, low = "0.1.0") {
  return [
    "# Versiones de HARIL",
    "",
    "## Estado actual",
    "",
    `- **Versión actual:** ${version}.`,
    "- **Estado:** algo que el autor describe.",
    "",
    "## Carpetas por versión mayor",
    "",
    `- [v0](v0/CHANGELOG.md): versiones ${low} a ${version}.`,
    "",
  ].join("\n");
}

// Every file that carries the version, all at `version`, plus a changelog whose top entry is that version.
export function writeVersionTree(root, version, { previous = ["0.1.0"] } = {}) {
  writeAt(root, "package.json", manifest("fixture-monorepo", version));
  writeAt(root, "apps/haril/package.json", manifest("haril", version));
  writeAt(root, "apps/bootstrap/package.json", manifest("bootstrap", version));
  writeAt(root, "apps/shell/package.json", manifest("shell", version));
  writeAt(
    root,
    "apps/haril/src/version.ts",
    `// Must equal the version in apps/haril/package.json.\nexport const VERSION = "${version}";\n`,
  );
  writeAt(
    root,
    "README.md",
    `# Fixture\n\nTexto.\n\nVersión actual: **${version}**. El estado está en otro lado.\n`,
  );
  writeAt(root, "versions/README.md", versionsReadme(version));
  writeAt(
    root,
    "versions/v0/CHANGELOG.md",
    changelog([{ version }, ...previous.map((item) => ({ version: item }))]),
  );
  writeAt(root, "src/code.ts", "export const value = 1;\n");
}

export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "haril-version-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A git repository on main with one commit of the version tree.
export function gitSandbox(version) {
  const box = sandbox();
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: box.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Version Test");
  git("config", "user.email", "version-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeVersionTree(box.root, version);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { ...box, git, commit, base: git("rev-parse", "HEAD") };
}

export function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    text: () => [...out, ...err].join("\n"),
  };
}
