// Test double of an OpenAI-compatible server, exported as @haril/gateway/testing. Reused by the Broker
// and Pi end-to-end tests; it is not part of the production surface.
export {
  type FakeCompletion,
  type FakeModel,
  type FakeOpenAiOptions,
  type FakeOpenAiServer,
  type FakeToolCall,
  type FakeUsage,
  type RecordedRequest,
  startFakeOpenAiServer,
} from "./fake-openai-server.js";
