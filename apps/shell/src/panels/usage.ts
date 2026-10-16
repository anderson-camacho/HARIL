import { pad, payloadSummary, time } from "../format.js";
import { type PanelContext, type PanelView, storeMessage } from "./types.js";

// The panels about numbers: settled tokens and runs per project, and the event log.

const COST_NOTE = "Settled token ledger per project. Cost is not tracked (token budgets only).";

// Two lines per project: the settled tokens, then the runs and their outcomes. Lines are wrapped by the app.
export function tokensView(context: PanelContext): PanelView {
  const { snapshot, scope } = context;
  const message = storeMessage(snapshot);
  const rows = snapshot.metrics.filter((entry) => scope === undefined || entry.projectId === scope);
  const blocks = rows.flatMap((entry) => {
    const { snapshot: metrics, usage } = entry;
    const runs = Object.values(metrics.runsByStatus).reduce((sum, count) => sum + count, 0);
    const completed = metrics.runsByStatus.completed ?? 0;
    const failed = metrics.runsByStatus.failed ?? 0;
    const rate =
      completed + failed === 0
        ? "n/a"
        : `${((completed / (completed + failed)) * 100).toFixed(1)}%`;
    const tokens =
      usage === null
        ? "tokens none settled"
        : `tokens in ${usage.inputTokens}, out ${usage.outputTokens}, unreconciled ${usage.unreconciled}`;
    return [
      `${entry.slug}: ${tokens}`,
      `  runs ${runs} (ok ${completed}, failed ${failed}), success ${rate}, verified ${metrics.verifiedCompletions}, unverified ${metrics.unverifiedCompletions}`,
      "",
    ];
  });
  return {
    header: [...(message === undefined ? [] : [message]), COST_NOTE, "", ...blocks],
    items: [],
    empty: rows.length === 0 && message === undefined ? "No projects yet." : undefined,
    keys: [],
  };
}

export function eventsView(context: PanelContext): PanelView {
  const { snapshot } = context;
  const message = storeMessage(snapshot);
  return {
    header: [
      ...(message === undefined ? [] : [message]),
      `newest ${snapshot.events.length} events, oldest first`,
    ],
    items: snapshot.events.map((event) => ({
      text: `${time(event.ts)}  ${pad(event.type, 22)}${event.aggregateType}:${event.aggregateId.slice(0, 8)}  ${payloadSummary(event.payload)}`,
    })),
    empty: snapshot.events.length === 0 && message === undefined ? "No events yet." : undefined,
    keys: [],
  };
}
