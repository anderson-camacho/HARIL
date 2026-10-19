import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import harilConsole from "../src/console.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// The console's children (haril workflow watch and tail) never outlive the session that started them: Pi may fire
// session_start again without session_shutdown (/new, /resume, a reload), and the previous session's children end
// then; and each child is told to end with its stdin, a pipe the console holds, so it exits when the console goes away.

let cli: FakeCli;
let fake: FakePi;
let ctx: FakeContext;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function watchCalls() {
  return cli.calls().filter((call) => call.args[0] === "workflow" && call.args[1] === "watch");
}

beforeEach(() => {
  cli = installFakeCli();
  cli.answer("status", { stdout: "{}" });
  cli.answer("workflow list", {
    stdout: JSON.stringify([
      { workflowId: "wf-1", state: "running", goal: "Goal", createdAt: 1, stopReason: null },
    ]),
  });
  // The watch never ends on its own: only the console ends it.
  cli.answer("workflow watch", { delayMs: 60_000 });
  fake = fakePi();
  ctx = fakeContext(tmpdir());
  harilConsole(fake.pi);
});

afterEach(async () => {
  await fake.fire("session_shutdown", {}, ctx);
  for (const call of watchCalls()) {
    try {
      process.kill(call.pid, "SIGKILL");
    } catch {}
  }
  cli.restore();
});

describe("the console's children", () => {
  it("loads the persisted locale before displaying console actions", async () => {
    cli.answer("config get ui.locale", {
      stdout: JSON.stringify({ path: "ui.locale", value: "en", source: "file" }),
    });
    const menus: string[][] = [];
    (ctx.ui as { select: unknown }).select = async (_title: string, options: string[]) => {
      menus.push(options);
      return undefined;
    };
    await fake.fire("session_start", { reason: "startup" }, ctx);
    await waitFor(
      () => cli.calls().some((call) => call.args[0] === "status"),
      "the locale and initial status to load",
    );
    await fake.commands.get("haril")?.handler("", ctx);
    expect(cli.calls().some((call) => call.args.join(" ") === "config get ui.locale --json")).toBe(
      true,
    );
    expect(menus[0]).toContain("Refresh data");
    expect(menus[0]).not.toContain("Actualizar datos");
  });

  it("uses Spanish console actions when no locale is configured", async () => {
    const menus: string[][] = [];
    (ctx.ui as { select: unknown }).select = async (_title: string, options: string[]) => {
      menus.push(options);
      return undefined;
    };
    await fake.fire("session_start", { reason: "startup" }, ctx);
    await waitFor(
      () => cli.calls().some((call) => call.args[0] === "status"),
      "the default locale and initial status to load",
    );
    await fake.commands.get("haril")?.handler("", ctx);
    expect(menus[0]).toContain("Actualizar datos");
    expect(menus[0]).not.toContain("Refresh data");
  });

  it("end with the previous session when Pi starts a session again without shutting it down", async () => {
    await fake.fire("session_start", { reason: "startup" }, ctx);
    await fake.commands.get("orchestration")?.handler("", ctx);
    await waitFor(() => watchCalls().length === 1, "the watch child");
    const first = watchCalls()[0]?.pid as number;
    expect(alive(first)).toBe(true);
    await fake.fire("session_start", { reason: "new" }, ctx);
    await waitFor(() => !alive(first), "the previous session's watch child to end");
  }, 15_000);

  it("are asked to end with their stdin, a pipe the console holds", async () => {
    await fake.fire("session_start", { reason: "startup" }, ctx);
    await fake.commands.get("orchestration")?.handler("", ctx);
    await waitFor(() => watchCalls().length === 1, "the watch child");
    expect(watchCalls()[0]?.args).toEqual(["workflow", "watch", "wf-1", "--exit-on-stdin-end"]);
  });
});
