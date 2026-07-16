import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { Logger } from "pino";

import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { AgentClient } from "./agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "./provider-launch-config.js";

export interface ProviderClientFactoryOptions {
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  managedProcesses?: ManagedProcessRegistry;
  providerParams?: unknown;
  customProvider?: {
    id: string;
    label: string;
    extends: string;
  };
}

export type ProviderClientFactory = (
  logger: Logger,
  runtimeSettings?: ProviderRuntimeSettings,
  options?: ProviderClientFactoryOptions,
) => AgentClient;

export interface ProviderModule {
  definition: AgentProviderDefinition;
  devOnly?: boolean;
  iconName?: string;
  commandTemplates?: {
    resume?: string;
  };
  sdkVersion?: string;
  createClient: ProviderClientFactory;
}
