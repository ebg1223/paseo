import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

function normalizeWorkspaceId(value: string | null | undefined): string {
  return normalizeWorkspacePath(value) ?? "";
}

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  knownAgentIds: Set<string>;
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceDirectory: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails, workspaceDirectory } = input;
  const normalizedWorkspaceDirectory = normalizeWorkspaceId(workspaceDirectory);
  if ((!sessionAgents && !agentDetails) || !normalizedWorkspaceDirectory) {
    return {
      activeAgentIds: new Set<string>(),
      knownAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const knownAgentIds = new Set<string>();
  for (const agent of sessionAgents?.values() ?? []) {
    if (normalizeWorkspaceId(agent.cwd) !== normalizedWorkspaceDirectory) {
      continue;
    }
    knownAgentIds.add(agent.id);
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
    }
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (normalizeWorkspaceId(agent.cwd) !== normalizedWorkspaceDirectory) {
      continue;
    }
    knownAgentIds.add(agent.id);
  }

  return { activeAgentIds, knownAgentIds };
}

function buildNormalizedProjectWorkspaceDirectories(
  workspaces: Map<string, WorkspaceDescriptor> | undefined,
  projectKey: string | null,
): Set<string> {
  const directories = new Set<string>();
  if (!workspaces || !projectKey) {
    return directories;
  }
  for (const workspace of workspaces.values()) {
    const workspaceProjectKey = workspace.project?.projectKey ?? workspace.projectId;
    if (workspaceProjectKey !== projectKey) {
      continue;
    }
    const normalizedDirectory = normalizeWorkspaceId(workspace.workspaceDirectory);
    if (normalizedDirectory) {
      directories.add(normalizedDirectory);
    }
  }
  return directories;
}

function agentBelongsToProject(input: {
  agent: Agent;
  projectKey: string | null;
  workspaceDirectories: Set<string>;
}): boolean {
  const normalizedCwd = normalizeWorkspaceId(input.agent.cwd);
  if (!normalizedCwd) {
    return false;
  }
  if (input.projectKey && input.agent.projectPlacement?.projectKey === input.projectKey) {
    return true;
  }
  return input.workspaceDirectories.has(normalizedCwd);
}

export function deriveProjectAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaces: Map<string, WorkspaceDescriptor> | undefined;
  projectKey: string | null | undefined;
  fallbackWorkspaceDirectory: string | null | undefined;
}): WorkspaceAgentVisibility {
  const projectKey = input.projectKey?.trim() || null;
  const workspaceDirectories = buildNormalizedProjectWorkspaceDirectories(
    input.workspaces,
    projectKey,
  );
  const fallbackWorkspaceDirectory = normalizeWorkspaceId(input.fallbackWorkspaceDirectory);
  if (workspaceDirectories.size === 0 && fallbackWorkspaceDirectory) {
    workspaceDirectories.add(fallbackWorkspaceDirectory);
  }
  if ((!input.sessionAgents && !input.agentDetails) || workspaceDirectories.size === 0) {
    return {
      activeAgentIds: new Set<string>(),
      knownAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const knownAgentIds = new Set<string>();
  for (const agent of input.sessionAgents?.values() ?? []) {
    if (!agentBelongsToProject({ agent, projectKey, workspaceDirectories })) {
      continue;
    }
    knownAgentIds.add(agent.id);
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
    }
  }
  for (const agent of input.agentDetails?.values() ?? []) {
    if (!agentBelongsToProject({ agent, projectKey, workspaceDirectories })) {
      continue;
    }
    knownAgentIds.add(agent.id);
  }

  return { activeAgentIds, knownAgentIds };
}

export function buildWorkspaceTabSnapshot(input: {
  workspaceId?: string | null;
  agentVisibility: WorkspaceAgentVisibility;
  autoOpenAgentIds?: Iterable<string>;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    workspaceId: input.workspaceId,
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.autoOpenAgentIds,
    knownAgentIds: input.agentVisibility.knownAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) && setsEqual(a.knownAgentIds, b.knownAgentIds)
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}
