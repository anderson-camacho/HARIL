import { createHash } from "node:crypto";

// SHA-256 helpers for the official SHASUMS256.txt (format: "<64 hex>  <file name>").

const LINE = /^([0-9a-f]{64})\s+\*?(\S+)$/;

export function parseShasums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const match = LINE.exec(line);
    if (match === null) throw new Error("malformed SHA-256 line in SHASUMS256.txt");
    entries.set(match[2] ?? "", match[1] ?? "");
  }
  return entries;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
