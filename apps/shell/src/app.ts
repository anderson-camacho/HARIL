import { Container, matchesKey, type Terminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import type { Theme } from "./theme.js";

// The shell app (TUI-T1): a header, a banner, a placeholder body and a footer, rendered into the terminal's main
// screen. Panels arrive in TUI-T3; the banner values are fixed until the store is read there.

interface ShellBanner {
  readonly isolation: string;
  readonly pendingApprovals: number;
}

export interface ShellAppOptions {
  readonly terminal: Terminal;
  readonly theme: Theme;
  readonly banner: ShellBanner;
  // A notice shown under the banner, such as a theme that could not be loaded.
  readonly warning?: string;
}

export interface ShellApp {
  start(): void;
  // Resolves once the user quits (q or Ctrl+C) and the terminal has been restored.
  readonly done: Promise<void>;
}

export function createShellApp(options: ShellAppOptions): ShellApp {
  const { terminal, theme, banner } = options;
  const tui = new TuiMainScreen(terminal);
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const content = new Container();
  content.addChild(new Text(theme.bold(theme.fg("accent", "HARIL shell")), 1, 0));
  content.addChild(
    new Text(
      theme.fg(
        "muted",
        `isolation ${banner.isolation} · ${banner.pendingApprovals} pending approvals`,
      ),
      1,
      0,
    ),
  );
  if (options.warning !== undefined) {
    content.addChild(new Text(theme.fg("warning", options.warning), 1, 0));
  }
  content.addChild(new Text(theme.fg("text", "No panels yet."), 1, 1));
  content.addChild(new Text(theme.fg("muted", "q quit · ctrl+c quit"), 1, 0));
  tui.addChild(content);

  let quitting = false;
  tui.addInputListener((data) => {
    if (!matchesKey(data, "q") && !matchesKey(data, "ctrl+c")) return undefined;
    if (!quitting) {
      quitting = true;
      tui.stop();
      void terminal.drainInput().then(() => resolveDone());
    }
    return { consume: true };
  });

  return {
    start: () => tui.start(),
    done,
  };
}
