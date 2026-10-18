import type { CliResult } from "./cli.js";
import { type ConsoleMode, orderModeOf } from "./modes.js";
import type { AgentMessage } from "./pi-types.js";

// The console's chat log (docs/modos-y-delegacion.md 4.5, R-L1, P14, P15): every prompt typed in the console is an
// order row, and every model reply a usage row with its provider, model, tokens, duration and outcome. Each row goes
// through `haril usage record --stdin` as JSON on stdin (the prompt never travels in argv); the CLI keeps only the
// prompt's hash, length and a redacted 200-character preview, and appends without a runtime (P14). Rows go one at a
// time, in order, so a reply links to the order of its prompt. Logging never blocks or breaks the chat: a row that
// fails is tried once more, then counted for the bar, and nothing here throws.

const RECORD_ARGS = ["usage", "record", "--stdin", "--json"] as const;
const DEFAULT_RETRY_MS = 500;
// What the CLI accepts as an identifier (usage-record.ts): printable ASCII without spaces.
const IDENTIFIER = /^[!-~]{1,256}$/;

export interface ChatLogDeps {
  // Runs `haril <args>` with `input` on stdin.
  run(args: readonly string[], input: string): Promise<CliResult>;
  projectSlug(): string | undefined;
  sessionId(): string | undefined;
  retryDelayMs?: number;
  // Called when the counts change, so the bar can redraw.
  onChange?(): void;
}

interface ChatLogStatus {
  readonly recorded: number;
  readonly failed: number;
  readonly lastError: string | undefined;
}

export interface ChatLog {
  order(text: string, mode: ConsoleMode): void;
  usage(message: AgentMessage, mode: ConsoleMode): void;
  status(): ChatLogStatus;
  // Resolves once every queued row has been tried (tests and shutdown).
  idle(): Promise<void>;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// A usage row for one assistant message. Pi reports 0 tokens when a provider reports none: a reply with no token at
// all counts as not reported (null), never as 0.
function usageRow(
  message: AgentMessage,
  mode: ConsoleMode,
  sessionId: string | null,
  orderId: string | null,
) {
  const usage = message.usage;
  const reported =
    usage !== undefined &&
    ((usage.input ?? 0) > 0 || (usage.output ?? 0) > 0 || (usage.totalTokens ?? 0) > 0);
  const cost = usage?.cost?.total;
  const startedAt = count(message.timestamp);
  const durationMs = count(message.durationMs);
  const key = identifier(message.responseId) ?? (startedAt === null ? null : String(startedAt));
  return {
    kind: "chat",
    mode: orderModeOf(mode),
    orderId,
    sessionId,
    provider: identifier(message.provider),
    modelRequested: identifier(message.model),
    modelServed: identifier(message.responseModel),
    tokensIn: reported ? count(usage?.input) : null,
    tokensOut: reported ? count(usage?.output) : null,
    tokensCached: reported ? count(usage?.cacheRead) : null,
    tokensReasoning: reported ? count(usage?.reasoning) : null,
    costMicros:
      typeof cost === "number" && Number.isFinite(cost) && cost > 0
        ? Math.round(cost * 1_000_000)
        : null,
    startedAt,
    endedAt: startedAt !== null && durationMs !== null ? startedAt + durationMs : null,
    durationMs,
    outcome: identifier(message.stopReason),
    idempotencyKey: sessionId === null || key === null ? null : `${sessionId}:message:${key}`,
  };
}

export function createChatLog(deps: ChatLogDeps): ChatLog {
  let tail: Promise<void> = Promise.resolve();
  let recorded = 0;
  let failed = 0;
  let lastError: string | undefined;
  let inputs = 0;
  // The order id of the latest prompt, for the replies it causes; null when that order was not recorded.
  let currentOrder: string | null = null;

  const changed = (): void => {
    try {
      deps.onChange?.();
    } catch {
      // A redraw failure is not the log's to report.
    }
  };

  const args = (): string[] => {
    const slug = deps.projectSlug();
    return [...RECORD_ARGS, ...(slug === undefined ? [] : ["--project", slug])];
  };

  // One row, tried twice; resolves with the id the CLI gave it, or undefined.
  async function send(row: Record<string, unknown>): Promise<string | undefined> {
    const input = JSON.stringify(row);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await deps.run(args(), input);
        if (result.ok) {
          recorded += 1;
          changed();
          try {
            const reply = JSON.parse(result.stdout) as { id?: unknown };
            return typeof reply.id === "string" ? reply.id : undefined;
          } catch {
            return undefined;
          }
        }
        lastError = result.stderr.trim().split(/\r?\n/)[0] || `exit code ${result.code ?? "none"}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt === 1)
        await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? DEFAULT_RETRY_MS));
    }
    failed += 1;
    changed();
    return undefined;
  }

  const queue = (work: () => Promise<void>): void => {
    tail = tail.then(work).catch(() => undefined);
  };

  const sessionId = (): string | null => {
    try {
      return identifier(deps.sessionId());
    } catch {
      return null;
    }
  };

  return {
    order(text, mode) {
      if (text.trim() === "") return;
      inputs += 1;
      const session = sessionId();
      const row = {
        kind: "order",
        mode: orderModeOf(mode),
        source: "chat",
        text,
        sessionId: session,
        idempotencyKey: session === null ? null : `${session}:input:${inputs}`,
      };
      queue(async () => {
        currentOrder = (await send(row)) ?? null;
      });
    },
    usage(message, mode) {
      if (message.role !== "assistant") return;
      queue(async () => {
        await send(usageRow(message, mode, sessionId(), currentOrder));
      });
    },
    status: () => ({ recorded, failed, lastError }),
    idle: () => tail,
  };
}
