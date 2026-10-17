// What the port contract suites share. A suite imports no test framework (the Core depends on no external package):
// the caller passes its describe and it, and a failed check throws a ContractViolation.

// The part of a test framework a suite needs (vitest's describe and it fit).
export interface ContractTestApi {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>) => void;
}

export class ContractViolation extends Error {}
