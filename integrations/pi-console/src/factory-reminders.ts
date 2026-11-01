// When to remind a person of what waits for them (herdr-office's escalate rules): after 1, 5 and 15 minutes, then every 15;
// never while the factory is open in front of them. Requests of one kind are one reminder. Pure.

const BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];

export interface ReminderState {
  // By request id: when it was first seen, and how many reminders it gave.
  readonly seen: Readonly<
    Record<string, { readonly at: number; readonly reminded: number; readonly last: number }>
  >;
}

export const NO_REMINDERS: ReminderState = { seen: {} };

interface Waiting {
  readonly id: string;
  readonly title: string;
  readonly group: string;
}

export interface ReminderPass {
  readonly state: ReminderState;
  // One line per group that is due.
  readonly lines: readonly string[];
}

function waitOf(reminded: number): number {
  return BACKOFF_MS[Math.min(reminded, BACKOFF_MS.length - 1)] as number;
}

export function reminderPass(
  state: ReminderState,
  waiting: readonly Waiting[],
  now: number,
  focused: boolean,
): ReminderPass {
  const seen: Record<string, { at: number; reminded: number; last: number }> = {};
  const due = new Map<string, Waiting[]>();
  for (const row of waiting) {
    const known = state.seen[row.id] ?? { at: now, reminded: 0, last: now };
    const isDue = !focused && now - known.last >= waitOf(known.reminded);
    seen[row.id] = isDue ? { at: known.at, reminded: known.reminded + 1, last: now } : { ...known };
    if (isDue) due.set(row.group, [...(due.get(row.group) ?? []), row]);
  }
  const lines = [...due.values()].map((rows) =>
    rows.length === 1
      ? `Te necesitan: ${(rows[0] as Waiting).title}`
      : `Te necesitan: ${rows.length} peticiones de este tipo. La primera: ${(rows[0] as Waiting).title}`,
  );
  return { state: { seen }, lines };
}

// What haril factory requests --model says of the model's account; null when it does not know.
export function quotaOfRead(
  stdout: string,
): { readonly usedPct: number; readonly switchAt: number } | null {
  try {
    const quota = (
      JSON.parse(stdout) as { quota?: { usedPct?: unknown; switchAt?: unknown } | null }
    ).quota;
    return typeof quota?.usedPct === "number" && typeof quota.switchAt === "number"
      ? { usedPct: quota.usedPct, switchAt: quota.switchAt }
      : null;
  } catch {
    return null;
  }
}
