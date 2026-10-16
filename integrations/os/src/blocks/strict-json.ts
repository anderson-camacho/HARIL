// Strict reader for the frontmatter document (ADR-0014 D4, D6). The frontmatter is one JSON document, which
// is also a YAML 1.2 flow document, so a block stays readable as YAML and no YAML dependency is needed.
// Rejected: duplicate keys, the __proto__ key, tabs as whitespace, unescaped control characters, trailing
// content and nesting deeper than MAX_DEPTH. Objects are created without a prototype.

const MAX_DEPTH = 32;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export type StrictJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

class JsonProblem extends Error {}

export function parseStrictJson(text: string): StrictJsonResult {
  const reader = new StrictReader(text);
  try {
    reader.skipSpace();
    const value = reader.readValue(0);
    reader.skipSpace();
    if (!reader.atEnd()) throw reader.problem("unexpected content after the document");
    return { ok: true, value };
  } catch (error) {
    if (error instanceof JsonProblem) return { ok: false, error: error.message };
    throw error;
  }
}

class StrictReader {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  atEnd(): boolean {
    return this.index >= this.text.length;
  }

  problem(message: string): JsonProblem {
    return new JsonProblem(`${message} at offset ${this.index}`);
  }

  skipSpace(): void {
    for (;;) {
      const char = this.text[this.index];
      if (char === "\t") throw this.problem("tab characters are not allowed");
      if (char !== " " && char !== "\n" && char !== "\r") return;
      this.index++;
    }
  }

  readValue(depth: number): unknown {
    if (depth > MAX_DEPTH) throw this.problem("nesting is too deep");
    const char = this.text[this.index];
    if (char === "{") return this.readObject(depth);
    if (char === "[") return this.readArray(depth);
    if (char === '"') return this.readString();
    if (char === "t") return this.readWord("true", true);
    if (char === "f") return this.readWord("false", false);
    if (char === "n") return this.readWord("null", null);
    return this.readNumber();
  }

  private readObject(depth: number): Record<string, unknown> {
    this.index++;
    const object: Record<string, unknown> = Object.create(null);
    this.skipSpace();
    if (this.text[this.index] === "}") {
      this.index++;
      return object;
    }
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] !== '"') throw this.problem("expected a string key");
      const key = this.readString();
      if (key === "__proto__") throw this.problem('forbidden key "__proto__"');
      if (Object.hasOwn(object, key)) throw this.problem(`duplicate key "${key}"`);
      this.skipSpace();
      this.expect(":");
      this.skipSpace();
      object[key] = this.readValue(depth + 1);
      this.skipSpace();
      if (this.text[this.index] !== ",") break;
      this.index++;
    }
    this.expect("}");
    return object;
  }

  private readArray(depth: number): unknown[] {
    this.index++;
    const items: unknown[] = [];
    this.skipSpace();
    if (this.text[this.index] === "]") {
      this.index++;
      return items;
    }
    for (;;) {
      this.skipSpace();
      items.push(this.readValue(depth + 1));
      this.skipSpace();
      if (this.text[this.index] !== ",") break;
      this.index++;
    }
    this.expect("]");
    return items;
  }

  private readString(): string {
    this.index++;
    let out = "";
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) throw this.problem("unterminated string");
      this.index++;
      if (char === '"') return out;
      if (char === "\\") {
        out += this.readEscape();
      } else if (char < " ") {
        throw this.problem("control characters must be escaped in strings");
      } else {
        out += char;
      }
    }
  }

  private readEscape(): string {
    const char = this.text[this.index];
    this.index++;
    switch (char) {
      case '"':
      case "\\":
      case "/":
        return char;
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.problem("invalid unicode escape");
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw this.problem("invalid escape sequence");
    }
  }

  private readWord<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.index)) throw this.problem("unexpected token");
    this.index += word.length;
    return value;
  }

  private readNumber(): number {
    NUMBER.lastIndex = this.index;
    const found = NUMBER.exec(this.text);
    if (found === null) throw this.problem("unexpected token");
    this.index += found[0].length;
    const value = Number(found[0]);
    if (!Number.isFinite(value)) throw this.problem("number is out of range");
    return value;
  }

  private expect(char: string): void {
    if (this.text[this.index] !== char) throw this.problem(`expected "${char}"`);
    this.index++;
  }
}
