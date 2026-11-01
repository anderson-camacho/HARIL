import type { ModelDescriptor } from "@haril/contracts";
import { roleVendorWarnings } from "@haril/core";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, EXIT_WARN, type HostInfo } from "../context.js";
import { loadDelegationSettings } from "../delegation-config.js";
import {
  listProviderModels,
  loadProviderConfig,
  MODELS_TIMEOUT_MS,
  namespacedRef,
  type ProviderListing,
} from "../providers.js";

// `haril models [--json] [--provider <id>]` (M3-T7, ACE-06, RF-109): queries every configured provider at once
// and lists the models as <provider>/<model>. Read-only. Exit 0 when every queried provider answered, 1 when some
// were skipped or failed but one answered, 2 when none answered (or on a usage or configuration problem).
const USAGE = "usage: haril models [--json] [--provider <id>]";

export async function models(args: readonly string[], io: CliIo, host: HostInfo): Promise<number> {
  const parsed = parseArgs(args, { values: ["--provider"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const loaded = loadProviderConfig(host);
  if (!loaded.ok) {
    for (const error of loaded.errors) io.err(`haril: ${loaded.path}: ${error}`);
    return EXIT_USAGE;
  }
  const only = lastValue(parsed, "--provider");
  if (only !== undefined && only.trim() === "") {
    io.err("haril: --provider needs a provider id");
    return EXIT_USAGE;
  }
  const selected =
    only === undefined ? loaded.providers : loaded.providers.filter((entry) => entry.id === only);
  if (selected.length === 0) {
    io.err(`haril: no provider with id "${only}"`);
    return EXIT_USAGE;
  }

  const timeoutMs = host.gatewayTimeoutMs ?? MODELS_TIMEOUT_MS;
  const listings = await Promise.all(selected.map((entry) => listProviderModels(entry, timeoutMs)));
  const answered = listings.filter((listing) => listing.status === "ok").length;
  const all = listings.flatMap((listing) => listing.models);
  // A role that only one vendor can serve among what answered: said here, never a reason to refuse anything.
  const delegation = loadDelegationSettings(host);
  const roleWarnings = delegation.ok
    ? roleVendorWarnings(
        delegation.settings.roles,
        all.map((model) => namespacedRef(model.providerId, model.id)),
      )
    : [];

  if (parsed.flags.has("--json")) {
    io.out(
      JSON.stringify({
        config: { source: loaded.source, path: loaded.path },
        providers: listings.map(({ models: list, ...rest }) => ({ ...rest, models: list.length })),
        models: all,
        roleWarnings,
      }),
    );
  } else {
    for (const listing of listings) {
      io.out(`provider ${listing.id}  ${listing.status}  ${listing.detail}`);
    }
    printTable(all, io);
    for (const warning of roleWarnings) {
      io.out(`role ${warning.role}: only ${warning.vendor} among the connected models`);
    }
  }

  if (answered === 0) {
    io.err("haril: no provider answered; see the provider lines and haril doctor");
    return EXIT_USAGE;
  }
  return allAnswered(listings) ? EXIT_OK : EXIT_WARN;
}

function allAnswered(listings: readonly ProviderListing[]): boolean {
  return listings.every((listing) => listing.status === "ok");
}

function printTable(list: readonly ModelDescriptor[], io: CliIo): void {
  const rows = [
    ["id", "context", "max-output"],
    ...list.map((model) => [
      namespacedRef(model.providerId, model.id),
      String(model.contextWindow ?? "-"),
      String(model.maxOutputTokens ?? "-"),
    ]),
  ];
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  for (const row of rows) {
    io.out(
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    );
  }
  if (list.length === 0) io.out("no models reported by the answering providers");
}
