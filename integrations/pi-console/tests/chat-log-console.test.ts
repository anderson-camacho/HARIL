import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harilConsole from "../src/console.js";
import type { ConsoleTheme } from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// The chat log in the running console (4.5): a typed prompt and a typed HARIL command each leave an order row, a model
// reply leaves a usage row linked to its order, all through `haril usage record --stdin`; the prompt text travels on
// stdin, never in argv; a CLI that fails shows as "log ✗" in the bar and the chat goes on.

const THEME: ConsoleTheme = { fg: (_color, text) => text, bold: (text) => text };

let cli: FakeCli;
let fake: FakePi;
let ctx: FakeContext;
let footer:
  | ((tui: unknown, theme: ConsoleTheme, data: unknown) => { render(width: number): string[] })
  | undefined;

beforeEach(async () => {
  cli = installFakeCli();
  cli.answer("usage record", { stdout: '{"table":"orders","id":"order-9","created":true}' });
  fake = fakePi();
  ctx = fakeContext(tmpdir());
  footer = undefined;
  (ctx.ui as unknown as Record<string, unknown>).setFooter = (factory: typeof footer) => {
    footer = factory;
  };
  harilConsole(fake.pi);
  await fake.fire("session_start", { reason: "startup" }, ctx);
});

afterEach(() => {
  cli.restore();
});

function recordCalls() {
  return cli.calls().filter((call) => call.args[0] === "usage" && call.args[1] === "record");
}

async function settle(count: number): Promise<void> {
  for (let index = 0; index < 150 && recordCalls().length < count; index++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the chat log in the console", () => {
  it("logs the prompt as an order and the reply as a usage row linked to it", async () => {
    const secret = `sk-${"z9".repeat(12)}`;
    const [result] = await fake.fire(
      "input",
      { text: `Summarize, key ${secret}`, source: "interactive" },
      ctx,
    );
    expect(result).toBeUndefined();
    await fake.fire(
      "message_end",
      {
        message: {
          role: "assistant",
          provider: "haril-gw",
          model: "Gemini1/gemini-3-flash",
          responseId: "resp-1",
          usage: { input: 50, output: 7, totalTokens: 57, cost: { total: 0 } },
          stopReason: "stop",
          timestamp: 1_000,
          durationMs: 900,
        },
      },
      ctx,
    );
    await settle(2);
    const [order, usage] = recordCalls();
    expect(order?.args).toEqual(["usage", "record", "--stdin", "--json"]);
    expect(order?.args.join(" ")).not.toContain(secret);
    expect(JSON.parse(order?.stdin ?? "{}")).toMatchObject({
      kind: "order",
      mode: "accion",
      source: "chat",
      sessionId: "session-fake-1",
    });
    expect(JSON.parse(usage?.stdin ?? "{}")).toMatchObject({
      kind: "chat",
      mode: "accion",
      orderId: "order-9",
      modelRequested: "Gemini1/gemini-3-flash",
      tokensIn: 50,
      tokensOut: 7,
      durationMs: 900,
    });
  });

  it("logs a typed HARIL command as an order, with the mode in force", async () => {
    await fake.commands.get("mode")?.handler("consult", ctx);
    await fake.commands.get("tasks")?.handler("", ctx);
    await settle(2);
    const rows = recordCalls().map(
      (call) => JSON.parse(call.stdin ?? "{}") as { text: string; mode: string },
    );
    expect(rows.map((row) => [row.text, row.mode])).toEqual([
      ["/mode consult", "accion"],
      ["/tasks", "consulta"],
    ]);
  });

  it("shows a failing log in the bar and keeps the chat going", async () => {
    cli.answer("usage record", { stderr: "haril: store not initialized", code: 2 });
    const [result] = await fake.fire("input", { text: "hello", source: "interactive" }, ctx);
    expect(result).toBeUndefined();
    for (let index = 0; index < 150; index++) {
      const line = stripAnsi(
        footer?.({ terminal: { columns: 160, rows: 40 }, requestRender: () => undefined }, THEME, {
          getGitBranch: () => null,
          getExtensionStatuses: () => new Map(),
          onBranchChange: () => () => undefined,
        }).render(160)[0] ?? "",
      );
      if (line.includes("log ✗ 1")) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the bar never showed the failed row");
  });
});
