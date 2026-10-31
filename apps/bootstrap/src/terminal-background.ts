import { deflateSync } from "node:zlib";

// The default background of the HARIL Windows Terminal profile: an original image drawn by this code, so it carries no
// third-party art. A deep navy gradient, faint stars and circuit traces in electric blue and one thin orange accent. The
// same bytes come out on every run, so reinstalling rewrites nothing. It must stay dark: text is read on top of it.

const WIDTH = 1280;
const HEIGHT = 720;
const NAVY = [7, 23, 44] as const;
const DEEPER = [3, 12, 26] as const;
const BLUE = [94, 194, 255] as const;
const ORANGE = [255, 159, 69] as const;

const CRC_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function terminalBackgroundPng(): Uint8Array {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      // Lit from the upper left, falling off to the deeper navy at the far corner.
      const fall = Math.min(1, (x / WIDTH + y / HEIGHT) / 2 + 0.1);
      const at = (y * WIDTH + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const from = NAVY[channel] as number;
        const to = DEEPER[channel] as number;
        pixels[at + channel] = Math.round(from + (to - from) * fall);
      }
    }
  }
  const blend = (x: number, y: number, color: readonly number[], amount: number): void => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    const at = (y * WIDTH + x) * 3;
    for (let channel = 0; channel < 3; channel++) {
      const base = pixels[at + channel] as number;
      pixels[at + channel] = Math.round(base + ((color[channel] as number) - base) * amount);
    }
  };
  // A fixed sequence, not Math.random: the image is the same on every machine.
  let seed = 0x48415249;
  const next = (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % limit;
  };
  for (let star = 0; star < 420; star++) {
    blend(next(WIDTH), next(HEIGHT), BLUE, 0.1 + next(30) / 100);
  }
  // Circuit traces: runs along a grid that turn at 45 degrees and end in a small pad.
  for (let trace = 0; trace < 26; trace++) {
    let x = next(WIDTH / 32) * 32;
    let y = next(HEIGHT / 32) * 32;
    for (let leg = 0; leg < 3; leg++) {
      const length = 32 * (2 + next(6));
      const [dx, dy] = leg === 1 ? [1, 1] : [1, 0];
      for (let step = 0; step < length; step++) {
        blend(x, y, BLUE, 0.1);
        x += dx;
        y += dy;
      }
    }
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) blend(x + a, y + b, BLUE, 0.18);
  }
  // The orange accent: one thin line near the bottom, brightest in its middle.
  for (let x = 0; x < WIDTH; x++) {
    const middle = 1 - Math.abs(x / WIDTH - 0.5) * 2;
    blend(x, HEIGHT - 28, ORANGE, 0.22 * middle);
  }

  const raw = new Uint8Array((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    raw.set(pixels.subarray(y * WIDTH * 3, (y + 1) * WIDTH * 3), y * (WIDTH * 3 + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, WIDTH);
  view.setUint32(4, HEIGHT);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB.
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
