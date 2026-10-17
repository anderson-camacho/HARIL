import { describe, expect, it } from "vitest";
import { AddTaskForm, addTaskArgs } from "../src/add-task.js";

// The add-task form of the shell (TUI-D13) and its argv. Pure: no process runs here; app-actions.test.ts runs the
// form against a fixture haril.

describe("the title sent is the title shown (LD-T6c)", () => {
  it("addTaskArgs sends format characters, controls and lone surrogates as ?", () => {
    const built = addTaskArgs(
      {
        title: " do\u{200B}it\u{202E}\x1b[2J\u{E0041}\ud83d ",
        agent: "fake:succeed",
        model: "",
      },
      { slug: "demo", dataDir: undefined },
    );
    expect(built).toEqual({
      ok: true,
      args: ["task", "add", "do?it??[2J??", "--project", "demo", "--agent", "fake:succeed"],
    });
  });

  it("addTaskArgs sends the model as the form shows it", () => {
    const built = addTaskArgs(
      { title: "Write docs", agent: "analyst", model: " qwen\u{200B}-test\u{E0100}\x1b " },
      { slug: "demo", dataDir: undefined },
    );
    expect(built.ok && built.args.slice(-2)).toEqual(["--model", "qwen?-test??"]);
  });

  it("a title of format characters alone is not empty: it is sent as the ? it shows", () => {
    const built = addTaskArgs(
      { title: "\u{200B}", agent: "fake:succeed", model: "" },
      { slug: "demo", dataDir: undefined },
    );
    expect(built.ok && built.args[2]).toBe("?");
  });

  it("the form shows the title as it will be sent, and keeps an emoji sequence whole", () => {
    const form = new AddTaskForm({ projectSlug: "demo", defaultModel: undefined });
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    form.handleInput(`\x1b[200~do\u{200B}it\u{E0041} ${family}\x1b[201~`);
    expect(form.lines()[1]).toBe(`> title   do?it? ${family}_`);
    const built = addTaskArgs(form.values(), { slug: "demo", dataDir: undefined });
    expect(built.ok && built.args[2]).toBe(`do?it? ${family}`);
  });
});
