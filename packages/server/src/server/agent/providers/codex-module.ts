import type {
  AgentProviderDefinition,
  AgentProviderModeDefinition,
} from "@getpaseo/protocol/provider-manifest";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import type { ProviderModule } from "../provider-module.js";

const CODEX_MODES: AgentProviderModeDefinition[] = [
  {
    id: "auto",
    label: "Default Permissions",
    description: "Edit files and run commands with Codex's default approval flow.",
    icon: "Shield",
    colorTier: "moderate",
  },
  {
    id: "auto-review",
    label: "Auto-review",
    description:
      "Same workspace-write permissions as Default, but eligible `on-request` approvals are routed through the auto-reviewer subagent.",
    icon: "ShieldCheck",
    colorTier: "moderate",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Edit files, run commands, and access the network without additional prompts.",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
];

const definition: AgentProviderDefinition = {
  id: "codex",
  label: "Codex",
  description: "OpenAI's Codex workspace agent with sandbox controls and optional network access",
  defaultModeId: "auto",
  modes: CODEX_MODES,
  voice: {
    enabled: true,
    defaultModeId: "auto",
    defaultModel: "gpt-5.4-mini",
  },
};

export const codexProviderModule: ProviderModule = {
  definition,
  commandTemplates: { resume: "codex resume {sessionId}" },
  iconName: "codex",
  createClient: (logger, runtimeSettings, options) =>
    new CodexAppServerAgentClient(logger, runtimeSettings, {
      workspaceGitService: options?.workspaceGitService,
      customProvider: options?.customProvider,
    }),
};
