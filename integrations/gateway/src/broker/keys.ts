import { createHash, randomBytes } from "node:crypto";

// A virtual key is 256 random bits, base64url encoded (ADR-0005 BR-3). Only its SHA-256 hash is persisted.
const KEY_BYTES = 32;

export function newVirtualKey(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

export function hashVirtualKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
