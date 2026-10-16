#!/usr/bin/env node
// Generates the pinned-versions table of docs/COMPATIBILITY.md (M3-T5, criterion 14). The pins stay where they
// are: root package.json (packageManager, devDependencies), packages/contracts/package.json (typebox) and the
// bootstrap constants (Node and Pi, read with a strict regex). Usage: generate-compat.mjs [--check]
// `--check` writes nothing and exits 1 when the generated section no longer matches the pins; it passes with a
// notice when the document is absent (public export without docs/).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = "docs/COMPATIBILITY.md";
const BOOTSTRAP_CONSTANTS = "apps/bootstrap/src/constants.ts";
const BEGIN = "<!-- BEGIN GENERATED: versions -->";
const END = "<!-- END GENERATED: versions -->";
const EXACT = /^\d+\.\d+\.\d+$/;
const VERIFIED_IN_CI = "sí, en CI";
const PENDING_USER = "no, pendiente del usuario";

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
}

function exactPin(version, label) {
  if (typeof version !== "string" || !EXACT.test(version)) {
    throw new Error(`${label} is not an exact pin (found ${JSON.stringify(version)})`);
  }
  return version;
}

function bootstrapConstant(source, name) {
  const match = source.match(new RegExp(`^export const ${name} = "(\\d+\\.\\d+\\.\\d+)";$`, "m"));
  if (match === null) throw new Error(`${name} not found in ${BOOTSTRAP_CONSTANTS}`);
  return match[1];
}

function pin(component, version, origin, verified) {
  return { component, version, origin, verified };
}

// The pinned versions in document order. Node and Pi are verified only by the user's real lane (pending).
export function readPins(root = REPO_ROOT) {
  const pkg = readJson(root, "package.json");
  const contracts = readJson(root, "packages/contracts/package.json");
  const constants = readFileSync(join(root, BOOTSTRAP_CONSTANTS), "utf8");
  const devDependencies = pkg.devDependencies ?? {};
  const packageManager = /^pnpm@(.+)$/.exec(String(pkg.packageManager ?? ""));
  if (packageManager === null) throw new Error("package.json packageManager is not pnpm@<version>");
  return [
    pin(
      "Node",
      bootstrapConstant(constants, "NODE_VERSION"),
      `Bootstrap, Node aislado (\`${BOOTSTRAP_CONSTANTS}\`)`,
      PENDING_USER,
    ),
    pin(
      "Pi",
      bootstrapConstant(constants, "PI_VERSION"),
      `Bootstrap, paquete \`@earendil-works/pi-coding-agent\` (\`${BOOTSTRAP_CONSTANTS}\`)`,
      PENDING_USER,
    ),
    pin(
      "pnpm",
      exactPin(packageManager[1], "packageManager pnpm"),
      "`package.json`, `packageManager`",
      VERIFIED_IN_CI,
    ),
    pin(
      "TypeScript",
      exactPin(devDependencies.typescript, "devDependencies.typescript"),
      "`package.json`, `devDependencies`",
      VERIFIED_IN_CI,
    ),
    pin(
      "typebox",
      exactPin(contracts.dependencies?.typebox, "dependencies.typebox"),
      "`packages/contracts/package.json`, `dependencies`",
      VERIFIED_IN_CI,
    ),
    pin(
      "Vitest",
      exactPin(devDependencies.vitest, "devDependencies.vitest"),
      "`package.json`, `devDependencies`",
      VERIFIED_IN_CI,
    ),
    pin(
      "Biome",
      exactPin(devDependencies["@biomejs/biome"], "devDependencies.@biomejs/biome"),
      "`package.json`, `devDependencies`",
      VERIFIED_IN_CI,
    ),
    pin(
      "knip",
      exactPin(devDependencies.knip, "devDependencies.knip"),
      "`package.json`, `devDependencies`",
      VERIFIED_IN_CI,
    ),
    pin(
      "tsdown",
      exactPin(devDependencies.tsdown, "devDependencies.tsdown"),
      "`package.json`, `devDependencies`",
      VERIFIED_IN_CI,
    ),
  ];
}

export function renderSection(pins) {
  const rows = pins.map(
    (row) => `| ${row.component} | ${row.version} | ${row.origin} | ${row.verified} |`,
  );
  return [
    BEGIN,
    "",
    "Sección generada por `scripts/generate-compat.mjs` desde las versiones fijadas. No editar a mano: ejecute `npm run generate:compat`.",
    "",
    "| Componente | Versión fijada | Origen | Verificado |",
    "|---|---|---|---|",
    ...rows,
    END,
  ].join("\n");
}

// Replaces the marked block and nothing else. Fails unless the document has exactly one marker pair.
export function replaceSection(doc, section) {
  const begin = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  const repeated = begin === -1 ? false : doc.indexOf(BEGIN, begin + BEGIN.length) !== -1;
  if (begin === -1 || end === -1 || end < begin || repeated) {
    throw new Error(`${DOC} needs exactly one marker pair: ${BEGIN} ... ${END}`);
  }
  return doc.slice(0, begin) + section + doc.slice(end + END.length);
}

function firstDifference(before, after) {
  const left = before.split("\n");
  const right = after.split("\n");
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index++) {
    if (left[index] !== right[index]) {
      return {
        number: index + 1,
        actual: left[index] ?? "(missing)",
        expected: right[index] ?? "(missing)",
      };
    }
  }
  return { number: 0, actual: "", expected: "" };
}

export function main(
  argv = [],
  { root = REPO_ROOT, stdout = console.log, stderr = console.error } = {},
) {
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    stderr("usage: generate-compat.mjs [--check]");
    return 2;
  }
  const check = argv.includes("--check");
  const docPath = join(root, DOC);
  // The public export carries no docs/ tree: the check is skipped there, while generation still fails.
  if (check && !existsSync(docPath)) {
    stdout(`${DOC} no existe en este árbol: comprobación de versiones omitida.`);
    return 0;
  }
  try {
    const doc = readFileSync(docPath, "utf8");
    const next = replaceSection(doc, renderSection(readPins(root)));
    if (check) {
      if (next === doc) {
        stdout(`${DOC}: generated versions are up to date`);
        return 0;
      }
      const diff = firstDifference(doc, next);
      stderr(
        `${DOC}: generated versions section is stale (first difference at line ${diff.number}).`,
      );
      stderr(`  current:  ${diff.actual}`);
      stderr(`  expected: ${diff.expected}`);
      stderr('Run "npm run generate:compat" and commit the result.');
      return 1;
    }
    if (next !== doc) writeFileSync(docPath, next, "utf8");
    stdout(`${DOC}: generated versions section ${next === doc ? "unchanged" : "written"}`);
    return 0;
  } catch (error) {
    stderr(`generate-compat: ${error.message}`);
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main(process.argv.slice(2));
}
