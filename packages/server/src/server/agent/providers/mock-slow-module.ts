import type {
  AgentProviderDefinition,
  AgentProviderModeDefinition,
} from "@getpaseo/protocol/provider-manifest";
import { MockSlowProviderClient } from "./mock-slow-provider.js";
import type { ProviderModule } from "../provider-module.js";

const MOCK_SLOW_MODES: AgentProviderModeDefinition[] = [
  {
    id: "default",
    label: "Default",
    description: "Dev-only mode for the mock slow provider",
    icon: "ShieldOff",
    colorTier: "dangerous",
  },
];

const definition: AgentProviderDefinition = {
  id: "mock-slow",
  label: "Mock Slow Provider",
  description: "Dev-only: hangs during model discovery to test loading and timeout UI",
  defaultModeId: "default",
  modes: MOCK_SLOW_MODES,
};

export const mockSlowProviderModule: ProviderModule = {
  definition,
  devOnly: true,
  createClient: () => new MockSlowProviderClient(),
};
