import { NODE_DIST_BASE } from "./constants.js";
import type { FetchPort } from "./ports.js";

// Downloads from the official Node release host only, with one retry after a failed attempt.

export const SHASUMS_TIMEOUT_MS = 60_000;
export const ARCHIVE_TIMEOUT_MS = 600_000;
const RETRIES = 1;

export async function getOfficial(
  fetch: FetchPort,
  url: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (!url.startsWith(NODE_DIST_BASE)) {
    throw new Error(`refusing to download from outside ${NODE_DIST_BASE}`);
  }
  let lastError: unknown = new Error(`download failed: ${url}`);
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await fetch.get(url, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
