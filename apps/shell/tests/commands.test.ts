import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { commandListLines, commandMatches, parseCommand, SLASH_COMMANDS } from "../src/commands.js";
import { lineText } from "../src/frame-layout.js";

// The / commands of the input box (LD-T6b-2): the table, the prefix filter of the suggestion list and the parser.

describe("slash commands", () => {
  it("lists the fifteen commands, each with a one-line description", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "projects",
      "tasks",
      "agents",
      "tokens",
      "events",
      "models",
      "themes",
      "plans",
      "live",
      "approve",
      "deny",
      "add",
      "reload",
      "help",
      "quit",
    ]);
    for (const command of SLASH_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description).not.toContain("\n");
    }
  });

  it("filters by the prefix after / while the text is one word", () => {
    expect(commandMatches("/")).toHaveLength(15);
    expect(commandMatches("/t").map((command) => command.name)).toEqual([
      "tasks",
      "tokens",
      "themes",
    ]);
    expect(commandMatches("/A").map((command) => command.name)).toEqual([
      "agents",
      "approve",
      "add",
    ]);
    expect(commandMatches("/x")).toEqual([]);
    expect(commandMatches("/approve ")).toEqual([]);
    expect(commandMatches("plans")).toEqual([]);
    expect(commandMatches("")).toEqual([]);
  });

  it("parses the name and the argument", () => {
    expect(parseCommand("/plans")).toEqual({ name: "plans", argument: undefined });
    expect(parseCommand("  /Approve   ab12cd34  ")).toEqual({
      name: "approve",
      argument: "ab12cd34",
    });
    expect(parseCommand("/deny a b")).toEqual({ name: "deny", argument: "a b" });
    expect(parseCommand("/")).toEqual({ name: "", argument: undefined });
  });

  it("draws the list in a titled box, the selected row marked and scrolled into the height", () => {
    const matches = commandMatches("/");
    const lines = commandListLines(matches, 11, 4, 60).map(lineText);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^┌─ Commands \(15\) ─+┐$/);
    expect(lines[1]).toMatch(/^│ {3}\/deny \[id\] +deny a plan/);
    expect(lines[2]).toMatch(/^│ > \/add +add a task/);
    expect(lines.filter((line) => line.includes("│ > "))).toHaveLength(1);
    for (const line of lines) expect(visibleWidth(line)).toBe(60);
  });

  it("shows at most eight rows, and the bare rows when the borders do not fit", () => {
    const matches = commandMatches("/");
    expect(commandListLines(matches, 0, 30, 60)).toHaveLength(10);
    const bare = commandListLines(matches, 1, 2, 60).map(lineText);
    expect(bare).toHaveLength(2);
    expect(bare[1]).toMatch(/^> \/tasks +open Tasks/);
    expect(commandListLines(matches, 0, 0, 60)).toEqual([]);
    expect(commandListLines([], 0, 10, 60)).toEqual([]);
  });
});
