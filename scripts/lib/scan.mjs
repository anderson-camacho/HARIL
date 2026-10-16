// Dependency-free source scanner used by the layer, purity and forbidden-construct checks.
// It masks comments, string literals, template text and regex literals before matching,
// so import-shaped text inside them never produces an edge. Template substitutions
// (`${...}`) stay code and are scanned.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "tests"]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const WORKSPACE_GROUPS = ["packages", "integrations", "apps"];
const BUILTIN_NAMES = new Set(builtinModules);

// Characters after which a `/` starts a regex literal rather than a division.
const PUNCTUATORS_BEFORE_REGEX = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const IMPORT_RE =
  /(?<![\w$.])import\s*(type(?=[\s{*])\s*)?((?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^{}]*\})?)\s*from\s*(['"])/g;
const EXPORT_RE =
  /(?<![\w$.])export\s*(type(?=[\s{*])\s*)?(\*(?:\s*as\s+[\w$]+)?|\{[^{}]*\})\s*from\s*(['"])/g;
const SIDE_EFFECT_RE = /(?<![\w$.])import\s*(['"])/g;
const DYNAMIC_RE = /(?<![\w$.])import\s*\(\s*/g;

/**
 * Masks comments, strings, template text and regex literals.
 * `code` has the same length and line breaks as `source`.
 * `literals` maps the opening-quote offset of each plain string literal to its raw value.
 * @param {string} source
 */
export function stripSource(source) {
  const state = { src: source, i: 0, out: source.split(""), literals: new Map(), prev: "" };
  scanCode(state, false);
  return { code: state.out.join(""), literals: state.literals };
}

function scanCode(state, inTemplateExpression) {
  const { src } = state;
  let depth = 0;
  while (state.i < src.length) {
    const c = src[state.i];
    const next = src[state.i + 1];
    if (c === "/" && next === "/") {
      const newline = src.indexOf("\n", state.i);
      const end = newline === -1 ? src.length : newline;
      blank(state.out, state.i, end);
      state.i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = src.indexOf("*/", state.i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(state.out, state.i, end);
      state.i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      readString(state);
      state.prev = ")";
      continue;
    }
    if (c === "`") {
      readTemplate(state);
      state.prev = ")";
      continue;
    }
    if (c === "/" && regexAllowedAfter(state.prev) && readRegex(state)) {
      state.prev = ")";
      continue;
    }
    if (/[\w$]/.test(c)) {
      const start = state.i;
      while (state.i < src.length && /[\w$]/.test(src[state.i])) state.i++;
      state.prev = src.slice(start, state.i);
      continue;
    }
    if (/\s/.test(c)) {
      state.i++;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (inTemplateExpression && depth === 0) return;
      depth--;
    }
    state.prev = c;
    state.i++;
  }
}

function readString(state) {
  const { src } = state;
  const start = state.i;
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote || ch === "\n") break;
    i++;
  }
  i = Math.min(i, src.length);
  blank(state.out, start + 1, i);
  if (i < src.length && src[i] === quote) {
    state.literals.set(start, { value: src.slice(start + 1, i), end: i + 1 });
    state.i = i + 1;
  } else {
    state.i = i;
  }
}

function readTemplate(state) {
  const { src } = state;
  let textStart = state.i + 1;
  let i = textStart;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      blank(state.out, textStart, i);
      state.i = i + 1;
      return;
    }
    if (ch === "$" && src[i + 1] === "{") {
      blank(state.out, textStart, i);
      state.i = i + 2;
      scanCode(state, true);
      state.i += 1;
      textStart = state.i;
      i = state.i;
      continue;
    }
    i++;
  }
  blank(state.out, textStart, src.length);
  state.i = src.length;
}

function readRegex(state) {
  const { src } = state;
  const start = state.i;
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return false;
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      break;
    }
    i++;
  }
  if (i >= src.length) return false;
  blank(state.out, start + 1, i);
  state.i = i + 1;
  return true;
}

function regexAllowedAfter(prev) {
  if (prev === "") return true;
  if (/^[\w$]/.test(prev)) return KEYWORDS_BEFORE_REGEX.has(prev);
  return PUNCTUATORS_BEFORE_REGEX.has(prev);
}

function blank(out, from, to) {
  for (let k = from; k < to; k++) {
    if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  }
}

function skipSpaces(text, from) {
  let p = from;
  while (p < text.length && /\s/.test(text[p])) p++;
  return p;
}

function isSoleArgument(code, from) {
  let p = skipSpaces(code, from);
  if (code[p] === ")") return true;
  if (code[p] !== ",") return false;
  p = skipSpaces(code, p + 1);
  return code[p] === ")";
}

export function lineAt(text, offset) {
  let line = 1;
  for (let k = 0; k < offset; k++) {
    if (text[k] === "\n") line++;
  }
  return line;
}

function isTypeOnlyClause(clause) {
  const trimmed = clause.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  const specifiers = trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return specifiers.length > 0 && specifiers.every((part) => /^type\s+\S/.test(part));
}

/**
 * Extracts module edges from one source file.
 * Edge kinds: "import" (static, side-effect), "export" (re-export), "dynamic" (import()).
 * A dynamic edge with `literal: false` has `specifier: null`.
 * @param {string} source
 */
export function scanSource(source) {
  const { code, literals } = stripSource(source);
  const edges = [];
  const push = (offset, data) => edges.push({ offset, line: lineAt(source, offset), ...data });

  for (const m of code.matchAll(IMPORT_RE)) {
    const lit = literals.get(m.index + m[0].length - 1);
    if (!lit) continue;
    push(m.index, {
      kind: "import",
      specifier: lit.value,
      typeOnly: Boolean(m[1]) || isTypeOnlyClause(m[2]),
      literal: true,
    });
  }
  for (const m of code.matchAll(EXPORT_RE)) {
    const lit = literals.get(m.index + m[0].length - 1);
    if (!lit) continue;
    push(m.index, {
      kind: "export",
      specifier: lit.value,
      typeOnly: Boolean(m[1]) || isTypeOnlyClause(m[2]),
      literal: true,
    });
  }
  for (const m of code.matchAll(SIDE_EFFECT_RE)) {
    const lit = literals.get(m.index + m[0].length - 1);
    if (!lit) continue;
    push(m.index, { kind: "import", specifier: lit.value, typeOnly: false, literal: true });
  }
  for (const m of code.matchAll(DYNAMIC_RE)) {
    const lit = literals.get(m.index + m[0].length);
    const literal = Boolean(lit) && isSoleArgument(code, lit.end);
    push(m.index, {
      kind: "dynamic",
      specifier: literal ? lit.value : null,
      typeOnly: false,
      literal,
    });
  }

  edges.sort((a, b) => a.offset - b.offset);
  return { edges };
}

function toPosix(path) {
  return path.split(sep).join("/");
}

export function relPosix(rootDir, absPath) {
  return toPosix(relative(rootDir, absPath));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Lists source files under `dir`, skipping node_modules, dist, tests and *.test.* files.
 * @param {string} dir
 * @returns {string[]} absolute paths, sorted by directory walk order
 */
export function listSourceFiles(dir) {
  if (!isDirectory(dir)) return [];
  const files = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extname(entry.name)) &&
        !TEST_FILE.test(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * Maps a workspace directory (relative, posix) to its layer, or null when unassigned.
 * @param {string} rel e.g. "integrations/git"
 */
function classifyWorkspace(rel) {
  if (rel === "packages/contracts") return { kind: "contracts", layer: 0 };
  if (rel === "packages/core") return { kind: "core", layer: 1 };
  if (rel.startsWith("integrations/")) return { kind: "integration", layer: 2 };
  if (rel.startsWith("apps/")) return { kind: "app", layer: 3 };
  return null;
}

/**
 * Discovers every workspace (a directory with package.json) under packages/, integrations/ and apps/.
 * Unassigned workspaces are returned with `kind` undefined so callers can report them.
 * @param {string} rootDir
 */
export function discoverWorkspaces(rootDir) {
  const workspaces = [];
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(rootDir, group);
    if (!isDirectory(groupDir)) continue;
    for (const entry of readdirSync(groupDir).sort()) {
      const dir = join(groupDir, entry);
      const manifest = join(dir, "package.json");
      if (!isDirectory(dir) || !isFile(manifest)) continue;
      const rel = `${group}/${entry}`;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      workspaces.push({ rel, dir, name: pkg.name, pkg, ...(classifyWorkspace(rel) ?? {}) });
    }
  }
  return workspaces;
}

/**
 * Resolves an edge specifier as seen from `fromFile`.
 * Returns one of:
 *   { kind: "builtin", name }                      node:* or bare Node builtin
 *   { kind: "external", name }                     npm package
 *   { kind: "unknown", name }                      @haril/* name with no workspace
 *   { kind: "internal", ws, abs, reachesSrc }     workspace file; reachesSrc: specifier points into src/
 *                                                 (ws null when outside every workspace)
 * @param {string} specifier
 * @param {string} fromFile absolute path of the importing file
 * @param {{ rootDir: string, workspaces: object[], byName: Map<string, object> }} ctx
 */
export function resolveSpecifier(specifier, fromFile, ctx) {
  if (specifier.startsWith("node:")) return { kind: "builtin", name: specifier.slice(5) };
  if (/^\.\.?(\/|$)/.test(specifier) || specifier.startsWith("/")) {
    const abs = resolve(dirname(fromFile), specifier);
    const ws = workspaceOfPath(abs, ctx);
    const reachesSrc = ws !== null && relPosix(ctx.rootDir, abs).startsWith(`${ws.rel}/src/`);
    return { kind: "internal", abs, ws, reachesSrc };
  }
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const subpath = parts.slice(nameLength).join("/");
  const ws = ctx.byName.get(name);
  if (ws) {
    const reachesSrc = subpath === "src" || subpath.startsWith("src/");
    return { kind: "internal", abs: subpathToPath(ws, subpath), ws, reachesSrc };
  }
  if (name.startsWith("@haril/")) return { kind: "unknown", name };
  if (BUILTIN_NAMES.has(specifier) || BUILTIN_NAMES.has(parts[0])) {
    return { kind: "builtin", name: specifier };
  }
  return { kind: "external", name };
}

/** Maps a package subpath to a file path: "" is the root index, "x" is src/x, "src/..." is literal. */
function subpathToPath(ws, subpath) {
  if (subpath === "") return join(ws.dir, "src", "index.ts");
  if (subpath === "src" || subpath.startsWith("src/")) return join(ws.dir, subpath);
  return join(ws.dir, "src", subpath);
}

function workspaceOfPath(abs, ctx) {
  const rel = relPosix(ctx.rootDir, abs);
  let best = null;
  for (const ws of ctx.workspaces) {
    const inside = rel === ws.rel || rel.startsWith(`${ws.rel}/`);
    if (inside && (best === null || ws.rel.length > best.rel.length)) best = ws;
  }
  return best;
}

/** Builds the resolution context shared by the checkers. */
export function buildContext(rootDir, workspaces) {
  return { rootDir, workspaces, byName: new Map(workspaces.map((ws) => [ws.name, ws])) };
}

/** Prints violations and exits 1 when there are any; prints a summary otherwise. */
export function reportAndExit(label, violations) {
  if (violations.length === 0) {
    console.log(`${label}: ok`);
    return;
  }
  for (const v of violations) {
    const where = v.line ? `${v.file}:${v.line}` : v.file;
    console.error(`${where}  [${v.rule}]  ${v.message}`);
  }
  console.error(`${label}: ${violations.length} violation(s)`);
  process.exit(1);
}

/** True when the module at `metaUrl` is the process entry point (for CLI use). */
export function isEntryPoint(metaUrl) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(metaUrl);
}
