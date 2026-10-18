import {
  type DelegationFieldValue,
  type DelegationSettings,
  delegationFieldValues,
  delegationSectionErrors,
  resolveDelegationSettings,
} from "@haril/contracts";
import { DEFAULT_DELEGATION_LIMITS, type DelegationLimits } from "@haril/core";

// The `delegation` section of haril.json (docs/modos-y-delegacion.md 5; phases F6 and F7). Its fields, validation and
// defaults are one table in @haril/contracts (delegation-config.ts), which haril shell reads too; this module is the
// app's side: the settings of a section the table accepted, each field with its source, and the runtime's limits.
// Keys are never stored here: the management key lives in the environment variable that managementKeyEnv names (P7).

export type { DelegationSettings };
export { delegationSectionErrors };

// The settings of a section that delegationSectionErrors accepted; absent values take section 5's defaults.
export function delegationSettingsOf(value: unknown): DelegationSettings {
  return resolveDelegationSettings(value);
}

// Every field of the section in a parsed haril.json, with what applies and where it comes from (the file or the
// default). `haril config get` and the console's Delegation section show these.
export function delegationFieldsOf(document: unknown): DelegationFieldValue[] {
  const section =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>).delegation
      : undefined;
  return delegationFieldValues(section);
}

// The runtime's limits from the section's: the same keys, plus the depth rule, which is not a key of the file.
export function delegationLimitsOf(limits: DelegationSettings["limits"]): DelegationLimits {
  return {
    maxActiveChildren: { ...limits.maxActiveChildren },
    maxQueuedTasksPerThread: limits.maxQueuedTasksPerThread,
    maxProposalsPerThread: limits.maxProposalsPerThread,
    maxConcurrent: { ...limits.maxConcurrent },
    maxAgentsPerWorkflow: limits.maxAgentsPerWorkflow,
    maxDepth: DEFAULT_DELEGATION_LIMITS.maxDepth,
    maxAuditRetries: limits.maxAuditRetries,
    maxEscalationsPerTask: limits.maxEscalationsPerTask,
    maxWorkflowTokens: limits.maxWorkflowTokens,
    maxWorkflowWallMs: limits.maxWorkflowWallMs,
    largeTaskTokens: limits.largeTaskTokens,
    attemptTimeoutMs: limits.attemptTimeoutMs,
  };
}
