import type { QuotaPolicy } from "@haril/core";
import type { ModelCooldownRecord, QuotaSampleRecord, QuotaSnapshot } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { loadDelegationSettings } from "../delegation-config.js";
import { clockFor } from "../host.js";
import { loadProviderConfig } from "../providers.js";
import { readProviderQuota } from "../quota-source.js";
import { accountViews, type QuotaAccountView, type QuotaWindowView } from "../quota-view.js";
import { dataDirFor, openExisting } from "./common.js";

// `haril quota [--json] [--provider <id>]` (docs/modos-y-delegacion.md 6, 3.11; phase F6): per provider and account, the
// used share of the 5-hour and weekly windows, when each starts over, what the 80/80/20 rule says about the account, and
// the model cooldowns that 402 and 429 answers started. "sin dato" wherever nothing is known: a provider without a quota
// source, a management key that is not set, a server that does not answer, a window an account does not report. The
// reading is recorded in the store (quota_samples) when one exists, so the runtime and the views use it. Exit 0 even
// with no data; 2 for a usage or configuration problem. No key is ever printed.

const USAGE = "usage: haril quota [--json] [--provider <id>] [--data-dir <path>]";

function fail(io: CliIo, message: string): number {
  io.err(`haril: ${message}`);
  return EXIT_USAGE;
}

function localTime(ms: number | null): string {
  if (ms === null) return "n/a";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function windowText(name: string, window: QuotaWindowView): string {
  if (window.usedPct === null) return `${name} sin dato`.padEnd(34);
  const pct = `${Math.round(window.usedPct * 10) / 10}%`;
  return `${name} ${pct.padEnd(6)} resets ${localTime(window.resetsAt)}`.padEnd(34);
}

// The rows a snapshot becomes in the store, for the views of this one reading.
function recordsOf(providerId: string, snapshot: QuotaSnapshot): QuotaSampleRecord[] {
  if (!snapshot.ok) return [];
  return snapshot.accounts.flatMap((account) =>
    (["5h", "7d"] as const).map((window) => {
      const reading = account.windows.find((item) => item.name === window);
      return {
        provider: providerId,
        batchId: "",
        credentialRef: account.credentialRef,
        kind: account.kind,
        prefix: account.prefix,
        window,
        usedPct: reading?.usedPct ?? null,
        resetsAt: reading?.resetsAt ?? null,
        sampledAt: snapshot.sampledAt,
        source: snapshot.source,
        note: account.note,
      };
    }),
  );
}

interface ProviderReport {
  readonly id: string;
  readonly status: "ok" | "sin dato";
  readonly reason: string | null;
  readonly source: string | null;
  readonly sampledAt: number;
  readonly accounts: readonly QuotaAccountView[];
}

export async function quota(args: readonly string[], io: CliIo, host: HostInfo): Promise<number> {
  const parsed = parseArgs(args, { values: ["--provider", "--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) return fail(io, USAGE);
  const loaded = loadProviderConfig(host);
  if (!loaded.ok) {
    for (const error of loaded.errors) io.err(`haril: ${loaded.path}: ${error}`);
    return EXIT_USAGE;
  }
  const delegation = loadDelegationSettings(host);
  if (!delegation.ok) {
    for (const error of delegation.errors) io.err(`haril: ${delegation.path}: ${error}`);
    return EXIT_USAGE;
  }
  const only = lastValue(parsed, "--provider");
  const providers =
    only === undefined ? loaded.providers : loaded.providers.filter((entry) => entry.id === only);
  if (providers.length === 0) return fail(io, `no provider with id "${only}"`);

  const settings = delegation.settings;
  const policy: QuotaPolicy = {
    switchAtPercent5h: settings.quota.switchAtPercent5h,
    stopAtPercentWeekly: settings.quota.stopAtPercentWeekly,
    minRemainingPercentForLargeTask: settings.quota.minRemainingPercentForLargeTask,
    maxWaitMs: settings.quota.maxWaitMs,
  };
  const clock = clockFor(host);
  const readings = await readProviderQuota(host, providers, settings, () => clock.now());

  // The reading goes to the store when there is one; the views and the runtime read it there.
  const store = openExisting(host, dataDirFor(host, lastValue(parsed, "--data-dir")));
  let cooldowns: readonly ModelCooldownRecord[] = [];
  const reports: ProviderReport[] = [];
  try {
    for (const { providerId, snapshot, source } of readings) {
      // The source's reading is kept, its "sin dato" too; a provider with no quota source has nothing to keep.
      if (source) store?.quota.recordSnapshot(providerId, snapshot);
      reports.push({
        id: providerId,
        status: snapshot.ok ? "ok" : "sin dato",
        reason: snapshot.ok ? null : `${snapshot.reason}: ${snapshot.detail}`,
        source: snapshot.ok ? snapshot.source : null,
        sampledAt: snapshot.sampledAt,
        accounts: accountViews(recordsOf(providerId, snapshot), policy),
      });
    }
    cooldowns = store?.quota.cooldowns(clock.now()) ?? [];
  } finally {
    store?.close();
  }

  if (parsed.flags.has("--json")) {
    io.out(
      JSON.stringify({
        config: { path: delegation.path, managementKeyEnv: settings.quota.managementKeyEnv },
        policy,
        providers: reports.map((report) => ({
          ...report,
          accounts: report.accounts.map(({ provider: _provider, ...account }) => account),
        })),
        cooldowns,
      }),
    );
    return EXIT_OK;
  }
  for (const report of reports) {
    if (report.status === "sin dato") {
      io.out(`provider ${report.id}  sin dato (${report.reason})`);
      continue;
    }
    io.out(`provider ${report.id}  ok  ${report.source}  read ${localTime(report.sampledAt)}`);
    const width = Math.max(8, ...report.accounts.map((account) => account.label.length));
    if (report.accounts.length === 0) io.out("  no account listed");
    for (const account of report.accounts) {
      io.out(
        `  ${account.label.padEnd(width)}  ${windowText("5h", account.window5h)}  ${windowText("week", account.weekly)}  ${account.note}`.trimEnd(),
      );
    }
  }
  if (cooldowns.length === 0) {
    io.out("cooldowns  none");
  } else {
    io.out("cooldowns");
    for (const row of cooldowns) {
      io.out(`  ${row.model}  until ${localTime(row.until)}  ${row.reason}`);
    }
  }
  return EXIT_OK;
}
