import { box, type Line, segment } from "./frame-layout.js";
import { followCursor } from "./layout.js";

// The / commands of the input box (LD-T6b-2): the table, the suggestion list that typing / opens and the parser. The
// app runs them; each one goes the same way as its key in navigation mode.

export interface SlashCommand {
  readonly name: string;
  // The argument it takes, as the list shows it.
  readonly argument?: string;
  readonly description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "projects", description: "open Projects: Enter picks the project filter" },
  { name: "tasks", description: "open Tasks: the tasks of the filter" },
  { name: "agents", description: "open Agents: the runtime and the runs in progress" },
  { name: "tokens", description: "open Tokens: usage by project" },
  { name: "events", description: "open Events: the newest audit events" },
  { name: "models", description: "open Models: the providers and their keys" },
  { name: "themes", description: "open Themes: Enter applies and saves one" },
  { name: "plans", description: "open Plans: the plans waiting for approval" },
  { name: "live", description: "open Live: the newest tasks as they run" },
  {
    name: "approve",
    argument: "[id]",
    description: "approve a plan: the id, the one selected on Plans or the only one",
  },
  {
    name: "deny",
    argument: "[id]",
    description: "deny a plan: the id, the one selected on Plans or the only one",
  },
  { name: "add", description: "add a task: title, agent and model" },
  { name: "reload", description: "read the store and git again" },
  { name: "help", description: "show the keys, the modes and the commands" },
  { name: "quit", description: "quit the shell" },
];

// The name column of the list: "> /approve [id]" and two spaces.
const NAME_WIDTH = 17;
// The rows the list shows at most; it scrolls to the selected command, so the panel above keeps most of its rows.
const LIST_ROWS = 8;

// The commands whose name starts with what follows "/", while the text is that one word; none otherwise.
export function commandMatches(text: string): SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const prefix = text.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix));
}

// "/approve ab12" as its name and the rest of the line; the name is matched in lower case.
export function parseCommand(text: string): {
  readonly name: string;
  readonly argument: string | undefined;
} {
  const line = text.trim().slice(1);
  const space = line.search(/\s/);
  const name = (space === -1 ? line : line.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : line.slice(space).trim();
  return { name, argument: rest === "" ? undefined : rest };
}

// The suggestion list in at most `height` lines, scrolled so the selected command shows. In a box `width` cells wide
// titled with the count, so its marker is not taken for the panel's cursor; without room for the borders, the bare
// rows. The app cuts the lines to the width.
export function commandListLines(
  matches: readonly SlashCommand[],
  selected: number,
  height: number,
  width: number,
): Line[] {
  if (height <= 0 || matches.length === 0) return [];
  const framed = height >= 3 && width >= 7;
  const rows = Math.min(matches.length, LIST_ROWS, framed ? height - 2 : height);
  const offset = followCursor(0, selected, rows, matches.length);
  const lines = matches.slice(offset, offset + rows).map((command, index): Line => {
    const chosen = offset + index === selected;
    const name = `${chosen ? "> " : "  "}/${command.name}${command.argument === undefined ? "" : ` ${command.argument}`}`;
    return [
      segment(name.padEnd(NAME_WIDTH), chosen ? "accent" : "text", chosen),
      segment(command.description, "muted"),
    ];
  });
  return framed ? box(`Commands (${matches.length})`, lines, width) : lines;
}
