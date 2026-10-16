// JSONL framing for the Pi RPC stream and the bridge channel (ADR-0004 decision 7). Lines end at LF only,
// one trailing CR is removed, and a line above the cap is an overflow, never a truncated line. Bytes are
// buffered and decoded per complete line, so a multi-byte UTF-8 character split across chunks is intact.

const MAX_LINE_BYTES = 8 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;

export interface JsonlReaderOptions {
  readonly onLine: (line: string) => void;
  readonly onOverflow: () => void;
  readonly maxLineBytes?: number;
}

export class JsonlReader {
  private readonly onLine: (line: string) => void;
  private readonly onOverflow: () => void;
  private readonly maxLineBytes: number;
  private readonly decoder = new TextDecoder("utf-8");
  private parts: Buffer[] = [];
  private pendingBytes = 0;
  private overflowed = false;

  constructor(options: JsonlReaderOptions) {
    this.onLine = options.onLine;
    this.onOverflow = options.onOverflow;
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  }

  push(chunk: Buffer): void {
    if (this.overflowed) return;
    let start = 0;
    for (;;) {
      const lf = chunk.indexOf(LF, start);
      if (lf === -1) {
        this.append(chunk.subarray(start));
        return;
      }
      this.append(chunk.subarray(start, lf));
      if (this.overflowed) return;
      this.emit();
      start = lf + 1;
    }
  }

  end(): void {
    if (this.overflowed || this.pendingBytes === 0) return;
    this.emit();
  }

  private append(part: Buffer): void {
    this.pendingBytes += part.length;
    if (this.pendingBytes > this.maxLineBytes) {
      this.overflowed = true;
      this.parts = [];
      this.pendingBytes = 0;
      this.onOverflow();
      return;
    }
    if (part.length > 0) this.parts.push(part);
  }

  private emit(): void {
    let line = Buffer.concat(this.parts, this.pendingBytes);
    this.parts = [];
    this.pendingBytes = 0;
    if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, -1);
    this.onLine(this.decoder.decode(line));
  }
}
