import { REDACTED } from "@haril/contracts";

// The preview an order keeps in the orders log (docs/modos-y-delegacion.md 4.5, P15): at most 200 characters on one
// line, with basic redaction of keys and tokens. The log stores the order's hash and length and this preview, never the
// full text. Redaction runs on the whole text before the cut, so a secret at the edge is never half shown. It is basic
// on purpose: provider-style keys, bearer tokens, JWTs, the value of a key/token/secret/password assignment, and long
// runs that mix letters and digits like hex or base64. It may hide a harmless word; it never widens what is kept.

export const ORDER_PREVIEW_MAX = 200;

const PATTERNS: readonly [RegExp, string][] = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [
    /\b([A-Za-z_-]*(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|access[_-]?key|private[_-]?key))(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${REDACTED}`,
  ],
];

// A long run of base64 or hex characters that mixes letters and digits.
const OPAQUE_RUN = /[A-Za-z0-9+=_]{32,}/g;

function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.replace(OPAQUE_RUN, (run) =>
    /[0-9]/.test(run) && /[A-Za-z]/.test(run) ? REDACTED : run,
  );
}

export function orderPreview(text: string): string {
  const line = redact(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  if (chars.length <= ORDER_PREVIEW_MAX) return line;
  return `${chars.slice(0, ORDER_PREVIEW_MAX - 1).join("")}…`;
}
