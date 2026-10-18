// Write-surface overlap (docs/modos-y-delegacion.md 3.10, spike S5 in ADR-0021). Two patterns overlap unless they
// provably match no common path, so a wrong answer can only serialize two tasks that could have run together, never
// let two writers touch the same file.
//
// Supported syntax: literal characters, "?" (one character, not "/"), "*" (zero or more characters, not "/") and
// "**" as a whole segment (zero or more segments). Anything else answers "they overlap": character classes, braces,
// a leading "!", backslashes (separator or escape), ".." segments and "**" inside a segment such as "a**b".
// A pattern ending in "/" names the folder's subtree; "." and "./" name the whole tree. S5 also treats an existing
// folder as "folder/**"; that needs the filesystem, so the caller expands it before asking.

const UNSUPPORTED = /[[\]{}!\\]/;

// Segments of a supported pattern, or null when it cannot be reasoned about. Lowercased because Windows paths are
// case-insensitive; that only widens the overlap.
function segmentsOf(glob: string): string[] | null {
  const text = glob.trim();
  if (UNSUPPORTED.test(text)) return null;
  let path = text.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/");
  if (path.endsWith("/")) path += "**";
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  if (segments.some((segment) => segment !== "**" && segment.includes("**"))) return null;
  if (segments.length === 0) return ["**"];
  const out: string[] = [];
  for (const segment of segments) {
    if (!(segment === "**" && out[out.length - 1] === "**")) out.push(segment.toLowerCase());
  }
  return out;
}

// Whether two token sequences share a match, where `wild` absorbs zero or more tokens of the other side and `meet`
// decides whether two plain tokens can match the same text. Memoized on the pair of positions. The same recursion
// runs on characters inside a segment ("*") and on segments of a path ("**").
function sequencesMeet(
  left: readonly string[],
  right: readonly string[],
  wild: string,
  meet: (a: string, b: string) => boolean,
): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (right.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let result: boolean;
    if (i === left.length && j === right.length) result = true;
    else if (i < left.length && left[i] === wild) {
      result = go(i + 1, j) || (j < right.length && go(i, j + 1));
    } else if (j < right.length && right[j] === wild) {
      result = go(i, j + 1) || (i < left.length && go(i + 1, j));
    } else if (i === left.length || j === right.length) result = false;
    else result = meet(left[i] as string, right[j] as string) && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

// Two single-segment patterns (characters, "?", "*") share a string.
function segmentsMeet(left: string, right: string): boolean {
  return sequencesMeet(
    Array.from(left),
    Array.from(right),
    "*",
    (a, b) => a === "?" || b === "?" || a === b,
  );
}

export function globsMayOverlap(left: string, right: string): boolean {
  const a = segmentsOf(left);
  const b = segmentsOf(right);
  if (a === null || b === null) return true;
  return sequencesMeet(a, b, "**", segmentsMeet);
}

// Two write surfaces overlap when any pattern of one may overlap any pattern of the other. An empty surface (a
// read-only task) locks nothing.
export function surfacesMayOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => globsMayOverlap(a, b)));
}
