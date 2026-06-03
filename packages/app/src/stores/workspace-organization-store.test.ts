import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  DEFAULT_WORKSPACE_ORGANIZATION_MODE,
  getWorkspaceOrganizationPolicy,
} from "@/stores/workspace-organization-store";

describe("workspace organization policy", () => {
  it("defaults to workspace-first production behavior", () => {
    expect(DEFAULT_WORKSPACE_ORGANIZATION_MODE).toBe("workspace-first");
    expect(getWorkspaceOrganizationPolicy(DEFAULT_WORKSPACE_ORGANIZATION_MODE)).toEqual({
      sidebarMode: "workspaces",
      tabScope: "workspace",
      agentVisibilityScope: "workspace",
      agentTabClose: "archive-root",
      agentTabPopulation: "auto-active",
      sidebarShortcutScope: "workspaces",
    });
  });

  it("keeps thread-first behavior opt-in", () => {
    expect(getWorkspaceOrganizationPolicy("thread-first")).toEqual({
      sidebarMode: "threads",
      tabScope: "project",
      agentVisibilityScope: "project",
      agentTabClose: "layout-only",
      agentTabPopulation: "manual-open",
      sidebarShortcutScope: "none",
    });
  });
});
