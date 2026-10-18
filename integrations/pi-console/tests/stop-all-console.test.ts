import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harilConsole from "../src/console.js";
import type { ConsoleMouseEvent, ConsoleTheme } from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// ■ STOP ALL in the running console (3.14.6, P20): the bar button and Alt+X abort the chat turn and run
// `haril stop --now`, with no confirmation, and the ORCHESTRATION "Stop all" does the same outside demo.

const THEME: ConsoleTheme = { fg: (_color, text) => text, bold: (text) => text };
const STOP_REPORT = JSON.stringify({
  commandId: "cmd-1",
  runtime: "stopped",
  queued: false,
  halted: true,
  cancelledTasks: 2,
  stoppedWorkflows: 1,
  processes: { recorded: 2, killed: 0, kept: 0, alive: 0 },
});

let cli: FakeCli;
let fake: FakePi;
let ctx: FakeContext;
let footer:
  | ((
      tui: unknown,
      theme: ConsoleTheme,
      data: unknown,
    ) => {
      render(width: number): string[];
      handleMouse?(event: ConsoleMouseEvent): unknown;
    })
  | undefined;
let confirms: number;

beforeEach(async () => {
  cli = installFakeCli();
  cli.answer("stop --now", { stdout: `${STOP_REPORT}\n` });
  fake = fakePi();
  ctx = fakeContext(tmpdir());
  footer = undefined;
  confirms = 0;
  const ui = ctx.ui as unknown as Record<string, unknown>;
  ui.setFooter = (factory: typeof footer) => {
    footer = factory;
  };
  ui.confirm = async () => {
    confirms++;
    return true;
  };
  harilConsole(fake.pi);
  await fake.fire("session_start", { reason: "startup" }, ctx);
});

afterEach(() => {
  cli.restore();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 50; index++) {
    if (ctx.notes.some(([message]) => message.startsWith("STOP ALL: chat"))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function stopCalls(): string[][] {
  return cli
    .calls()
    .filter((call) => call.args[0] === "stop")
    .map((call) => call.args);
}

describe("STOP ALL in the console", () => {
  it("Alt+X aborts the chat turn and runs haril stop --now, without asking", async () => {
    fake.shortcuts.get("alt+x")?.(ctx);
    await settle();
    expect(ctx.aborts).toBe(1);
    expect(stopCalls()).toEqual([["stop", "--now", "--json"]]);
    expect(confirms).toBe(0);
    const report = ctx.notes.find(([message]) => message.startsWith("STOP ALL: chat"));
    expect(report).toEqual([
      expect.stringMatching(/2 tasks cancelled, 1 workflow stopped · no agent process left alive/),
      "info",
    ]);
  });

  it("the button at the right end of the bar does the same", async () => {
    const component = footer?.(
      { terminal: { columns: 140, rows: 40 }, requestRender: () => undefined },
      THEME,
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => undefined,
      },
    );
    const lines = component?.render(140) ?? [];
    const line = stripAnsi(lines[0] ?? "");
    expect(line).toMatch(/MODE: ACTION/);
    expect(line.endsWith("■ STOP ALL")).toBe(true);
    const x = line.indexOf("■ STOP ALL") + 2;
    component?.handleMouse?.({
      type: "click",
      button: "left",
      x,
      y: 0,
      width: 140,
      height: 40,
      shift: false,
      alt: false,
      ctrl: false,
    });
    await settle();
    expect(ctx.aborts).toBe(1);
    expect(stopCalls()).toEqual([["stop", "--now", "--json"]]);
  });

  it("says plainly when the runtime does not answer", async () => {
    cli.answer("stop --now", { stderr: "haril: database is locked", code: 2 });
    fake.shortcuts.get("alt+x")?.(ctx);
    await settle();
    expect(ctx.notes.find(([message]) => message.startsWith("STOP ALL: chat"))).toEqual([
      "STOP ALL: chat turn aborted, but haril stop --now failed: haril: database is locked",
      "error",
    ]);
  });
});
