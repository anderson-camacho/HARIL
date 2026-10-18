import type { Clock } from "@haril/core/ports";
import {
  type Broker,
  type BrokerLedger,
  createOpenAiCompatibleClient,
  startBroker,
  type UpstreamFailure,
  type UpstreamResolver,
} from "@haril/gateway";
import type { ProviderEntry } from "./providers.js";

// Composition of the Broker (M2-D7, M3-T7): one OpenAI-compatible upstream per configured provider. The Broker
// never imports providers/, and each key reaches its adapter only here, sealed (ADR-0005 BR-14). Pi and the grant
// already carry the bare model id, so the resolver forwards it unchanged: stripping again would break ids such as
// "openai/gpt-4o" on a provider named "openai".

export interface HarilBrokerOptions {
  readonly store: BrokerLedger;
  readonly clock: Clock;
  readonly providers: readonly ProviderEntry[];
  readonly timeoutMs: number;
  // Hears each failed upstream call (3.11): real-agent.ts attaches it to the run's outcome.
  readonly onUpstreamFailure?: (failure: UpstreamFailure) => void;
}

export function startHarilBroker(options: HarilBrokerOptions): Promise<Broker> {
  const clients = new Map(
    options.providers.map((entry) => [
      entry.id,
      {
        providerId: entry.id,
        client: createOpenAiCompatibleClient({
          baseUrl: entry.baseUrl,
          credential: entry.credential,
          timeoutMs: options.timeoutMs,
        }),
      },
    ]),
  );
  const resolveUpstream: UpstreamResolver = (providerId) => {
    const route = clients.get(providerId);
    if (route === undefined)
      throw new Error(`no upstream is configured for provider ${providerId}`);
    return route.client;
  };
  return startBroker({
    resolveUpstream,
    ledger: options.store,
    clock: options.clock,
    host: "127.0.0.1",
    port: 0,
    ...(options.onUpstreamFailure === undefined
      ? {}
      : { onUpstreamFailure: options.onUpstreamFailure }),
  });
}
