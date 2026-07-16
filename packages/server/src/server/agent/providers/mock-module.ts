import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import { MOCK_LOAD_TEST_MODES, MockLoadTestAgentClient } from "./mock-load-test-agent.js";
import type { ProviderModule } from "../provider-module.js";

const definition: AgentProviderDefinition = {
  id: "mock",
  label: "Mock Load Test",
  description: "Development-only provider that emits synthetic agent traffic for performance tests",
  defaultModeId: "load-test",
  modes: MOCK_LOAD_TEST_MODES,
};

export const mockProviderModule: ProviderModule = {
  definition,
  devOnly: true,
  createClient: (logger) => new MockLoadTestAgentClient(logger),
};
