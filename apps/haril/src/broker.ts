import type { Clock } from "@haril/core/ports";
import {
  type Broker,
  type BrokerLedger,
  createOpenAiCompatibleClient,
  startBroker,
} from "@haril/gateway";

// Composition of the Broker (M2-D7): the OpenAI-compatible adapter is the upstream. The Broker itself never
// imports providers/, and the key reaches the adapter only here (ADR-0005 BR-14). Not wired into `start` yet (M2-T6).

interface GatewayUpstream {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
}

export interface HarilBrokerOptions {
  readonly store: BrokerLedger;
  readonly clock: Clock;
  readonly gateway: GatewayUpstream;
}

export function startHarilBroker(options: HarilBrokerOptions): Promise<Broker> {
  const upstream = createOpenAiCompatibleClient({
    baseUrl: options.gateway.baseUrl,
    apiKey: options.gateway.apiKey,
    timeoutMs: options.gateway.timeoutMs,
  });
  return startBroker({
    upstream,
    ledger: options.store,
    clock: options.clock,
    host: "127.0.0.1",
    port: 0,
  });
}
