import type { DelegationLimits } from "./limits.js";

// A council's discussion in code (feature haril-factory, F7). It needs at least COUNCIL_MIN_OPINIONS valid opinions: a
// proposal with fewer councillors is refused, and when too few answer the work stops with an explanation instead of
// continuing with two. The sintetizador joins the opinions and is not counted. Pure.

export const COUNCIL_MIN_OPINIONS = 3;
export const COUNCILLOR_ROLE = "consejero";
export const SYNTHESIZER_ROLE = "sintetizador";

export function councilProposalProblem(
  roles: readonly (string | null | undefined)[],
  limits: Pick<DelegationLimits, "maxCouncillors">,
): string | null {
  const count = roles.filter((role) => role === COUNCILLOR_ROLE).length;
  if (count === 0) return null;
  if (count < COUNCIL_MIN_OPINIONS) {
    return `a council needs at least ${COUNCIL_MIN_OPINIONS} councillors and this proposal has ${count}; the sintetizador is not counted`;
  }
  if (count > limits.maxCouncillors) {
    return `a council has at most ${limits.maxCouncillors} councillors and this proposal has ${count}`;
  }
  return null;
}

// An opinion counts when it says something; a councillor that answered nothing gave none.
export function isValidOpinion(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trim() !== "";
}

export function councilStopReason(valid: number): string {
  return `council_below_minimum:${valid}/${COUNCIL_MIN_OPINIONS}`;
}

// The first of `models` not in `taken`, else the first of them, marked repeated: different models where possible.
export function nextCouncilModel(
  models: readonly string[],
  taken: readonly string[],
): { readonly model: string; readonly repeated: boolean } | null {
  const free = models.find((model) => !taken.includes(model));
  if (free !== undefined) return { model: free, repeated: false };
  const first = models[0];
  return first === undefined ? null : { model: first, repeated: true };
}
