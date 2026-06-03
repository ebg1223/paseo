import { useEffect, useMemo } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceOrganizationMode } from "@/stores/workspace-organization-store";
import { buildSidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { isSidebarProjectFlattened } from "@/utils/sidebar-project-row-model";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

export function useSidebarShortcutModel(input: {
  projects: SidebarProjectEntry[];
  isInitialLoad: boolean;
  organizationMode: WorkspaceOrganizationMode;
}) {
  const { projects, isInitialLoad, organizationMode } = input;
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const setProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.setProjectCollapsed,
  );
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );

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
    if (isInitialLoad || projects.length === 0) {
      return;
    }

    const collapsibleProjectKeys = new Set(
      projects
        .filter((project) => !isSidebarProjectFlattened(project, organizationMode))
        .map((project) => project.projectKey),
    );
    for (const key of collapsedProjectKeys) {
      if (!collapsibleProjectKeys.has(key)) {
        setProjectCollapsed(key, false);
      }
    }
  }, [collapsedProjectKeys, isInitialLoad, organizationMode, projects, setProjectCollapsed]);

  return {
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey: shortcutModel.shortcutIndexByWorkspaceKey,
    setProjectCollapsed,
    toggleProjectCollapsed,
  };
}
