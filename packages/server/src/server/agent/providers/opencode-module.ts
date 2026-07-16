import type {
  AgentProviderDefinition,
  AgentProviderModeDefinition,
} from "@getpaseo/protocol/provider-manifest";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import type { ProviderModule } from "../provider-module.js";

const OPENCODE_MODES: AgentProviderModeDefinition[] = [
  {
    id: "build",
    label: "Build",
    description: "Allows edits and tool execution for implementation work",
    icon: "Shield",
    colorTier: "moderate",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode that avoids file edits",
    icon: "ShieldEllipsis",
    colorTier: "planning",
  },
];

const definition: AgentProviderDefinition = {
  id: "opencode",
  label: "OpenCode",
  description: "Open-source coding assistant with multi-provider model support",
  // No static default: OpenCode users can rename or delete any agent,
  // including "build". Leaving this unset means the daemon and OpenCode
  // itself decide (see normalizeOpenCodeModeId in opencode-agent.ts).
  defaultModeId: null,
  modes: OPENCODE_MODES,
  voice: {
    enabled: true,
    defaultModeId: "build",
  },
};

export const opencodeProviderModule: ProviderModule = {
  definition,
  commandTemplates: { resume: "opencode --session {sessionId}" },
  iconName: "opencode",
  createClient: (logger, runtimeSettings, options) =>
    new OpenCodeAgentClient(logger, runtimeSettings, {
      managedProcesses: options?.managedProcesses,
    }),
};
