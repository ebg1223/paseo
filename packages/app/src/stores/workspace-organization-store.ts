import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type WorkspaceOrganizationMode = "workspace-first" | "thread-first";

export interface WorkspaceOrganizationPolicy {
  sidebarMode: "workspaces" | "threads";
  tabScope: "workspace" | "project";
  agentVisibilityScope: "workspace" | "project";
  agentTabClose: "archive-root" | "layout-only";
  agentTabPopulation: "auto-active" | "manual-open";
  sidebarShortcutScope: "workspaces" | "none";
}

export const DEFAULT_WORKSPACE_ORGANIZATION_MODE: WorkspaceOrganizationMode = "workspace-first";

export const WORKSPACE_ORGANIZATION_MODE_OPTIONS: Array<{
  value: WorkspaceOrganizationMode;
  label: string;
}> = [
  { value: "workspace-first", label: "Workspaces" },
  { value: "thread-first", label: "Threads" },
];

const WORKSPACE_FIRST_POLICY: WorkspaceOrganizationPolicy = {
  sidebarMode: "workspaces",
  tabScope: "workspace",
  agentVisibilityScope: "workspace",
  agentTabClose: "archive-root",
  agentTabPopulation: "auto-active",
  sidebarShortcutScope: "workspaces",
};

const THREAD_FIRST_POLICY: WorkspaceOrganizationPolicy = {
  sidebarMode: "threads",
  tabScope: "project",
  agentVisibilityScope: "project",
  agentTabClose: "layout-only",
  agentTabPopulation: "manual-open",
  sidebarShortcutScope: "none",
};

interface WorkspaceOrganizationStoreState {
  mode: WorkspaceOrganizationMode;
  setMode: (mode: WorkspaceOrganizationMode) => void;
}

function normalizeWorkspaceOrganizationMode(value: unknown): WorkspaceOrganizationMode {
  return value === "thread-first" ? "thread-first" : DEFAULT_WORKSPACE_ORGANIZATION_MODE;
}

export function getWorkspaceOrganizationPolicy(
  mode: WorkspaceOrganizationMode,
): WorkspaceOrganizationPolicy {
  return mode === "thread-first" ? THREAD_FIRST_POLICY : WORKSPACE_FIRST_POLICY;
}

export const useWorkspaceOrganizationStore = create<WorkspaceOrganizationStoreState>()(
  persist(
    (set) => ({
      mode: DEFAULT_WORKSPACE_ORGANIZATION_MODE,
      setMode: (mode) => {
        set({ mode: normalizeWorkspaceOrganizationMode(mode) });
      },
    }),
    {
      name: "workspace-organization-mode",
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        mode: state.mode,
      }),
      merge: (persistedState, currentState) => {
        const persisted =
          persistedState && typeof persistedState === "object"
            ? (persistedState as { mode?: unknown })
            : null;
        return {
          ...currentState,
          mode: normalizeWorkspaceOrganizationMode(persisted?.mode),
        };
      },
    },
  ),
);
