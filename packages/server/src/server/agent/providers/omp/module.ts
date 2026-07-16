import type {
  AgentProviderDefinition,
  AgentProviderModeDefinition,
} from "@getpaseo/protocol/provider-manifest";
import { OmpRpcAgentClient } from "./agent.js";
import type { ProviderModule } from "../../provider-module.js";

export const OMP_MODES: AgentProviderModeDefinition[] = [
  {
    id: "full",
    label: "Full Access",
    description: "Launches OMP with yolo approval mode so tools run without prompts.",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
  {
    id: "ask",
    label: "Always Ask",
    description: "Launches OMP with always-ask approval mode for write and exec tools.",
    icon: "ShieldCheck",
    colorTier: "safe",
  },
];

const definition: AgentProviderDefinition = {
  id: "omp",
  label: "Oh My Pi",
  description: "Multi-provider coding agent with native approvals, host tools, and subagents",
  enabledByDefault: false,
  defaultModeId: "full",
  modes: OMP_MODES,
};

export const ompProviderModule: ProviderModule = {
  definition,
  commandTemplates: { resume: "omp --session {sessionId}" },
  iconName: "omp",
  createClient: (logger, runtimeSettings, options) =>
    new OmpRpcAgentClient({
      logger,
      runtimeSettings,
      providerParams: options?.providerParams,
    }),
};
