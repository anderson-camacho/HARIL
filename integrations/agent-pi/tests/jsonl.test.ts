import { describe, expect, it } from "vitest";
import { JsonlReader } from "../src/jsonl.js";

function collect(maxLineBytes?: number) {
  const lines: string[] = [];
  let overflows = 0;
  const reader = new JsonlReader({
    maxLineBytes,
    onLine: (line) => lines.push(line),
    onOverflow: () => {
      overflows++;
    },
  });
  return { reader, lines, overflows: () => overflows };
}

describe("JsonlReader", () => {
  it("splits only on LF and keeps other line separators inside the line", () => {
    const { reader, lines } = collect();
    reader.push(Buffer.from("a b\rc\n", "utf8"));
    expect(lines).toEqual(["a b\rc"]);
  });

  it("strips exactly one trailing CR", () => {
    const { reader, lines } = collect();
    reader.push(Buffer.from("x\r\ny\r\r\n", "utf8"));
    expect(lines).toEqual(["x", "y\r"]);
  });

  it("reassembles a multi-byte UTF-8 character split across chunks", () => {
    const { reader, lines } = collect();
    const bytes = Buffer.from("é ok\n", "utf8");
    reader.push(bytes.subarray(0, 1));
    reader.push(bytes.subarray(1));
    expect(lines).toEqual(["é ok"]);
  });

  it("emits a trailing partial line on end", () => {
    const { reader, lines } = collect();
    reader.push(Buffer.from("first\nsecond", "utf8"));
    reader.end();
    expect(lines).toEqual(["first", "second"]);
  });

  it("accepts a line of exactly the cap and reports overflow for one byte more", () => {
    const exact = collect(16);
    exact.reader.push(Buffer.from(`${"a".repeat(16)}\n`));
    expect(exact.lines).toHaveLength(1);
    expect(exact.overflows()).toBe(0);

    const over = collect(16);
    over.reader.push(Buffer.from(`${"a".repeat(17)}\n`));
    expect(over.lines).toEqual([]);
    expect(over.overflows()).toBe(1);
  });

  it("detects overflow while the line is still incomplete and ignores everything after it", () => {
    const { reader, lines, overflows } = collect(8);
    reader.push(Buffer.from("aaaaa"));
    reader.push(Buffer.from("aaaaa"));
    reader.push(Buffer.from("\nok\n"));
    reader.end();
    expect(lines).toEqual([]);
    expect(overflows()).toBe(1);
  });
});
