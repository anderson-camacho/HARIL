import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";

// A pi-tui Terminal that records what the TUI writes and feeds scripted keys. No process stdio is touched.
// CSI and OSC sequences. The escape character is built at run time so the pattern stays readable.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`,
  "g",
);

function plainText(chunks: readonly string[]): string {
  return chunks.join("").replace(ANSI, "");
}

export class VirtualTerminal implements Terminal {
  readonly output: string[] = [];
  started = false;
  stopped = false;
  private inputHandler: ((data: string) => void) | undefined;
  private readonly scriptedInput: readonly string[];
  private readonly size: { readonly columns: number; readonly rows: number };

  // `scriptedInput` is delivered once the TUI has started, one chunk per macrotask.
  constructor(
    scriptedInput: readonly string[] = [],
    size: { readonly columns: number; readonly rows: number } = { columns: 80, rows: 24 },
  ) {
    this.scriptedInput = scriptedInput;
    this.size = size;
  }

  start(onInput: (data: string) => void): void {
    this.started = true;
    this.inputHandler = onInput;
    this.scriptedInput.forEach((data, index) => {
      setTimeout(() => this.send(data), index);
    });
  }

  send(data: string): void {
    this.inputHandler?.(data);
  }

  stop(): void {
    this.stopped = true;
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.output.push(data);
  }

  get columns(): number {
    return this.size.columns;
  }

  get rows(): number {
    return this.size.rows;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}

  screen(): string {
    return plainText(this.output);
  }
}
