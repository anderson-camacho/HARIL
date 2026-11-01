// The vigilante's deterministic checks (feature haril-factory, F7): objective facts of one running turn, judged by code at
// no token cost. Each finding goes to the turn's parent as an event; a model is asked only when the person configured
// analysis. Pure: the clock comes in as `now`.

export interface VigilanteFacts {
  readonly now: number;
  readonly startedAt: number;
  // The newest sign of life: a settled model call or a tool call; null when none yet.
  readonly lastProgressAt: number | null;
  readonly tokensSinceProgress: number;
  // Context tokens of its last reply, and the threshold of its layer; null when unknown.
  readonly contextUsed: number | null;
  readonly contextThreshold: number | null;
  // Tool calls the host refused, newest last.
  readonly refusals: readonly string[];
}

export interface VigilantePolicy {
  readonly stalledAfterMs: number;
  readonly tokensWithoutProgress: number;
  readonly contextPercent: number;
  readonly repeatedErrors: number;
}

export const DEFAULT_VIGILANTE_POLICY: VigilantePolicy = Object.freeze({
  stalledAfterMs: 10 * 60_000,
  tokensWithoutProgress: 200_000,
  contextPercent: 90,
  repeatedErrors: 3,
});

export type VigilanteCode =
  | "stalled"
  | "tokens_without_progress"
  | "context_high"
  | "repeated_error";

export interface VigilanteFinding {
  readonly code: VigilanteCode;
  // In the words the console shows.
  readonly text: string;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

export function vigilanteFindings(
  facts: VigilanteFacts,
  policy: VigilantePolicy = DEFAULT_VIGILANTE_POLICY,
): VigilanteFinding[] {
  const findings: VigilanteFinding[] = [];
  const quietFor = facts.now - (facts.lastProgressAt ?? facts.startedAt);
  if (quietFor >= policy.stalledAfterMs) {
    findings.push({ code: "stalled", text: `Lleva ${minutes(quietFor)} min sin avanzar.` });
  }
  if (facts.tokensSinceProgress >= policy.tokensWithoutProgress) {
    findings.push({
      code: "tokens_without_progress",
      text: `Gastó ${facts.tokensSinceProgress} tokens sin tocar un archivo ni llamar una herramienta.`,
    });
  }
  if (facts.contextUsed !== null && facts.contextThreshold !== null && facts.contextThreshold > 0) {
    const percent = Math.round((facts.contextUsed / facts.contextThreshold) * 100);
    if (percent >= policy.contextPercent) {
      findings.push({ code: "context_high", text: `Su contexto está al ${percent} %.` });
    }
  }
  const last = facts.refusals[facts.refusals.length - 1];
  if (last !== undefined) {
    const repeated = facts.refusals.filter((reason) => reason === last).length;
    if (repeated >= policy.repeatedErrors) {
      findings.push({
        code: "repeated_error",
        text: `Repitió el mismo error ${repeated} veces: ${last.slice(0, 160)}`,
      });
    }
  }
  return findings;
}
