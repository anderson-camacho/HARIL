import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runHaril } from "./cli.js";
import { DOCK_LABELS, type DockId } from "./native-panes.js";
import { plainText } from "./text.js";

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 128;
const MAX_LINES = 140;

export interface DockDetails {
  readonly id: DockId;
  readonly title: string;
  readonly status: string;
  readonly lines: readonly string[];
  readonly treeNodes?: readonly ExplorerTreeNode[];
}

interface ExplorerTreeNode {
  readonly path: string;
  readonly directory: boolean;
  readonly depth: number;
}

export interface DockSource {
  readonly directory?: (
    cwd: string,
  ) => Promise<readonly { name: string; isDirectory(): boolean }[]>;
  readonly git?: (cwd: string) => Promise<string>;
  readonly gitHistory?: (cwd: string) => Promise<string>;
  readonly gitChanges?: (cwd: string) => Promise<string>;
  readonly memory?: () => Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly piCommands?: readonly string[];
  readonly expandedPaths?: ReadonlySet<string>;
}

function linesOf(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => plainText(line.trimEnd()))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

function view(
  id: DockId,
  status: string,
  lines: readonly string[],
  treeNodes?: readonly ExplorerTreeNode[],
): DockDetails {
  return {
    id,
    title: DOCK_LABELS.find((slot) => slot.id === id)?.label ?? id,
    status,
    lines: lines.slice(0, MAX_LINES),
    ...(treeNodes === undefined ? {} : { treeNodes }),
  };
}

// Directory expansion is explicit: never follow symlinks, enter a hidden folder on its own,
// or recurse without a user click. A fixed row budget prevents large repositories freezing Pi.
async function explorerTree(
  cwd: string,
  source: DockSource,
): Promise<{
  lines: string[];
  nodes: ExplorerTreeNode[];
  count: number;
}> {
  const nodes: ExplorerTreeNode[] = [];
  const lines: string[] = [];
  let count = 0;
  async function append(directory: string, depth: number): Promise<void> {
    if (depth > 8 || lines.length >= MAX_ENTRIES) return;
    const entries = source.directory
      ? await source.directory(directory)
      : await readdir(directory, { withFileTypes: true });
    count += entries.length;
    const sorted = [...entries].sort(
      (a, b) =>
        Number(a.name.startsWith(".")) - Number(b.name.startsWith(".")) ||
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name),
    );
    for (const entry of sorted) {
      if (lines.length >= MAX_ENTRIES) break;
      const isDir = entry.isDirectory();
      const path = join(directory, entry.name);
      const expanded = isDir && source.expandedPaths?.has(path) === true;
      nodes.push({ path, directory: isDir, depth });
      lines.push(
        `${"  ".repeat(depth)}${isDir ? (expanded ? "▾" : "▸") : "·"} ${isDir ? "▣" : "◇"} ${plainText(entry.name)}`,
      );
      if (expanded && depth < 8) {
        try {
          await append(path, depth + 1);
        } catch {
          // A folder may be removed or become inaccessible between the click and the read.
          nodes.push({ path, directory: false, depth: depth + 1 });
          lines.push(`${"  ".repeat(depth + 1)}! No se pudo abrir`);
        }
      }
    }
  }
  await append(cwd, 0);
  return { nodes, lines, count };
}

export async function loadDockDetails(
  id: DockId,
  cwd: string,
  source: DockSource = {},
): Promise<DockDetails> {
  try {
    switch (id) {
      case "explorer": {
        const tree = await explorerTree(cwd, source);
        return view(
          id,
          `Árbol · ${tree.count} entradas · clic para desplegar`,
          [plainText(cwd), ...tree.lines],
          tree.nodes,
        );
      }
      case "git": {
        const execGit = async (folder: string, args: string[]): Promise<string> => {
          const result = await execFileAsync("git", ["-C", folder, ...args], {
            timeout: 5_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          });
          return result.stdout;
        };
        const output = linesOf(
          await (source.git ?? ((folder) => execGit(folder, ["status", "--short", "--branch"])))(
            cwd,
          ),
        );
        // Test overrides remain deterministic. In production the Git view shows history
        // and a concise diff summary, using Git's own porcelain without a shell.
        const history = linesOf(
          await (
            source.gitHistory ??
            (source.git
              ? async () => ""
              : (folder) => execGit(folder, ["log", "-8", "--graph", "--oneline", "--decorate"]))
          )(cwd),
        );
        const changes = linesOf(
          await (
            source.gitChanges ??
            (source.git ? async () => "" : (folder) => execGit(folder, ["diff", "--stat"]))
          )(cwd),
        );
        return view(id, "Git · árbol y cambios · solo lectura", [
          ...(output.length ? output : ["Sin cambios locales"]),
          ...(changes.length ? ["── CAMBIOS ──", ...changes] : []),
          ...(history.length ? ["── HISTORIAL ──", ...history] : []),
        ]);
      }
      case "memory": {
        const status = await (
          source.memory ?? (() => runHaril(["memory", "status"], { cwd, timeoutMs: 8_000 }))
        )();
        if (!status.ok)
          return view(
            id,
            "Memoria no disponible",
            linesOf(status.stderr || "HARIL memory status falló"),
          );
        return view(id, "Estado de memoria HARIL", linesOf(status.stdout));
      }
      case "youtube": {
        const installed =
          source.piCommands?.some((name) => name === "yt" || name === "/yt") ?? false;
        return installed
          ? view(id, "Extensión /yt detectada", [
              "Usa /yt en Pi para abrir el reproductor",
              "/yt search <nombre>",
              "/yt pip",
              "La extensión administra YouTube por separado",
            ])
          : view(id, "Extensión /yt no detectada", [
              "Este es un espacio del dock, no un reproductor instalado.",
              "Referencia: CinloDev/pi-youtube-player",
              "Requiere instalar su extensión y componentes de navegador.",
              "HARIL no instala ni ejecuta extensiones sin permiso.",
            ]);
      }
      case "themes":
        return view(id, "Temas de Pi", [
          "/settings → Theme",
          "Incluidos: system, dark y light",
          "Los temas HARIL se integrarán en una fase posterior.",
          "Seleccionar aquí no cambia los colores todavía.",
        ]);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return view(id, "No se pudo leer", [plainText(reason)]);
  }
}
