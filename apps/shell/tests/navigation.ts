import type { ShellApp } from "../src/app.js";
import type { VirtualTerminal } from "./virtual-terminal.js";

// The shell opens in input mode (LD-T6b-2), where q, the digits and every other single key are typed into the input
// box. The tests written for the single keys start it with Esc pressed once: in navigation mode each key acts as
// before.
export function inNavigationMode(app: ShellApp, terminal: VirtualTerminal): ShellApp {
  return {
    ...app,
    start: () => {
      app.start();
      terminal.send("\x1b");
    },
  };
}
