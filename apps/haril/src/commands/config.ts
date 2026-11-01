import {
  DEFAULT_UI_LOCALE,
  type DelegationField,
  type DelegationFieldValue,
  delegationField,
  delegationSectionErrors,
  resolveDelegationSettings,
} from "@haril/contracts";
import { argsProblem, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { delegationFieldsOf } from "../delegation-section.js";
import { docsFolderState, docsPathText } from "../docs-config.js";
import { configDocumentErrors, harilConfigPath } from "../providers.js";
import { readConfigDocument, serializeConfig, writeConfigAtomically } from "./config-file.js";

// `haril config get [<path>]` and `haril config set <path> <value> | --reset` (docs/modos-y-delegacion.md 6, 7.7;
// phase F7). get shows one value or a whole group, each value with its source: haril.json, or the default. Other keys of
// the file are shown as they are. set changes delegation settings, ui.locale, ui.theme or docs.path: the value is read
// for its field (a number, a list, a level...), the whole resulting file is checked by the rules every reader applies,
// then written, keeping every other key and the file's formatting, through a temporary file renamed over it. --reset
// removes the value so the default applies again (docs.path has none: the folder is disconnected). Only delegation
// settings and safe preferences can be set: provider key variables are edited by hand, and no key is ever written (a
// file that holds one is refused). docs.path is the documentation folder the DOCS tab shows (an Obsidian vault kept
// outside HARIL; HARIL only reads it): it must be an absolute path to an existing directory at the moment it is set,
// while reading the file never looks at the folder. The console's Delegation section and DOCS tab edit through this
// command.

const USAGE = [
  "usage: haril config get [<path>] [--json]",
  "       haril config set <path> <value> [--json]",
  "       haril config set <path> --reset [--json]",
  "  get shows a value, or every value of a group (default: delegation), with its source (haril.json or the default).",
  "  set changes delegation settings, ui.locale, ui.theme or docs.path after checking the file; --reset restores defaults.",
  "  docs.path is the folder with your documentation (for example an Obsidian vault): an absolute path to an existing",
  "  directory. haril only reads it. --reset disconnects it.",
].join("\n");

const SOURCE_FILE = "haril.json";
const SECTION = "delegation";

function fail(io: CliIo, message: string): number {
  io.err(`haril: ${message}`);
  return EXIT_USAGE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shown(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function sourceText(field: DelegationFieldValue, configured: unknown): string {
  const inherits =
    field.kind.type === "integer" && field.kind.inherits !== undefined
      ? `${SECTION}.${field.kind.inherits}`
      : undefined;
  const from = field.source === "file" ? SOURCE_FILE : "default";
  return inherits !== undefined && (configured === undefined || configured === null)
    ? `${from}: inherits ${inherits}`
    : from;
}

function valueAt(root: unknown, parts: readonly string[]): unknown {
  let node = root;
  for (const part of parts) {
    if (Array.isArray(node) && /^\d+$/.test(part)) node = node[Number(part)];
    else if (isRecord(node) && part in node) node = node[part];
    else return undefined;
  }
  return node;
}

function uiLocaleField(document: Record<string, unknown>): {
  value: unknown;
  source: "default" | "file";
} {
  const configured = valueAt(document, ["ui", "locale"]);
  return configured === undefined
    ? { value: DEFAULT_UI_LOCALE, source: "default" }
    : { value: configured, source: "file" };
}

function uiThemeField(document: Record<string, unknown>): {
  value: unknown;
  source: "default" | "file";
} {
  const configured = valueAt(document, ["ui", "theme"]);
  return configured === undefined
    ? { value: "magic", source: "default" }
    : { value: configured, source: "file" };
}

// docs.path has no default: without it no folder is connected, which `get` says as "unset" (the convention for the
// keys outside the defaults) and `set` prints as "not set".
function docsPathField(document: Record<string, unknown>): {
  value: unknown;
  source: "unset" | "file";
} {
  const configured = valueAt(document, ["docs", "path"]);
  return configured === undefined
    ? { value: null, source: "unset" }
    : { value: configured, source: "file" };
}

export async function config(args: readonly string[], io: CliIo, host: HostInfo): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "get") return configGet(rest, io, host);
  if (verb === "set") return configSet(rest, io, host);
  io.err(USAGE);
  return EXIT_USAGE;
}

function configGet(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 1) return fail(io, USAGE);
  const path = parsed.positionals[0] ?? SECTION;
  const json = parsed.flags.has("--json");
  const configPath = harilConfigPath(host).path;
  const read = readConfigDocument(configPath);
  if (!read.ok) return fail(io, `${configPath}: ${read.error}`);
  const document = read.document;

  if (path === "ui.locale" || path === "ui.theme") {
    const errors = configDocumentErrors(document).filter((error) => error.startsWith("/ui"));
    if (errors.length > 0) {
      io.err(`haril: ${configPath} has problems; fix them first (haril doctor lists them):`);
      for (const error of errors) io.err(`  ${error}`);
      return EXIT_USAGE;
    }
    const preference = path === "ui.locale" ? uiLocaleField(document) : uiThemeField(document);
    const fallback = path === "ui.locale" ? DEFAULT_UI_LOCALE : "magic";
    if (json) {
      io.out(JSON.stringify({ path, ...preference, default: fallback, configPath }));
    } else {
      io.out(
        `${path} = ${shown(preference.value)}  (${preference.source === "file" ? SOURCE_FILE : "default"})`,
      );
    }
    return EXIT_OK;
  }

  if (path !== SECTION && !path.startsWith(`${SECTION}.`)) {
    if (path === "docs" || path.startsWith("docs.")) {
      const errors = configDocumentErrors(document).filter((error) => error.startsWith("/docs"));
      if (errors.length > 0) {
        io.err(`haril: ${configPath} has problems; fix them first (haril doctor lists them):`);
        for (const error of errors) io.err(`  ${error}`);
        return EXIT_USAGE;
      }
    }
    const value = valueAt(document, path.split("."));
    if (json) {
      io.out(
        JSON.stringify({
          path,
          value: value ?? null,
          source: value === undefined ? "unset" : "file",
          configPath,
        }),
      );
    } else {
      io.out(
        value === undefined ? `${path} is not set` : `${path} = ${shown(value)}  (${SOURCE_FILE})`,
      );
    }
    return EXIT_OK;
  }

  const section = document.delegation;
  if (section !== undefined) {
    const errors = delegationSectionErrors(section);
    if (errors.length > 0) {
      io.err(`haril: ${configPath} has problems; fix them first (haril doctor lists them):`);
      for (const error of errors) io.err(`  ${error}`);
      return EXIT_USAGE;
    }
  }
  const fields = delegationFieldsOf(document);
  const relative = path === SECTION ? "" : path.slice(SECTION.length + 1);
  const leaf = fields.find((field) => field.path === path);
  const group = fields.filter((field) => relative === "" || field.path.startsWith(`${path}.`));
  if (leaf === undefined && group.length === 0) {
    return fail(io, `unknown setting ${path} (haril config get ${SECTION} lists them)`);
  }
  const configuredOf = (field: DelegationFieldValue): unknown =>
    valueAt(section, field.path.slice(SECTION.length + 1).split("."));
  if (json) {
    if (leaf !== undefined) {
      io.out(JSON.stringify({ ...leaf, configPath }));
    } else {
      const settings = resolveDelegationSettings(section);
      const value = relative === "" ? settings : valueAt(settings, relative.split("."));
      io.out(JSON.stringify({ path, value, fields: group, configPath }));
    }
    return EXIT_OK;
  }
  for (const field of leaf === undefined ? group : [leaf]) {
    io.out(`${field.path} = ${shown(field.value)}  (${sourceText(field, configuredOf(field))})`);
  }
  return EXIT_OK;
}

// The value a command-line word stands for, read for its field. What does not read as the field's type is kept as the
// text, so the check that follows names the problem with its path.
function settingValue(field: DelegationField, text: string): unknown {
  const word = text.trim();
  const kind = field.kind;
  switch (kind.type) {
    case "integer":
      if (word === "null" && kind.inherits !== undefined) return null;
      return /^\d[\d_]*$/.test(word) ? Number(word.replace(/_/g, "")) : word;
    case "percent":
      return /^\d+(\.\d+)?$/.test(word) ? Number(word) : word;
    case "boolean":
    case "always-true":
      return word === "true" ? true : word === "false" ? false : word;
    case "url-or-null":
    case "model-or-null":
    case "branch-or-null":
      return word === "" || word === "null" ? null : word;
    case "level-or-null":
      return word === "" || word === "null" ? null : word.toLowerCase();
    case "model-list":
    case "command-list":
    case "stop-list": {
      if (word === "") return [];
      if (word.startsWith("[")) {
        try {
          return JSON.parse(word) as unknown;
        } catch {
          return word;
        }
      }
      return word
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
    }
    case "enum":
    case "env-name":
    case "folder":
      return word;
  }
}

// Sets (or, with undefined, removes) a value at a path of the document, creating the groups it needs; a removal drops
// the groups it leaves empty. Returns a problem when a non-object stands where a group should be.
function putValue(
  document: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): string | null {
  const chain: Record<string, unknown>[] = [document];
  for (const part of parts.slice(0, -1)) {
    const node = chain[chain.length - 1] as Record<string, unknown>;
    if (node[part] === undefined) {
      if (value === undefined) return null;
      node[part] = {};
    }
    if (!isRecord(node[part])) return `/${parts.join("/")}: /${part} is not an object`;
    chain.push(node[part] as Record<string, unknown>);
  }
  const last = parts[parts.length - 1] as string;
  const target = chain[chain.length - 1] as Record<string, unknown>;
  if (value !== undefined) {
    target[last] = value;
    return null;
  }
  delete target[last];
  for (let index = chain.length - 1; index > 0; index--) {
    const node = chain[index] as Record<string, unknown>;
    if (Object.keys(node).length > 0) break;
    delete (chain[index - 1] as Record<string, unknown>)[parts[index - 1] as string];
  }
  return null;
}

function configSet(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json", "--reset"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const reset = parsed.flags.has("--reset");
  const json = parsed.flags.has("--json");
  const [path, text, ...extra] = parsed.positionals;
  if (path === undefined || extra.length > 0 || (reset ? text !== undefined : text === undefined)) {
    return fail(io, USAGE);
  }
  const uiPath = path === "ui.locale" || path === "ui.theme";
  const docsPath = path === "docs.path";
  const preferencePath = uiPath || docsPath;
  if (!preferencePath && !path.startsWith(`${SECTION}.`)) {
    return fail(
      io,
      `only delegation settings, ui.locale, ui.theme and docs.path can be set; ${path} is not one (edit the rest of haril.json by hand)`,
    );
  }
  const field = preferencePath ? undefined : delegationField(path.slice(SECTION.length + 1));
  if (!preferencePath && field === undefined) {
    return fail(io, `unknown setting ${path} (haril config get ${SECTION} lists them)`);
  }
  const configPath = harilConfigPath(host).path;
  const read = readConfigDocument(configPath);
  if (!read.ok) return fail(io, `${configPath}: ${read.error}`);

  const preferenceOf = (document: Record<string, unknown>) =>
    docsPath
      ? docsPathField(document)
      : path === "ui.locale"
        ? uiLocaleField(document)
        : uiThemeField(document);
  const before = preferencePath
    ? preferenceOf(read.document)
    : delegationFieldsOf(read.document).find((item) => item.path === path);
  const next = JSON.parse(JSON.stringify(read.document)) as Record<string, unknown>;
  const value = reset
    ? undefined
    : docsPath
      ? docsPathText(text as string)
      : uiPath
        ? text
        : settingValue(field as DelegationField, text as string);
  const placed = putValue(next, path.split("."), value);
  const errors = placed === null ? configDocumentErrors(next) : [placed];
  if (errors.length > 0) {
    io.err(`haril: ${path} was not changed; ${configPath} would have these problems:`);
    for (const error of errors) io.err(`  ${error}`);
    return EXIT_USAGE;
  }
  // A folder that is not there is refused now, while the user can still fix the typo; reading the file later never
  // looks at it, so a vault on a drive that is gone does not break HARIL.
  if (docsPath && !reset) {
    const state = docsFolderState(value as string);
    if (state !== "directory") {
      return fail(
        io,
        `${path} was not changed; ${value as string} ${state === "file" ? "is a file, not a directory" : "is not an existing directory"}`,
      );
    }
  }
  const content = serializeConfig(next, read.exists ? read.text : undefined);
  const written = !read.exists || content !== read.text;
  if (written) {
    try {
      writeConfigAtomically(configPath, content);
    } catch (error) {
      return fail(
        io,
        `${configPath} could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const after = preferencePath
    ? preferenceOf(next)
    : (delegationFieldsOf(next).find((item) => item.path === path) as DelegationFieldValue);
  const previous = before ?? after;
  const effect = field?.effect ?? (docsPath ? "the DOCS tab" : "new sessions");
  if (json) {
    io.out(
      JSON.stringify({
        path,
        previous: { value: previous.value, source: previous.source },
        value: after.value,
        source: after.source,
        written,
        effect,
        configPath,
      }),
    );
    return EXIT_OK;
  }
  const label = (item: { value: unknown; source: "file" | "default" | "unset" }): string =>
    item.source === "unset"
      ? "not set"
      : `${shown(item.value)} (${item.source === "file" ? SOURCE_FILE : "default"})`;
  io.out(`${path}: ${label(previous)} -> ${label(after)}`);
  io.out(written ? `written ${configPath} · affects ${effect}` : `unchanged ${configPath}`);
  return EXIT_OK;
}
