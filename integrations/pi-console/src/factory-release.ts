import type { BodyLine } from "./factory-board.js";
import { type FactoryGlyphs, factoryCell } from "./factory-kit.js";
import type { FactoryState } from "./factory-state.js";
import type { FactoryModel } from "./factory-types.js";

// The git role's screen (release-published), in tab Sistema: a terminal with the commands it ran and what they answered,
// then notes from the work that really closed. Nothing here is written by a model, and no release is claimed that did not
// happen: without a command it says so.

const LEVEL_TEXT: Readonly<Record<string, string>> = {
  free: "lectura",
  local: "local",
  publish: "publicación",
  destructive: "destructiva",
};

function outputLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-3);
}

function notes(model: FactoryModel): {
  readonly new: string[];
  readonly fixes: string[];
  readonly by: string[];
} {
  const done = model.tasks.filter((task) => task.column === "hechas" && task.delegatedBy !== null);
  const fixes = done.filter((task) => task.role === "fixer");
  const fresh = done.filter(
    (task) =>
      task.role !== "fixer" &&
      task.role !== "git" &&
      task.role !== "tester" &&
      task.role !== "consultor" &&
      task.role !== "product-owner" &&
      task.role !== "auditor",
  );
  return {
    new: fresh.map((task) => task.title),
    fixes: fixes.map((task) => task.title),
    by: [...new Set(done.map((task) => task.role))],
  };
}

export function releaseBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const lines: BodyLine[] = [
    [
      { text: ` ${g.dot} ${g.dot} ${g.dot} `, token: "line" },
      { text: `~/${model.project ?? "proyecto"}`, token: "muted" },
    ],
    [],
  ];
  if (model.gitActions.length === 0) {
    lines.push([factoryCell("  El rol git no ha ejecutado nada todavía.", width, "muted")]);
  }
  for (const action of model.gitActions) {
    const level = LEVEL_TEXT[action.level] ?? action.level;
    lines.push([
      { text: "> ", token: "purple" },
      factoryCell(action.command, Math.max(0, width - 2 - level.length - 1), "text"),
      { text: ` ${level}`, token: "dim" },
    ]);
    for (const line of outputLines(action.output)) {
      lines.push([factoryCell(`  ${line}`, width, action.exitCode === 0 ? "muted" : "red")]);
    }
    if (action.exitCode !== 0) {
      lines.push([factoryCell(`  ✗ salió con ${action.exitCode ?? "sin código"}`, width, "red")]);
    } else if (action.level === "publish") {
      lines.push([factoryCell("  ✓ Publicado", width, "green")]);
    }
  }
  const { new: fresh, fixes, by } = notes(model);
  const section = (
    title: string,
    mark: string,
    token: "green" | "orange" | "yellow",
    rows: readonly string[],
  ) => {
    if (rows.length === 0) return;
    lines.push([], [factoryCell(`## ${title}`, width, "blue")]);
    for (const row of rows) {
      lines.push([{ text: `  ${mark} `, token }, factoryCell(row, Math.max(0, width - 4), "text")]);
    }
  };
  section("Novedades", "+", "green", fresh);
  section("Correcciones", "~", "orange", fixes);
  section("Hecho por", "*", "yellow", by);
  // The end of what happened, when it does not all fit.
  return lines.length <= height ? lines : lines.slice(lines.length - height);
}
