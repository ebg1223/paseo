import { useEffect, useMemo } from "react";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useWorkspaceOrganizationStore } from "@/stores/workspace-organization-store";
import { buildSidebarShortcutModel } from "@/utils/sidebar-shortcuts";

export function WorkspaceShortcutTargetsSubscriber({
  enabled,
  serverId,
}: {
  enabled: boolean;
  serverId: string | null;
}) {
  const { projects } = useSidebarWorkspacesList({ serverId, enabled });
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );
  const organizationMode = useWorkspaceOrganizationStore((state) => state.mode);

  const shortcutModel = useMemo(
    () =>
      buildSidebarShortcutModel({
        projects,
        collapsedProjectKeys,
        organizationMode,
      }),
    [collapsedProjectKeys, organizationMode, projects],
  );

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
