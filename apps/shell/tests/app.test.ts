import { describe, expect, it } from "vitest";
import { createShellApp } from "../src/app.js";
import { resolveTheme } from "../src/theme.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The shell app rendered into a virtual terminal (TUI-T1): header, banner and placeholder body, and clean quit.

const THEME = resolveTheme({ name: "haril-dark", runtimeRoot: "/nonexistent-haril-root" }).theme;

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("shell app", () => {
  it("renders the header, the N0 banner with no pending approvals, and a placeholder body", async () => {
    const terminal = new VirtualTerminal();
    const app = createShellApp({
      terminal,
      theme: THEME,
      banner: { isolation: "N0", pendingApprovals: 0 },
    });
    app.start();
    await waitFor(() => terminal.screen().includes("HARIL shell"));
    const screen = terminal.screen();
    expect(screen).toContain("N0");
    expect(screen).toContain("0 pending approvals");
    expect(screen).toContain("q quit");
    terminal.send("q");
    await app.done;
  });

  it("shows the theme warning line when the requested theme could not be loaded", async () => {
    const terminal = new VirtualTerminal();
    const app = createShellApp({
      terminal,
      theme: THEME,
      warning: "theme 'broken' not loaded (broken.json is not valid JSON); using haril-dark",
      banner: { isolation: "N0", pendingApprovals: 0 },
    });
    app.start();
    await waitFor(() => terminal.screen().includes("HARIL shell"));
    expect(terminal.screen()).toContain("using haril-dark");
    terminal.send("q");
    await app.done;
  });

  it("q stops the TUI cleanly and resolves done", async () => {
    const terminal = new VirtualTerminal();
    const app = createShellApp({
      terminal,
      theme: THEME,
      banner: { isolation: "N0", pendingApprovals: 0 },
    });
    app.start();
    await waitFor(() => terminal.started);
    terminal.send("q");
    await app.done;
    expect(terminal.stopped).toBe(true);
  });

  it("Ctrl+C stops the TUI cleanly and resolves done", async () => {
    const terminal = new VirtualTerminal();
    const app = createShellApp({
      terminal,
      theme: THEME,
      banner: { isolation: "N0", pendingApprovals: 0 },
    });
    app.start();
    await waitFor(() => terminal.started);
    terminal.send("\x03");
    await app.done;
    expect(terminal.stopped).toBe(true);
  });
});
