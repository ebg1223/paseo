import type {
  AgentProviderDefinition,
  AgentProviderModeDefinition,
} from "@getpaseo/protocol/provider-manifest";
import { ClaudeAgentClient } from "./agent.js";
import type { ProviderModule } from "../../provider-module.js";

const CLAUDE_MODES: AgentProviderModeDefinition[] = [
  {
    id: "plan",
    label: "Plan Mode",
    description: "Analyze the codebase without executing tools or edits",
    icon: "ShieldEllipsis",
    colorTier: "planning",
  },
  {
    id: "default",
    label: "Always Ask",
    description: "Prompts for permission the first time a tool is used",
    icon: "Shield",
    colorTier: "safe",
  },
  {
    id: "acceptEdits",
    label: "Accept File Edits",
    description: "Automatically approves edit-focused tools without prompting",
    icon: "ShieldPlus",
    colorTier: "moderate",
  },
  {
    id: "auto",
    label: "Auto mode",
    description: "Uses a model classifier to review permission prompts automatically",
    icon: "ShieldCheck",
    colorTier: "moderate",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    description: "Skip all permission prompts (use with caution)",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
];

const definition: AgentProviderDefinition = {
  id: "claude",
  label: "Claude",
  description: "Anthropic's multi-tool assistant with MCP support, streaming, and deep reasoning",
  defaultModeId: "default",
  modes: CLAUDE_MODES,
  voice: {
    enabled: true,
    defaultModeId: "default",
    defaultModel: "haiku",
  },
};

export const claudeProviderModule: ProviderModule = {
  definition,
  commandTemplates: { resume: "claude --resume {sessionId}" },
  iconName: "claude",
  createClient: (logger, runtimeSettings) =>
    new ClaudeAgentClient({
      logger,
      runtimeSettings,
    }),
};
