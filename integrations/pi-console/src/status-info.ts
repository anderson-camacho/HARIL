import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { localized, type UiLocale } from "./locale.js";

// What Pi prints at startup and HARIL keeps out of the chat: the extensions, the context files and the package updates.
// The panel, the TOOLS tab and /haril-status show them from here. Pi has no list of loaded extensions for an extension,
// so the list is what can be proved: the sources of the registered commands and tools, then the packages settings.json
// declares that registered nothing. Each name says which of the two it is.

export interface SourcedItem {
  readonly sourceInfo?: { readonly path?: string; readonly source?: string };
}

export interface ExtensionEntry {
  readonly name: string;
  readonly state: "registered" | "declared";
}

function packageName(source: string): string | undefined {
  const npm = /^npm:(@?[^@]+)/.exec(source);
  if (npm !== null) return npm[1];
  const git = /^(?:git:|https?:\/\/).*\/([^/@]+?)(?:\.git)?(?:@.*)?$/.exec(source);
  return git?.[1];
}

function nameOf(item: SourcedItem): string | undefined {
  const { path, source } = item.sourceInfo ?? {};
  if (source === "builtin" || path?.startsWith("builtin:") === true) return undefined;
  const fromSource = source === undefined ? undefined : packageName(source);
  if (fromSource !== undefined) return fromSource;
  return path === undefined || path === "" ? undefined : basename(path.replaceAll("\\", "/"));
}

export function extensionInventory(
  items: readonly SourcedItem[],
  declared: readonly string[],
): ExtensionEntry[] {
  const registered = new Set(items.flatMap((item) => nameOf(item) ?? []));
  const named = declared.flatMap((source) => packageName(source) ?? []);
  return [
    ...[...registered].sort().map((name): ExtensionEntry => ({ name, state: "registered" })),
    ...[...new Set(named)]
      .filter((name) => !registered.has(name))
      .sort()
      .map((name): ExtensionEntry => ({ name, state: "declared" })),
  ];
}

export function extensionRows(entries: readonly ExtensionEntry[], locale: UiLocale): string[] {
  if (entries.length === 0) {
    return [localized(locale, "None known", "Ninguna conocida")];
  }
  return entries.map(({ name, state }) =>
    state === "registered" ? name : `${name} (${localized(locale, "declared", "declarada")})`,
  );
}

// The `packages` of an agent settings.json as their source strings; anything unreadable is no packages.
export function declaredPackages(settingsText: string | undefined): string[] {
  if (settingsText === undefined) return [];
  try {
    const packages = (JSON.parse(settingsText) as { packages?: unknown }).packages;
    if (!Array.isArray(packages)) return [];
    return packages.flatMap((item: unknown) => {
      if (typeof item === "string") return [item];
      const source = (item as { source?: unknown } | null)?.source;
      return typeof source === "string" ? [source] : [];
    });
  } catch {
    return [];
  }
}

export function readAgentSettings(agentDir: string | undefined): string | undefined {
  if (agentDir === undefined || agentDir === "") return undefined;
  try {
    return readFileSync(join(agentDir, "settings.json"), "utf8");
  } catch {
    return undefined;
  }
}

const CONTEXT_NAMES = ["AGENTS.md", "CLAUDE.md"];

// The context files Pi loads: its own list when the context offers it, else the same walk it does (the agent directory,
// then every folder from the root down to this one; one file per folder). Only names leave here, never the contents.
export function contextFiles(
  fromPi: readonly { readonly path: string }[] | undefined,
  cwd: string,
  agentDir: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (fromPi !== undefined) return fromPi.map(({ path }) => path);
  const folders: string[] = [];
  let folder = cwd;
  for (;;) {
    folders.unshift(folder);
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  if (agentDir !== undefined && agentDir !== "") folders.unshift(agentDir);
  return folders.flatMap((dir) => {
    const name = CONTEXT_NAMES.find((candidate) => exists(join(dir, candidate)));
    return name === undefined ? [] : [join(dir, name)];
  });
}

interface UpdateCheck {
  readonly packages: readonly string[];
  readonly agentDir: string;
  readonly offline: boolean;
  readonly latest: (name: string) => Promise<string | undefined>;
  readonly installed?: (name: string) => string | undefined;
}

// The npm packages of settings.json with a newer version published, which is what Pi's own notice checks. A pinned
// package is never checked, as in Pi. Git packages are not compared: that takes a fetch of each repository.
export async function packageUpdates(check: UpdateCheck): Promise<string[]> {
  if (check.offline) return [];
  const installed =
    check.installed ??
    ((name: string): string | undefined => {
      try {
        const file = join(check.agentDir, "npm", "node_modules", name, "package.json");
        return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version;
      } catch {
        return undefined;
      }
    });
  const names = check.packages.flatMap((source) => {
    const match = /^npm:(@?[^@]+)$/.exec(source);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  const answers = await Promise.all(
    names.map(async (name) => {
      const have = installed(name);
      if (have === undefined) return undefined;
      try {
        const latest = await check.latest(name);
        return latest !== undefined && latest !== have ? name : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return answers.flatMap((name) => name ?? []);
}

export async function npmLatest(name: string): Promise<string | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${name}/latest`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return undefined;
  return ((await response.json()) as { version?: string }).version;
}

export function updateWarning(names: readonly string[], locale: UiLocale): string[] {
  if (names.length === 0) return [];
  return [
    localized(
      locale,
      `Package updates: ${names.join(", ")} (pi update --extensions)`,
      `Actualizaciones de paquetes: ${names.join(", ")} (pi update --extensions)`,
    ),
  ];
}

export interface StatusFacts {
  readonly locale: UiLocale;
  readonly version: string | undefined;
  readonly cwd: string;
  readonly project: string;
  readonly mode: string | undefined;
  readonly modelLevel: string;
  readonly context: string;
  readonly cost: string;
  readonly runtime: string;
  readonly memory: string;
  readonly warnings: readonly string[];
  readonly extensions: readonly ExtensionEntry[];
  readonly contextFiles: readonly string[];
  // What the TOOLS tab lists; undefined where the session cannot say.
  readonly catalog?: {
    readonly skills: number;
    readonly servers: number;
    readonly connected: number;
  };
  readonly shortcuts: readonly { readonly key: string; readonly description: string }[];
}

// The lines of /haril-status: everything the panel says, reachable with the panel closed.
export function statusLines(facts: StatusFacts): string[] {
  const say = (english: string, spanish: string): string =>
    localized(facts.locale, english, spanish);
  const none = say("None", "Ninguno");
  const section = (title: string, rows: readonly string[]): string[] => [
    title,
    ...(rows.length === 0 ? [none] : rows).map((row) => `  ${row}`),
    "",
  ];
  return [
    ...section(`${say("WARNINGS", "AVISOS")} · ${facts.warnings.length}`, facts.warnings),
    ...section(
      `${say("EXTENSIONS", "EXTENSIONES")} · ${facts.extensions.length}`,
      extensionRows(facts.extensions, facts.locale),
    ),
    ...section(`${say("CONTEXT", "CONTEXTO")} · ${facts.contextFiles.length}`, facts.contextFiles),
    ...(facts.catalog === undefined
      ? []
      : section("SKILLS · MCP", [
          `Skills: ${facts.catalog.skills}`,
          `MCP: ${facts.catalog.servers} · ${facts.catalog.connected} ${say("connected this session", "conectados en esta sesión")}`,
        ])),
    ...section(say("SESSION", "SESIÓN"), [
      `HARIL ${facts.version ?? "?"}`,
      `${say("Folder", "Carpeta")}: ${facts.cwd}`,
      `${say("Project", "Proyecto")}: ${facts.project}`,
      `${say("Mode", "Modo")}: ${facts.mode ?? "?"}`,
      `${say("Model", "Modelo")}: ${facts.modelLevel}`,
      `${say("Context", "Contexto")}: ${facts.context} · ${facts.cost}`,
      `Runtime: ${facts.runtime}`,
      `${say("Memory", "Memoria")}: ${facts.memory}`,
    ]),
    ...section(
      say("SHORTCUTS", "ATAJOS"),
      facts.shortcuts.map(({ key, description }) => `${key} · ${description}`),
    ),
  ].slice(0, -1);
}
