import { runHaril } from "./cli.js";
import type { UiLocale } from "./locale.js";
import { DOCK_LABELS, type DockId } from "./native-panes.js";
import { plainText } from "./text.js";

const MAX_LINES = 140;

export interface DockDetails {
  readonly id: DockId;
  readonly title: string;
  readonly status: string;
  readonly lines: readonly string[];
  // A click on a detail row runs the action declared for its line. The pane reads this for whichever tab is selected.
  readonly actions?: readonly { line: number; action: string }[];
}

export interface DockSource {
  readonly memory?: () => Promise<{
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly locale?: UiLocale;
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
  actions?: readonly { line: number; action: string }[],
): DockDetails {
  return {
    id,
    title: DOCK_LABELS.find((slot) => slot.id === id)?.label ?? id,
    status,
    lines: lines.slice(0, MAX_LINES),
    ...(actions === undefined ? {} : { actions }),
  };
}

export async function loadDockDetails(
  id: DockId,
  cwd: string,
  source: DockSource = {},
): Promise<DockDetails> {
  const en = source.locale === "en";
  try {
    switch (id) {
      // MAIN has nothing to load: its content is the status block, which is drawn from live facts on every frame.
      case "main":
        return view(id, "", []);
      case "memory": {
        const status = await (
          source.memory ?? (() => runHaril(["memory", "status"], { cwd, timeoutMs: 8_000 }))
        )();
        if (!status.ok)
          return view(
            id,
            en ? "Memory unavailable" : "Memoria no disponible",
            linesOf(status.stderr || "HARIL memory status falló"),
          );
        return view(
          id,
          en ? "HARIL memory status" : "Estado de memoria HARIL",
          linesOf(status.stdout),
        );
      }
      // Until a documentation folder can be connected, DOCS only says that none is.
      case "docs":
        return view(id, en ? "Documentation · read-only" : "Documentación · solo lectura", [
          en ? "Documentation folder not connected." : "Carpeta de documentación sin conectar.",
        ]);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return view(id, "No se pudo leer", [plainText(reason)]);
  }
}
