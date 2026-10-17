import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The token guards the control channel against other local processes that could reach the pipe (ARCH 4.3). It is a
// file in the data root, readable by the user only (mode 0o600 where the platform keeps modes).

const TOKEN_BYTES = 32;
const FILE_MODE = 0o600;

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function writeToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { encoding: "utf8", mode: FILE_MODE });
}

// The token in the file, or undefined when there is none.
export function readToken(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

// Constant-time comparison. Lengths are not secret: a token of another length is simply not the token.
export function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Removes the file only while it still holds this server's token: a successor runtime that wrote its own token
// is left alone.
export function removeOwnToken(file: string, token: string): void {
  if (readToken(file) !== token) return;
  rmSync(file, { force: true });
}
