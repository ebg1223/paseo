import type {
  AgentProviderDefinition,
  AgentProviderModeDefinition,
} from "@getpaseo/protocol/provider-manifest";
import { CopilotACPAgentClient } from "./copilot-acp-agent.js";
import type { ProviderModule } from "../provider-module.js";

const COPILOT_MODES: AgentProviderModeDefinition[] = [
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#agent",
    label: "Agent",
    description: "Default agent mode for conversational interactions",
    icon: "Shield",
    colorTier: "moderate",
  },
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#plan",
    label: "Plan",
    description: "Plan mode for creating and executing multi-step plans",
    icon: "ShieldEllipsis",
    colorTier: "planning",
  },
  {
    id: "allow-all",
    label: "Allow All",
    description: "Automatically approves all Copilot tool, path, and URL requests.",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
];

const definition: AgentProviderDefinition = {
  id: "copilot",
  label: "Copilot",
  description: "GitHub Copilot via Agent Client Protocol with dynamic modes and session support",
  defaultModeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
  modes: COPILOT_MODES,
};

export const copilotProviderModule: ProviderModule = {
  definition,
  iconName: "copilot",
  createClient: (logger, runtimeSettings) =>
    new CopilotACPAgentClient({
      logger,
      runtimeSettings,
    }),
};
