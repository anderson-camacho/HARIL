// The adapter's own operationId ledger for the writes Engram keeps none for [S]: POST /sessions/{id}/end and DELETE
// /observations/{id} take no operation_id (memory.md 4.2). It keeps the first receipt of each summarize and forget,
// and the hard forgets that were sent, so a retry whose first answer was lost is settled. It is bounded and lives in
// the process: after a restart a replayed summarize is settled by comparing the stored summary (deduped or
// SessionEnded, memory.md 4.2), and a hard forget whose answer was lost before the restart finds the record gone and
// answers NotFound, so its outbox row goes dead (documented, not resolved).
import type { ForgetReceipt, WriteReceipt } from "@haril/contracts";
import { contractInvalid, type Outcome, ok } from "./support.js";

const LEDGER_LIMIT = 10_000;

type LedgerOperation = "summarize" | "forget";

interface LedgerEntry {
  readonly operation: LedgerOperation;
  readonly fingerprint: string;
  readonly receipt: WriteReceipt | ForgetReceipt;
}

// Insertion-ordered, so the oldest entry goes first when the bound is reached.
function bounded<K, V>(map: Map<K, V>): void {
  if (map.size < LEDGER_LIMIT) return;
  const oldest = map.keys().next();
  if (oldest.done !== true) map.delete(oldest.value);
}

export class OperationLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly hardForgets = new Map<string, true>();

  has(operationId: string): boolean {
    return this.entries.has(operationId);
  }

  // The first receipt of an operationId sent again for the same request; contract.invalid when it came with another
  // request (CM-12); undefined for a new one.
  replay<T extends WriteReceipt | ForgetReceipt>(
    operationId: string,
    operation: LedgerOperation,
    fingerprint: string,
  ): Outcome<T> | undefined {
    const first = this.entries.get(operationId);
    if (first === undefined) return undefined;
    if (first.operation !== operation || first.fingerprint !== fingerprint) {
      return contractInvalid("the operationId was already used with another request");
    }
    return ok(structuredClone(first.receipt) as T);
  }

  remember(
    operationId: string,
    operation: LedgerOperation,
    fingerprint: string,
    receipt: WriteReceipt | ForgetReceipt,
  ): void {
    bounded(this.entries);
    this.entries.set(operationId, { operation, fingerprint, receipt: structuredClone(receipt) });
    this.hardForgets.delete(operationId);
  }

  // A hard forget about to be sent: when its answer is lost, the retry that finds the record gone is its success.
  sendingHardForget(operationId: string): void {
    bounded(this.hardForgets);
    this.hardForgets.set(operationId, true);
  }

  sentHardForget(operationId: string): boolean {
    return this.hardForgets.has(operationId);
  }
}
