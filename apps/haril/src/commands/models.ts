import type { ModelDescriptor } from "@haril/contracts";
import { createOpenAiCompatibleClient, ProviderError } from "@haril/gateway";
import { argsProblem, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import {
  GATEWAY_KEY_ENV,
  GATEWAY_URL_ENV,
  gatewaySettings,
  MODELS_TIMEOUT_MS,
} from "../gateway.js";

// `haril models [--json]` (M2-T1, RF-109): lists the models of the gateway. Read-only; exit 2 on any failure.
const USAGE = "usage: haril models [--json]";

export async function models(args: readonly string[], io: CliIo, host: HostInfo): Promise<number> {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const settings = gatewaySettings(host);
  if (!settings.urlValid) {
    io.err(`haril: ${GATEWAY_URL_ENV} is not a valid URL`);
    return EXIT_USAGE;
  }
  if (settings.apiKey === undefined) {
    io.err(`haril: ${GATEWAY_KEY_ENV} is not set`);
    return EXIT_USAGE;
  }

  const client = createOpenAiCompatibleClient({
    baseUrl: settings.url,
    apiKey: settings.apiKey,
    timeoutMs: host.gatewayTimeoutMs ?? MODELS_TIMEOUT_MS,
  });
  let list: ModelDescriptor[];
  try {
    list = await client.listModels();
  } catch (error) {
    return reportFailure(error, settings.url, io);
  }

  if (parsed.flags.has("--json")) {
    io.out(JSON.stringify({ gateway: settings.url, models: list }));
  } else {
    printTable(list, io);
  }
  return EXIT_OK;
}

function reportFailure(error: unknown, url: string, io: CliIo): number {
  if (error instanceof ProviderError && error.code === "auth") {
    io.err(
      `haril: ${GATEWAY_KEY_ENV} was rejected by the gateway (HTTP ${error.httpStatus ?? 401}); check the key`,
    );
  } else if (error instanceof ProviderError && error.code === "unreachable") {
    io.err(
      `haril: gateway unreachable at ${url}; is CLIProxyAPI running? (docker start cli-proxy-api)`,
    );
  } else if (error instanceof ProviderError) {
    io.err(`haril: ${error.message}`);
  } else {
    io.err("haril: unexpected failure while listing the gateway models");
  }
  return EXIT_USAGE;
}

function printTable(list: readonly ModelDescriptor[], io: CliIo): void {
  const rows = [
    ["id", "context", "max-output"],
    ...list.map((model) => [
      model.id,
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
  if (list.length === 0) io.out("no models reported by the gateway");
}
