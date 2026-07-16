import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { Logger } from "pino";

import type { AgentClient } from "./agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "./provider-launch-config.js";

export interface ProviderWorkspaceGitService {
  resolveRepoRoot(cwd: string): Promise<string>;
}

export interface ProviderManagedProcessRecordInput {
  owner: { provider: string; kind: string };
  pid: number;
  command: string;
  args: string[];
  metadata?: Record<string, unknown>;
}

export interface ProviderManagedProcessRecord extends ProviderManagedProcessRecordInput {
  id: string;
  metadata: Record<string, unknown>;
  identity: { commandLine: string | null; startedAt: string | null };
  createdAt: string;
}

export interface ProviderManagedProcessRegistry {
  record(input: ProviderManagedProcessRecordInput): Promise<ProviderManagedProcessRecord>;
  remove(id: string): Promise<void>;
  list(): Promise<ProviderManagedProcessRecord[]>;
  reapStale(): Promise<{
    checked: number;
    dead: number;
    mismatched: number;
    removed: number;
    terminated: number;
    errors: Array<{ id: string; message: string }>;
  }>;
}

export interface ProviderClientFactoryOptions {
  workspaceGitService?: ProviderWorkspaceGitService;
  managedProcesses?: ProviderManagedProcessRegistry;
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
