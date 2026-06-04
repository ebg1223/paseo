import type { PrHint } from "@/git/use-pr-status-query";
import {
  canCreateWorktreeForProjectKind,
  type HostProjectListItem,
} from "@/projects/host-project-model";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProjectPlacementPayload } from "@getpaseo/protocol/messages";

const EMPTY_PROJECTS: SidebarProjectEntry[] = [];

export type SidebarStateBucket = WorkspaceDescriptor["status"];

export interface SidebarAgentProjectionSource {
  id: string;
  serverId: string;
  title: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  cwd: string;
  provider: AgentProvider;
  lastActivityAt: Date;
  pendingPermissionCount: number;
  requiresAttention?: boolean;
  archivedAt?: Date | null;
  projectPlacement?: ProjectPlacementPayload | null;
}

export interface SidebarAgentWorkspaceSource {
  id: string;
  projectId: string;
  projectRootPath: string;
  workspaceDirectory: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  gitRuntime?: { currentBranch?: string | null } | null;
  project?: ProjectPlacementPayload;
}

export interface SidebarAgentEntry {
  rowKey: string;
  serverId: string;
  agentId: string;
  projectKey: string;
  workspaceId: string | null;
  workspaceDirectory: string | null;
  workspaceName: string | null;
  workspaceKind: WorkspaceDescriptor["workspaceKind"] | null;
  title: string;
  statusBucket: SidebarStateBucket;
  provider: AgentProvider;
  branchName: string | null;
  lastActivityAt: Date;
  pendingPermissionCount: number;
  requiresAttention: boolean;
}

export interface SidebarWorkspaceEntry {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  projectKey: string;
  projectRootPath?: string;
  workspaceDirectory?: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  branchName: string | null;
  statusBucket: SidebarStateBucket;
  statusEnteredAt: Date | null;
  archivingAt: string | null;
  diffStat: { additions: number; deletions: number } | null;
  prHint: PrHint | null;
  archiveHasUncommittedChanges: boolean | null;
  archiveUnpushedCommitCount: number | null;
  scripts: WorkspaceDescriptor["scripts"];
  hasRunningScripts: boolean;
}

export interface SidebarProjectEntry {
  projectKey: string;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  canCreateWorktree: boolean;
  workspaces: SidebarWorkspaceEntry[];
  agents: SidebarAgentEntry[];
}

export function normalizeSidebarBranchName(branchName: string | null | undefined): string | null {
  const value = branchName?.trim();
  if (!value || value === "HEAD") {
    return null;
  }
  return value;
}

function createStructuralWorkspaceEntry(input: {
  serverId: string;
  project: HostProjectListItem;
  workspaceId: string;
}): SidebarWorkspaceEntry {
  const details = input.project.workspaceDetailsById?.[input.workspaceId];

  return {
    workspaceKey: `${input.serverId}:${input.workspaceId}`,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    projectKey: input.project.projectKey,
    projectRootPath: input.project.iconWorkingDir,
    workspaceDirectory: details?.workspaceDirectory,
    projectKind: input.project.projectKind,
    workspaceKind: details?.workspaceKind ?? "checkout",
    name: details?.workspaceName?.trim() || input.workspaceId,
    branchName: normalizeSidebarBranchName(details?.currentBranch),
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

export function buildSidebarProjectsFromStructure(input: {
  serverId: string;
  projects: WorkspaceStructureProject[];
}): SidebarProjectEntry[] {
  return buildSidebarProjectsFromHostProjects({
    projects: input.projects.map((project) => ({
      serverId: input.serverId,
      projectKey: project.projectKey,
      projectName: project.projectName,
      projectKind: project.projectKind,
      iconWorkingDir: project.iconWorkingDir,
      workspaceKeys: project.workspaceKeys,
      workspaceDetailsById: project.workspaceDetailsById,
      canCreateWorktree: canCreateWorktreeForProjectKind(project.projectKind),
    })),
  });
}

export function buildSidebarProjectsFromHostProjects(input: {
  projects: readonly HostProjectListItem[];
}): SidebarProjectEntry[] {
  if (input.projects.length === 0) {
    return EMPTY_PROJECTS;
  }

  return input.projects.map((project) => ({
    projectKey: project.projectKey,
    projectName: project.projectName,
    projectKind: project.projectKind,
    iconWorkingDir: project.iconWorkingDir,
    canCreateWorktree: project.canCreateWorktree,
    workspaces: project.workspaceKeys.map((workspaceId) =>
      createStructuralWorkspaceEntry({
        serverId: project.serverId,
        project,
        workspaceId,
      }),
    ),
    agents: [],
  }));
}

function resolveAgentStatusBucket(agent: SidebarAgentProjectionSource): SidebarStateBucket {
  if (agent.pendingPermissionCount > 0) {
    return "needs_input";
  }
  if (agent.status === "error") {
    return "failed";
  }
  if (agent.status === "running") {
    return "running";
  }
  if (agent.requiresAttention) {
    return "attention";
  }
  return "done";
}

function compareSidebarAgents(left: SidebarAgentEntry, right: SidebarAgentEntry): number {
  const leftRunning = left.statusBucket === "running" ? 1 : 0;
  const rightRunning = right.statusBucket === "running" ? 1 : 0;
  if (leftRunning !== rightRunning) {
    return rightRunning - leftRunning;
  }

  const leftAttention =
    left.statusBucket === "needs_input" || left.statusBucket === "attention" ? 1 : 0;
  const rightAttention =
    right.statusBucket === "needs_input" || right.statusBucket === "attention" ? 1 : 0;
  if (leftAttention !== rightAttention) {
    return rightAttention - leftAttention;
  }

  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function findWorkspaceForAgent(input: {
  agent: SidebarAgentProjectionSource;
  workspaces: SidebarAgentWorkspaceSource[];
}): SidebarAgentWorkspaceSource | null {
  const normalizedCwd = normalizeWorkspacePath(input.agent.cwd);
  if (!normalizedCwd) {
    return null;
  }

  return (
    input.workspaces.find(
      (workspace) => normalizeWorkspacePath(workspace.workspaceDirectory) === normalizedCwd,
    ) ?? null
  );
}

function projectKindFromPlacement(
  placement: ProjectPlacementPayload | null | undefined,
): WorkspaceDescriptor["projectKind"] {
  return placement?.checkout.isGit ? "git" : "directory";
}

function createSidebarAgentEntry(input: {
  agent: SidebarAgentProjectionSource;
  workspace: SidebarAgentWorkspaceSource | null;
  projectKey: string;
}): SidebarAgentEntry {
  const { agent, workspace, projectKey } = input;
  const branchName =
    normalizeSidebarBranchName(workspace?.gitRuntime?.currentBranch) ??
    normalizeSidebarBranchName(agent.projectPlacement?.checkout.currentBranch);
  const workspaceName = workspace?.name?.trim() || null;

  return {
    rowKey: `${agent.serverId}:agent:${agent.id}`,
    serverId: agent.serverId,
    agentId: agent.id,
    projectKey,
    workspaceId: workspace?.id ?? null,
    workspaceDirectory: workspace?.workspaceDirectory ?? normalizeWorkspacePath(agent.cwd),
    workspaceName,
    workspaceKind: workspace?.workspaceKind ?? null,
    title: agent.title?.trim() || "New agent",
    statusBucket: resolveAgentStatusBucket(agent),
    provider: agent.provider,
    branchName,
    lastActivityAt: agent.lastActivityAt,
    pendingPermissionCount: agent.pendingPermissionCount,
    requiresAttention: agent.requiresAttention ?? false,
  };
}

export function buildSidebarProjectsWithAgents(input: {
  projects: SidebarProjectEntry[];
  agents: SidebarAgentProjectionSource[];
  workspaces: SidebarAgentWorkspaceSource[];
}): SidebarProjectEntry[] {
  const activeAgents = input.agents.filter((agent) => !agent.archivedAt);
  if (activeAgents.length === 0) {
    return input.projects;
  }

  const projectsByKey = new Map<string, SidebarProjectEntry>();
  const orderedProjects: SidebarProjectEntry[] = input.projects.map((project) => {
    const nextProject: SidebarProjectEntry = { ...project, agents: [] };
    projectsByKey.set(nextProject.projectKey, nextProject);
    return nextProject;
  });

  for (const agent of activeAgents) {
    const workspace = findWorkspaceForAgent({ agent, workspaces: input.workspaces });
    const projectKey =
      workspace?.project?.projectKey ??
      workspace?.projectId ??
      agent.projectPlacement?.projectKey ??
      agent.cwd;
    let project = projectsByKey.get(projectKey);

    if (!project) {
      project = {
        projectKey,
        projectName: agent.projectPlacement?.projectName ?? projectKey,
        projectKind: workspace?.projectKind ?? projectKindFromPlacement(agent.projectPlacement),
        iconWorkingDir: workspace?.projectRootPath ?? agent.cwd,
        canCreateWorktree: canCreateWorktreeForProjectKind(
          workspace?.projectKind ?? projectKindFromPlacement(agent.projectPlacement),
        ),
        workspaces: [],
        agents: [],
      };
      projectsByKey.set(projectKey, project);
      orderedProjects.push(project);
    }

    project.agents.push(createSidebarAgentEntry({ agent, workspace, projectKey }));
  }

  for (const project of orderedProjects) {
    project.agents.sort(compareSidebarAgents);
  }

  return orderedProjects;
}

export function applyStoredOrdering<T>(input: {
  items: T[];
  storedOrder: string[];
  getKey: (item: T) => string;
}): T[] {
  if (input.items.length <= 1 || input.storedOrder.length === 0) {
    return input.items;
  }

  const itemByKey = new Map<string, T>();
  for (const item of input.items) {
    itemByKey.set(input.getKey(item), item);
  }

  const prunedOrder: string[] = [];
  const seen = new Set<string>();
  for (const key of input.storedOrder) {
    if (!itemByKey.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    prunedOrder.push(key);
  }

  if (prunedOrder.length === 0) {
    return input.items;
  }

  const orderedSet = new Set(prunedOrder);
  const ordered: T[] = [];
  let orderedIndex = 0;

  for (const item of input.items) {
    const key = input.getKey(item);
    if (!orderedSet.has(key)) {
      ordered.push(item);
      continue;
    }

    const targetKey = prunedOrder[orderedIndex] ?? key;
    orderedIndex += 1;
    ordered.push(itemByKey.get(targetKey) ?? item);
  }

  return ordered;
}

export function appendMissingOrderKeys(input: {
  currentOrder: string[];
  visibleKeys: string[];
}): string[] {
  if (input.visibleKeys.length === 0) {
    return input.currentOrder;
  }

  const existingKeys = new Set(input.currentOrder);
  const missingKeys = input.visibleKeys.filter((key) => !existingKeys.has(key));
  if (missingKeys.length === 0) {
    return input.currentOrder;
  }

  return [...input.currentOrder, ...missingKeys];
}

export interface SidebarOrderUpdates {
  projectOrder: string[] | null;
  workspaceOrders: Array<{ projectKey: string; order: string[] }>;
}

export function computeSidebarOrderUpdates(input: {
  projects: SidebarProjectEntry[];
  persistedProjectOrder: string[];
  getWorkspaceOrder: (projectKey: string) => string[];
}): SidebarOrderUpdates {
  if (input.projects.length === 0) {
    return { projectOrder: null, workspaceOrders: [] };
  }

  const nextProjectOrder = appendMissingOrderKeys({
    currentOrder: input.persistedProjectOrder,
    visibleKeys: input.projects.map((project) => project.projectKey),
  });
  const projectOrder = nextProjectOrder === input.persistedProjectOrder ? null : nextProjectOrder;

  const workspaceOrders: Array<{ projectKey: string; order: string[] }> = [];
  for (const project of input.projects) {
    const persistedWorkspaceOrder = input.getWorkspaceOrder(project.projectKey);
    const nextWorkspaceOrder = appendMissingOrderKeys({
      currentOrder: persistedWorkspaceOrder,
      visibleKeys: project.workspaces.map((workspace) => workspace.workspaceKey),
    });
    if (nextWorkspaceOrder !== persistedWorkspaceOrder) {
      workspaceOrders.push({ projectKey: project.projectKey, order: nextWorkspaceOrder });
    }
  }

  return { projectOrder, workspaceOrders };
}

export interface SidebarLoadingState {
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
}

export function deriveSidebarLoadingState(input: {
  isActive: boolean;
  serverId: string | null;
  hasHydratedWorkspaces: boolean;
  hasProjects: boolean;
}): SidebarLoadingState {
  const isLoading = input.isActive && Boolean(input.serverId) && !input.hasHydratedWorkspaces;
  const isInitialLoad = isLoading && !input.hasProjects;
  return { isLoading, isInitialLoad, isRevalidating: false };
}
