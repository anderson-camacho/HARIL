// Public surface of @haril/gateway: the OpenAI-compatible model provider adapter and the local Broker (M2).

export { startBroker } from "./broker/broker.js";
export type {
  Broker,
  BrokerLedger,
  BrokerOptions,
  IssueKeyInput,
  UpstreamBody,
  UpstreamChunk,
  UpstreamClient,
  UpstreamResolver,
} from "./broker/types.js";

export { ProviderError, type ProviderErrorCode } from "./providers/errors.js";
export {
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  createOpenAiCompatibleClient,
  type OpenAiCompatibleClient,
  type OpenAiCompatibleOptions,
} from "./providers/openai-compatible.js";
