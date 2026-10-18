import { GLOB_MAX_LENGTH } from "@haril/contracts";

// Write-surface overlap (docs/modos-y-delegacion.md 3.10, spike S5 in ADR-0021). Two patterns overlap unless they
// provably match no common path, so a wrong answer can only serialize two tasks that could have run together, never
// let two writers touch the same file. When unsure, the answer is "overlap".
//
// Supported syntax: literal characters, "?" (one character, not "/"), "*" (zero or more characters, not "/") and
// "**" as a whole segment (zero or more segments). Anything else answers "they overlap": character classes, braces,
// a leading "!", backslashes (separator or escape), ".." segments and "**" inside a segment such as "a**b".
// A pattern ending in "/" names the folder's subtree; "." and "./" name the whole tree. S5 also treats an existing
// folder as "folder/**"; without the filesystem, a literal path (no wildcard) may be such a folder, so it also names
// its subtree: "src" overlaps "src/a.ts". Both sides are compared in NFC and lowercased (Windows paths are
// case-insensitive), which only widens the overlap. A pattern longer than GLOB_MAX_LENGTH (the contract's bound)
// answers "overlap" without being parsed, and the check never throws: any failure also answers "overlap".

const UNSUPPORTED = /[[\]{}!\\]/;
const WILDCARD = /[*?]/;

// Segments of a supported pattern, or null when it cannot be reasoned about.
function segmentsOf(glob: string): string[] | null {
  const text = glob.trim().normalize("NFC");
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
  // A literal path may name an existing folder: it covers its subtree too.
  if (!out.some((segment) => WILDCARD.test(segment))) out.push("**");
  return out;
}

// Whether two token sequences share a match, where `wild` absorbs zero or more tokens of the other side and `meet`
// decides whether two plain tokens can match the same text. Bottom-up over the pairs of positions, so the work is
// bounded by the product of the lengths and nothing recurses. The same rule runs on characters inside a segment ("*")
// and on segments of a path ("**").
function sequencesMeet(
  left: readonly string[],
  right: readonly string[],
  wild: string,
  meet: (a: string, b: string) => boolean,
): boolean {
  const width = right.length + 1;
  // can[i * width + j]: left[i..] and right[j..] share a match.
  const can = new Uint8Array((left.length + 1) * width);
  for (let i = left.length; i >= 0; i--) {
    for (let j = right.length; j >= 0; j--) {
      const index = i * width + j;
      const leftToken = left[i];
      const rightToken = right[j];
      let result: boolean;
      if (leftToken === undefined && rightToken === undefined) result = true;
      else if (leftToken === wild) {
        result = can[index + width] === 1 || (rightToken !== undefined && can[index + 1] === 1);
      } else if (rightToken === wild) {
        result = can[index + 1] === 1 || (leftToken !== undefined && can[index + width] === 1);
      } else if (leftToken === undefined || rightToken === undefined) result = false;
      else result = can[index + width + 1] === 1 && meet(leftToken, rightToken);
      can[index] = result ? 1 : 0;
    }
  }
  return can[0] === 1;
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
  if (left.length > GLOB_MAX_LENGTH || right.length > GLOB_MAX_LENGTH) return true;
  try {
    const a = segmentsOf(left);
    const b = segmentsOf(right);
    if (a === null || b === null) return true;
    return sequencesMeet(a, b, "**", segmentsMeet);
  } catch {
    return true;
  }
}

// Two write surfaces overlap when any pattern of one may overlap any pattern of the other. An empty surface (a
// read-only task) locks nothing.
export function surfacesMayOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => globsMayOverlap(a, b)));
}
