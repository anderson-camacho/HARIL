import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { LineEditor } from "../src/line-editor.js";

// The input box's line editor (LD-T6b-2): one line of text and a cursor. What it holds is already plain, so what the
// box shows is what Enter sends; its view is cut to a width in cells with the cursor always inside.

const ESC = "\x1b";
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;
const HOME = `${ESC}[H`;
const END = `${ESC}[F`;
const BACKSPACE = "\x7f";
const DELETE = `${ESC}[3~`;
const CTRL_U = "\x15";
const CTRL_K = "\x0b";
const CTRL_W = "\x17";

function typed(text: string): LineEditor {
  const editor = new LineEditor();
  for (const char of text) editor.handleInput(char);
  return editor;
}

function shown(editor: LineEditor, width: number): string {
  const view = editor.view(width);
  return `${view.before}[${view.at}]${view.after}`;
}

describe("LineEditor", () => {
  it("inserts printable keys at the cursor and moves it with the arrows, Home and End", () => {
    const editor = typed("plan");
    expect(editor.value).toBe("plan");
    editor.handleInput(LEFT);
    editor.handleInput(LEFT);
    editor.handleInput("X");
    expect(editor.value).toBe("plXan");
    editor.handleInput(HOME);
    editor.handleInput("<");
    editor.handleInput(END);
    editor.handleInput(">");
    expect(editor.value).toBe("<plXan>");
    editor.handleInput(RIGHT);
    expect(shown(editor, 20)).toBe("<plXan>[ ]");
  });

  it("deletes a whole grapheme backwards and forwards", () => {
    const editor = typed("a日b");
    editor.handleInput(BACKSPACE);
    expect(editor.value).toBe("a日");
    editor.handleInput(BACKSPACE);
    expect(editor.value).toBe("a");
    editor.handleInput(HOME);
    editor.handleInput(DELETE);
    expect(editor.value).toBe("");
    editor.handleInput(BACKSPACE);
    expect(editor.value).toBe("");
  });

  it("Ctrl+U, Ctrl+K and Ctrl+W delete to the start, to the end and the word before the cursor", () => {
    const editor = typed("one two three");
    editor.handleInput(CTRL_W);
    expect(editor.value).toBe("one two ");
    editor.handleInput(LEFT);
    editor.handleInput(LEFT);
    editor.handleInput(CTRL_K);
    expect(editor.value).toBe("one tw");
    editor.handleInput(LEFT);
    editor.handleInput(CTRL_U);
    expect(editor.value).toBe("w");
  });

  it("never takes an escape sequence or a control key as text", () => {
    const editor = typed("ok");
    for (const key of [`${ESC}OP`, `${ESC}[15~`, `${ESC}x`, "\x07", "\x00", ESC])
      editor.handleInput(key);
    expect(editor.value).toBe("ok");
  });

  it("takes a Kitty CSI-u printable key as its character", () => {
    const editor = new LineEditor();
    editor.handleInput(`${ESC}[97u`);
    expect(editor.value).toBe("a");
  });

  it("never types the Private Use Area code of a Kitty function key", () => {
    const editor = typed("ok");
    // Menu, F13 and media Play decode to U+E053, U+E060 and U+E094.
    for (const code of [57427, 57440, 57492]) editor.handleInput(`${ESC}[${code}u`);
    expect(editor.value).toBe("ok");
  });

  it("turns Unicode format characters into ?, typed or pasted, so the box shows what Enter sends", () => {
    const editor = typed("do");
    editor.handleInput("\u{200B}");
    editor.handleInput("it");
    editor.handleInput(`${ESC}[200~\u{202E}!\u{E0041}\u{E007F}\u{FEFF}${ESC}[201~`);
    expect(editor.value).toBe("do?it?!???");
    // The zero-width joiner of an emoji sequence stays.
    editor.setValue("\u{1F468}\u{200D}\u{1F469}");
    expect(editor.value).toBe("\u{1F468}\u{200D}\u{1F469}");
  });

  it("joins a surrogate pair sent in two keys, and never keeps half of one", () => {
    const editor = new LineEditor();
    editor.handleInput("\ud83d");
    editor.handleInput("\ude00");
    expect(editor.value).toBe("\u{1F600}");
    // A high surrogate that no low one follows is dropped; a lone low one too.
    editor.handleInput("\ud83d");
    editor.handleInput("a");
    editor.handleInput("\ude00");
    expect(editor.value).toBe("\u{1F600}a");
    // A lone surrogate in a paste becomes ?.
    editor.handleInput(`${ESC}[200~\ud83dz${ESC}[201~`);
    expect(editor.value).toBe("\u{1F600}a?z");
  });

  it("at the cap a pair that does not fit is left out whole", () => {
    const editor = new LineEditor();
    editor.handleInput(`${ESC}[200~${"x".repeat(LineEditor.MAX - 1)}${ESC}[201~`);
    editor.handleInput("\ud83d");
    editor.handleInput("\ude00");
    expect(editor.value).toBe("x".repeat(LineEditor.MAX - 1));
  });

  it("a bracketed paste joins its lines and turns control characters into ?", () => {
    const editor = typed(">");
    editor.handleInput(`${ESC}[200~one\r\ntwo\x1b]0;title\x07\tend${ESC}[201~`);
    expect(editor.value).toBe(">one two?]0;title? end");
    // A paste split across chunks is kept until it ends.
    editor.handleInput(`${ESC}[200~par`);
    expect(editor.value).toBe(">one two?]0;title? end");
    editor.handleInput(`ts${ESC}[201~!`);
    expect(editor.value).toBe(">one two?]0;title? endparts!");
  });

  it("keeps at most MAX characters", () => {
    const editor = new LineEditor();
    editor.handleInput(`${ESC}[200~${"x".repeat(LineEditor.MAX + 50)}${ESC}[201~`);
    expect(editor.value).toHaveLength(LineEditor.MAX);
    editor.handleInput("y");
    expect(editor.value).toHaveLength(LineEditor.MAX);
  });

  it("clear and setValue reset the text, the cursor goes to the end", () => {
    const editor = typed("abc");
    editor.setValue("/plans ");
    expect(shown(editor, 20)).toBe("/plans [ ]");
    editor.clear();
    expect(editor.value).toBe("");
  });

  it("the view is never wider than asked and always holds the cursor, with wide characters too", () => {
    const editor = typed("日本語のテキストとascii混在の長い入力");
    for (const width of [1, 2, 3, 5, 8, 13, 40]) {
      for (let step = 0; step < 30; step++) {
        const view = editor.view(width);
        const cells = visibleWidth(`${view.before}${view.at}${view.after}`);
        if (width >= 2) {
          expect(cells).toBeLessThanOrEqual(width);
          expect(view.at).not.toBe("");
        }
        editor.handleInput(LEFT);
      }
      editor.handleInput(END);
    }
    // The cursor at the end of a long text shows the tail of it.
    expect(editor.view(6).before).toBe("入力");
  });
});
