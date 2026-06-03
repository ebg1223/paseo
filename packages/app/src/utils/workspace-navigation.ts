import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  getWorkspaceOrganizationPolicy,
  useWorkspaceOrganizationStore,
} from "@/stores/workspace-organization-store";
import {
  buildWorkspaceProjectTabScopeKey,
  buildWorkspaceTabPersistenceKey,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-execution";
import {
  prepareWorkspaceTab as prepareWorkspaceTabPure,
  navigateToPreparedWorkspaceTab as navigateToPreparedWorkspaceTabPure,
  type PrepareWorkspaceTabInput,
  type NavigateToPreparedWorkspaceTabInput,
} from "./prepare-workspace-tab";

export type {
  PrepareWorkspaceTabInput,
  NavigateToPreparedWorkspaceTabInput,
} from "./prepare-workspace-tab";

function layoutStoreDeps() {
  const store = useWorkspaceLayoutStore.getState();
  return {
    openTabFocused: store.openTabFocused,
    pinAgent: store.pinAgent,
  };
}

function resolvePreparedTabScopeKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const policy = getWorkspaceOrganizationPolicy(useWorkspaceOrganizationStore.getState().mode);
  if (policy.tabScope !== "project") {
    return buildWorkspaceTabPersistenceKey({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    });
  }

  const session = useSessionStore.getState().sessions[input.serverId];
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces: session?.workspaces,
    workspaceId: input.workspaceId,
  });
  const workspace = workspaceKey ? (session?.workspaces.get(workspaceKey) ?? null) : null;
  const projectKey = workspace?.project?.projectKey ?? workspace?.projectId ?? null;
  return (
    buildWorkspaceProjectTabScopeKey({
      serverId: input.serverId,
      projectKey,
    }) ??
    buildWorkspaceTabPersistenceKey({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    })
  );
}

export function prepareWorkspaceTab(input: PrepareWorkspaceTabInput): string {
  return prepareWorkspaceTabPure(
    {
      ...input,
      tabScopeKey: input.tabScopeKey ?? resolvePreparedTabScopeKey(input),
    },
    layoutStoreDeps(),
  );
}

export function navigateToPreparedWorkspaceTab(input: NavigateToPreparedWorkspaceTabInput): string {
  return navigateToPreparedWorkspaceTabPure(
    {
      ...input,
      tabScopeKey: input.tabScopeKey ?? resolvePreparedTabScopeKey(input),
    },
    {
      ...layoutStoreDeps(),
      navigateToWorkspace,
    },
  );
}
