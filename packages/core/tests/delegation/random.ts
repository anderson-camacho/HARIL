// Seeded pseudo-random generator for the property tests (mulberry32). A fixed seed makes every generated case
// reproducible, and the tests need no dependency.

export interface Random {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    },
    bool: (probability = 0.5) => next() < probability,
    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = int(0, index);
        const swap = copy[index] as T;
        copy[index] = copy[other] as T;
        copy[other] = swap;
      }
      return copy;
    },
  };
}
