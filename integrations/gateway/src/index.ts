// Public surface of @haril/gateway: the OpenAI-compatible model provider adapter (M2).

export { ProviderError, type ProviderErrorCode } from "./providers/errors.js";
export {
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  createOpenAiCompatibleClient,
  type OpenAiCompatibleClient,
  type OpenAiCompatibleOptions,
} from "./providers/openai-compatible.js";
