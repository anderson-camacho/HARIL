import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
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
}

export interface DockSource {
  readonly directory?: (
    cwd: string,
  ) => Promise<readonly { name: string; isDirectory(): boolean }[]>;
  readonly git?: (cwd: string) => Promise<string>;
  readonly memory?: () => Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly piCommands?: readonly string[];
}

function linesOf(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => plainText(line.trimEnd()))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

function view(id: DockId, status: string, lines: readonly string[]): DockDetails {
  return {
    id,
    title: DOCK_LABELS.find((slot) => slot.id === id)?.label ?? id,
    status,
    lines: lines.slice(0, MAX_LINES),
  };
}

export async function loadDockDetails(
  id: DockId,
  cwd: string,
  source: DockSource = {},
): Promise<DockDetails> {
  try {
    switch (id) {
      case "explorer": {
        const directory = source.directory
          ? await source.directory(cwd)
          : await readdir(cwd, { withFileTypes: true });
        const entries = [...directory]
          .sort(
            (left, right) =>
              Number(left.name.startsWith(".")) - Number(right.name.startsWith(".")) ||
              Number(right.isDirectory()) - Number(left.isDirectory()) ||
              left.name.localeCompare(right.name),
          )
          .slice(0, MAX_ENTRIES)
          .map((entry) => `${entry.isDirectory() ? "▸" : "·"} ${plainText(entry.name)}`);
        return view(id, `Solo lectura · ${directory.length} elementos`, [
          plainText(cwd),
          ...entries,
          ...(directory.length > MAX_ENTRIES
            ? [`+ ${directory.length - MAX_ENTRIES} archivos más`]
            : []),
        ]);
      }
      case "git": {
        const command =
          source.git ??
          (async (folder: string) => {
            const result = await execFileAsync(
              "git",
              ["-C", folder, "status", "--short", "--branch"],
              {
                timeout: 5_000,
                maxBuffer: 64 * 1024,
                windowsHide: true,
              },
            );
            return result.stdout;
          });
        const output = linesOf(await command(cwd));
        return view(
          id,
          "Estado Git · solo lectura",
          output.length ? output : ["Sin cambios locales"],
        );
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
