import { generateDraftId } from "@/stores/draft-keys";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTabTarget,
} from "@/stores/workspace-tabs-store";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

export interface PrepareWorkspaceTabInput {
  serverId: string;
  workspaceId: string;
  tabScopeKey?: string | null;
  target: WorkspaceTabTarget;
  pin?: boolean;
}

export interface NavigateToPreparedWorkspaceTabInput extends PrepareWorkspaceTabInput {
  currentPathname?: string | null;
}

export interface PrepareWorkspaceTabDeps {
  openTabFocused: (workspaceKey: string, target: WorkspaceTabTarget) => string | null;
  pinAgent: (workspaceKey: string, agentId: string) => void;
}

export interface NavigateToPreparedWorkspaceTabDeps extends PrepareWorkspaceTabDeps {
  navigateToWorkspace: (
    serverId: string,
    workspaceId: string,
    options: { currentPathname?: string | null },
  ) => void;
}

function withWorkspaceContext(target: WorkspaceTabTarget, workspaceId: string): WorkspaceTabTarget {
  if (target.kind === "setup") {
    return target;
  }
  if ("workspaceId" in target && target.workspaceId?.trim()) {
    return target;
  }
  return {
    ...target,
    workspaceId,
  } as WorkspaceTabTarget;
}

function getPreparedTarget(target: WorkspaceTabTarget, workspaceId: string): WorkspaceTabTarget {
  const contextualTarget = withWorkspaceContext(target, workspaceId);
  if (contextualTarget.kind !== "draft" || contextualTarget.draftId.trim() !== "new") {
    return contextualTarget;
  }
  return { ...contextualTarget, draftId: generateDraftId() };
}

export function prepareWorkspaceTab(
  input: PrepareWorkspaceTabInput,
  deps: PrepareWorkspaceTabDeps,
): string {
  const target = getPreparedTarget(input.target, input.workspaceId);
  const key =
    input.tabScopeKey ??
    buildWorkspaceTabPersistenceKey({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    }) ??
    "";

  deps.openTabFocused(key, target);

  if (input.pin && target.kind === "agent") {
    deps.pinAgent(key, target.agentId);
  }

  return buildHostWorkspaceRoute(input.serverId, input.workspaceId);
}

export function navigateToPreparedWorkspaceTab(
  input: NavigateToPreparedWorkspaceTabInput,
  deps: NavigateToPreparedWorkspaceTabDeps,
): string {
  const route = prepareWorkspaceTab(input, deps);
  deps.navigateToWorkspace(input.serverId, input.workspaceId, {
    currentPathname: input.currentPathname,
  });
  return route;
}
