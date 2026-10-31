// The terminal's own default colours while the console runs with the Future palette: OSC 11 is the background, OSC 10
// the foreground and OSC 12 the cursor, so whatever Pi draws without a colour of its own stands on the deep navy. They
// are the terminal's state and outlive the process, so every way out restores them (OSC 110, 111, 112): a normal
// return, an error, a signal and the process's own exit. A terminal that does not know these sequences ignores them.

const ESC = "\u001b";
const ST = `${ESC}\\`;
const APPLY = `${ESC}]11;#07172c${ST}${ESC}]10;#c4e9ff${ST}${ESC}]12;#5ec2ff${ST}${ESC}[1 q`;
const RESTORE = `${ESC}]111${ST}${ESC}]110${ST}${ESC}]112${ST}${ESC}[0 q`;
const LEAVE_SCREEN = `${ESC}[0m${ESC}[?25h${ESC}[?1049l`;
const SIGNALS = ["SIGTERM", "SIGHUP", "SIGBREAK"] as const;

// CI is a flag with many spellings: anything but empty, "0" or "false" counts as CI.
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export function terminalColorsApply(input: {
  readonly isTTY: boolean;
  readonly theme: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean {
  return (
    input.isTTY &&
    input.theme === "haril-future" &&
    !isCi(input.env) &&
    input.env.TERM?.toLowerCase() !== "dumb" &&
    input.env.HARIL_TERMINAL_COLORS !== "off"
  );
}

export interface TerminalSessionPorts {
  readonly colors: boolean;
  readonly write?: (text: string) => void;
  readonly on?: (event: string, handler: () => void) => void;
  readonly off?: (event: string, handler: () => void) => void;
  // Gives a caught signal back to the process once the terminal is restored.
  readonly raise?: (signal: string) => void;
}

export interface TerminalSession {
  // The welcome left its full-screen buffer open for Pi to take over, with the cursor hidden.
  screenKept(): void;
  restore(): void;
}

export function openTerminalSession(ports: TerminalSessionPorts): TerminalSession {
  const write = ports.write ?? ((text: string) => void process.stdout.write(text));
  const on = ports.on ?? ((event, handler) => void process.on(event, handler));
  const off = ports.off ?? ((event, handler) => void process.off(event, handler));
  const raise = ports.raise ?? ((signal) => void process.kill(process.pid, signal));
  let kept = false;
  let restored = false;
  const handlers = new Map<string, () => void>();

  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const [event, handler] of handlers) off(event, handler);
    handlers.clear();
    const text = `${kept ? LEAVE_SCREEN : ""}${ports.colors ? RESTORE : ""}`;
    if (text !== "") write(text);
  };

  if (ports.colors) write(APPLY);
  handlers.set("exit", restore);
  for (const signal of SIGNALS) {
    handlers.set(signal, () => {
      restore();
      raise(signal);
    });
  }
  for (const [event, handler] of handlers) on(event, handler);
  return {
    screenKept: () => {
      kept = true;
    },
    restore,
  };
}

export async function withTerminalSession<T>(
  ports: TerminalSessionPorts,
  body: (session: TerminalSession) => Promise<T>,
): Promise<T> {
  const session = openTerminalSession(ports);
  try {
    return await body(session);
  } finally {
    session.restore();
  }
}
