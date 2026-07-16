import type {
  AgentProviderDefinition,
  AgentProviderModeDefinition,
} from "@getpaseo/protocol/provider-manifest";
import { PiRpcAgentClient } from "./agent.js";
import type { ProviderModule } from "../../provider-module.js";

const PI_MODES: AgentProviderModeDefinition[] = [];

const definition: AgentProviderDefinition = {
  id: "pi",
  label: "Pi",
  description: "Minimal terminal-based coding agent with multi-provider LLM support",
  defaultModeId: null,
  modes: PI_MODES,
};

export const piProviderModule: ProviderModule = {
  definition,
  commandTemplates: { resume: "pi --session {sessionId}" },
  iconName: "pi",
  createClient: (logger, runtimeSettings, options) =>
    new PiRpcAgentClient({
      logger,
      runtimeSettings,
      providerParams: options?.providerParams,
    }),
};
