import { useEffect, useMemo } from "react";
import {
  useHydratedWorkspaceEntries,
  useProjectNamesMap,
} from "@/hooks/use-status-mode-workspaces";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useWorkspaceOrganizationStore } from "@/stores/workspace-organization-store";
import {
  buildSidebarShortcutModel,
  buildStatusSidebarShortcutModel,
} from "@/utils/sidebar-shortcuts";

export function WorkspaceShortcutTargetsSubscriber({
  enabled,
  serverId,
}: {
  enabled: boolean;
  serverId: string | null;
}) {
  const { projects } = useSidebarWorkspacesList({ serverId, enabled });
  const statusWorkspaces = useHydratedWorkspaceEntries(enabled ? serverId : null);
  const projectNamesByKey = useProjectNamesMap(enabled ? serverId : null);
  const groupMode = useSidebarViewStore((state) =>
    enabled && serverId ? state.getGroupMode(serverId) : "project",
  );
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );
  const organizationMode = useWorkspaceOrganizationStore((state) => state.mode);

  const shortcutModel = useMemo(() => {
    if (organizationMode === "thread-first") {
      return buildSidebarShortcutModel({
        projects,
        collapsedProjectKeys,
        organizationMode,
      });
    }

    if (groupMode === "status") {
      return buildStatusSidebarShortcutModel({
        workspaces: statusWorkspaces,
        projectNamesByKey,
        collapsedStatusGroupKeys,
      });
    }

    return buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys,
      organizationMode,
    });
  }, [
    collapsedProjectKeys,
    collapsedStatusGroupKeys,
    groupMode,
    organizationMode,
    projectNamesByKey,
    projects,
    statusWorkspaces,
  ]);

  useEffect(() => {
    if (!enabled || !serverId) {
      setSidebarShortcutWorkspaceTargets([]);
      return;
    }

    setSidebarShortcutWorkspaceTargets(shortcutModel.shortcutTargets);
  }, [enabled, serverId, setSidebarShortcutWorkspaceTargets, shortcutModel.shortcutTargets]);

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([]);
    };
  }, [setSidebarShortcutWorkspaceTargets]);

  return null;
}
