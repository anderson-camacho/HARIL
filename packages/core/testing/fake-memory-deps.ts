import { estimateTokens } from "../src/memory/index.js";
import type { CancelSignal, Hasher, Ids, MemoryProviderDeps } from "../src/ports/index.js";
import { FakeClock } from "./fake-clock.js";

// Deterministic dependencies for the memory providers and their contract suite (memory.md 8: each implementation brings
// its own Clock, Ids, Hasher and TokenEstimator). The Core has no node:crypto, so the hasher is a pure SHA-256.

// Identifiers <prefix>-1, <prefix>-2, ... in call order.
export class SequentialIds implements Ids {
  private count = 0;
  private readonly prefix: string;

  constructor(prefix = "id") {
    this.prefix = prefix;
  }

  next(): string {
    this.count += 1;
    return `${this.prefix}-${this.count}`;
  }
}

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

// The UTF-8 bytes of a text; a lone surrogate is encoded as U+FFFD, as TextEncoder does.
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    let code = char.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

// SHA-256 (FIPS 180-4) in plain TypeScript, for tests only: production injects the node:crypto one.
export class Sha256Hasher implements Hasher {
  sha256(text: string): string {
    const bytes = utf8Bytes(text);
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // The bit length as a 64-bit big-endian integer; texts under 512 MiB fit in the low word.
    const high = Math.floor(bitLength / 0x100000000);
    for (const word of [high, bitLength >>> 0]) {
      bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
    }
    const state = [...INITIAL_STATE];
    const schedule = new Array<number>(64).fill(0);
    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let i = 0; i < 16; i++) {
        const at = offset + i * 4;
        schedule[i] =
          (((bytes[at] ?? 0) << 24) |
            ((bytes[at + 1] ?? 0) << 16) |
            ((bytes[at + 2] ?? 0) << 8) |
            (bytes[at + 3] ?? 0)) >>>
          0;
      }
      for (let i = 16; i < 64; i++) {
        const w15 = schedule[i - 15] ?? 0;
        const w2 = schedule[i - 2] ?? 0;
        const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
        const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
        schedule[i] = ((schedule[i - 16] ?? 0) + s0 + (schedule[i - 7] ?? 0) + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = state as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      for (let i = 0; i < 64; i++) {
        const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choice = (e & f) ^ (~e & g);
        const t1 = (h + s1 + choice + (ROUND_CONSTANTS[i] ?? 0) + (schedule[i] ?? 0)) >>> 0;
        const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      const round = [a, b, c, d, e, f, g, h];
      for (let i = 0; i < 8; i++) state[i] = ((state[i] ?? 0) + (round[i] ?? 0)) >>> 0;
    }
    return state.map((word) => word.toString(16).padStart(8, "0")).join("");
  }
}

// A signal already cancelled, or one the test cancels later with cancel().
export function cancelSignal(cancelled = false): CancelSignal & { cancel(): void } {
  const listeners = new Set<() => void>();
  const signal = {
    cancelled,
    onCancel(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel(): void {
      if (signal.cancelled) return;
      signal.cancelled = true;
      for (const listener of listeners) listener();
    },
  };
  return signal;
}

// The dependencies of one provider under test: a virtual clock, sequential ids, SHA-256 and the default estimator
// (UTF-8 bytes, CM-03).
export function fakeMemoryDeps(
  idPrefix = "mem",
): MemoryProviderDeps & { readonly clock: FakeClock } {
  return {
    clock: new FakeClock(),
    ids: new SequentialIds(idPrefix),
    hasher: new Sha256Hasher(),
    estimateTokens,
  };
}
