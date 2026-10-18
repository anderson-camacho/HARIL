import { describe, expect, it } from "vitest";
import {
  createTrace,
  renderTrace,
  traceResearch,
  traceToolCall,
  traceToolResult,
  traceUsage,
} from "../src/trace.js";

// The CONSULT trace (7.3 point 7, R-U7): after each turn the console says what the model did and how, in short form:
// every tool call with what it acted on and its result, the tools used and how often, the tokens and the time, and the
// research file when one was saved.

function text(value: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: value }];
}

function sampleTrace() {
  let trace = createTrace(1_000);
  trace = traceToolCall(trace, {
    toolCallId: "1",
    toolName: "read",
    input: { path: "src/console.ts" },
  });
  trace = traceToolResult(trace, { toolCallId: "1", isError: false, content: text("a\nb\nc") });
  trace = traceToolCall(trace, {
    toolCallId: "2",
    toolName: "grep",
    input: { pattern: "registerShortcut", path: "src" },
  });
  trace = traceToolResult(trace, {
    toolCallId: "2",
    isError: false,
    content: text("src/a.ts:1: x\nsrc/b.ts:2: y"),
  });
  trace = traceToolCall(trace, {
    toolCallId: "3",
    toolName: "find",
    input: { pattern: "*.test.ts" },
  });
  trace = traceToolResult(trace, {
    toolCallId: "3",
    isError: true,
    content: text("ENOENT: no such dir\nmore"),
  });
  trace = traceToolCall(
    trace,
    { toolCallId: "4", toolName: "write", input: { path: "src/x.ts", content: "secret body" } },
    "CONSULT mode is read-only",
  );
  trace = traceToolCall(trace, {
    toolCallId: "5",
    toolName: "haril_save_research",
    input: { title: "Runtime claims", content: "# body" },
  });
  trace = traceToolResult(trace, {
    toolCallId: "5",
    isError: false,
    content: text("saved docs/investigacion/2026-10-18-runtime-claims.md"),
  });
  trace = traceResearch(trace, "docs/investigacion/2026-10-18-runtime-claims.md");
  trace = traceUsage(trace, { tokensIn: 1200, tokensOut: 300 });
  trace = traceUsage(trace, { tokensIn: 800, tokensOut: null });
  trace = traceUsage(trace, { tokensIn: null, tokensOut: null });
  return trace;
}

describe("the CONSULT trace", () => {
  it("lists every call with its target and a short result", () => {
    const lines = renderTrace(sampleTrace(), 13_345).join("\n");
    expect(lines).toContain("read");
    expect(lines).toContain("src/console.ts");
    expect(lines).toContain("ok · 3 lines");
    expect(lines).toContain('"registerShortcut" in src');
    expect(lines).toContain("ok · 2 matches");
    expect(lines).toContain('"*.test.ts"');
    expect(lines).toContain("error · ENOENT: no such dir");
    expect(lines).toContain("blocked · CONSULT mode is read-only");
    expect(lines).toContain('"Runtime claims"');
  });

  it("never copies what a call wrote or read into the trace", () => {
    const lines = renderTrace(sampleTrace(), 13_345).join("\n");
    expect(lines).not.toContain("secret body");
    expect(lines).not.toContain("# body");
  });

  it("sums up the tools, the files, the searches, the tokens and the time", () => {
    const [head, ...rest] = renderTrace(sampleTrace(), 13_345);
    expect(head).toContain("CONSULT trace");
    expect(head).toContain("5 tool calls");
    expect(head).toContain("1 blocked");
    expect(head).toContain("12.3 s");
    const all = rest.join("\n");
    expect(all).toMatch(/Tools: read ×1, grep ×1, find ×1, write ×1, haril_save_research ×1/);
    expect(all).toMatch(/Files read: src\/console\.ts/);
    expect(all).toMatch(/Searches: grep "registerShortcut" in src; find "\*\.test\.ts"/);
    expect(all).toMatch(/Tokens: 2000 in · 300 out \(1 reply did not report it\)/);
    expect(all).toMatch(/Research saved: docs\/investigacion\/2026-10-18-runtime-claims\.md/);
  });

  it("says when the turn used no tool, and when no reply reported tokens", () => {
    let trace = createTrace(0);
    trace = traceUsage(trace, { tokensIn: null, tokensOut: null });
    const lines = renderTrace(trace, 500).join("\n");
    expect(lines).toContain("no tool calls");
    expect(lines).toContain("Tokens: not reported");
  });

  it("keeps a call that never got a result as running, and cuts long targets", () => {
    let trace = createTrace(0);
    trace = traceToolCall(trace, {
      toolCallId: "1",
      toolName: "read",
      input: { path: "x".repeat(300) },
    });
    const lines = renderTrace(trace, 1).join("\n");
    expect(lines).toContain("no result");
    expect(lines).not.toContain("x".repeat(100));
  });
});
