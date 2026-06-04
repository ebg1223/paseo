import { describe, expect, it } from "vitest";
import {
  buildSidebarProjectRowModel,
  isSidebarProjectFlattened,
} from "./sidebar-project-row-model";
import type {
  SidebarAgentEntry,
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

function workspace(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    workspaceKey: "srv:ws-root",
    serverId: "srv",
    workspaceId: "ws-root",
    projectKey: "project-1",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    name: "paseo",
    branchName: null,
    statusBucket: "done",
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    statusEnteredAt: null,
    ...overrides,
    archivingAt: overrides.archivingAt ?? null,
  };
}

function project(overrides: Partial<SidebarProjectEntry> = {}): SidebarProjectEntry {
  const projectKind = overrides.projectKind ?? "git";
  return {
    projectKey: "project-1",
    projectName: "paseo",
    projectKind,
    iconWorkingDir: "/repo",
    canCreateWorktree: overrides.canCreateWorktree ?? projectKind === "git",
    workspaces: [workspace()],
    agents: [],
    ...overrides,
  };
}

function agent(overrides: Partial<SidebarAgentEntry> = {}): SidebarAgentEntry {
  return {
    rowKey: "srv:agent:agent-1",
    serverId: "srv",
    agentId: "agent-1",
    projectKey: "project-1",
    workspaceId: "ws-root",
    workspaceDirectory: "/repo",
    workspaceName: "paseo",
    workspaceKind: "checkout",
    title: "Trial sidebar",
    statusBucket: "running",
    provider: "codex",
    branchName: "main",
    lastActivityAt: new Date("2026-06-02T12:00:00.000Z"),
    pendingPermissionCount: 0,
    requiresAttention: false,
    ...overrides,
  };
}

describe("buildSidebarProjectRowModel", () => {
  it("flattens non-git projects with one workspace into a direct workspace row model", () => {
    const flattenedWorkspace = workspace({
      workspaceId: "ws-non-git",
      workspaceKind: "checkout",
      statusBucket: "running",
    });

    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "directory",
        workspaces: [flattenedWorkspace],
      }),
      collapsed: false,
    });

    expect(result).toEqual({
      kind: "workspace_link",
      workspace: flattenedWorkspace,
      chevron: null,
      trailingAction: "none",
    });
  });

  it("builds flattened non-git rows without route selection input", () => {
    const flattenedWorkspace = workspace({
      serverId: "srv-2",
      workspaceId: "ws-non-git",
    });

    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "directory",
        workspaces: [flattenedWorkspace],
      }),
      collapsed: false,
    });

    expect(result).toMatchObject({
      kind: "workspace_link",
      workspace: flattenedWorkspace,
      chevron: null,
      trailingAction: "none",
    });
    expect(result).not.toHaveProperty("selected");
  });

  it("keeps single-workspace git projects as sections with the new worktree action", () => {
    const onlyWorkspace = workspace({
      workspaceId: "ws-main",
      workspaceKind: "checkout",
    });

    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "git",
        workspaces: [onlyWorkspace],
      }),
      collapsed: true,
    });

    expect(result).toEqual({
      kind: "project_section",
      chevron: "expand",
      trailingAction: "new_worktree",
    });
  });

  it("keeps multi-workspace git projects expandable in workspace-first mode", () => {
    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "git",
        workspaces: [
          workspace({ workspaceId: "ws-main", workspaceKind: "checkout" }),
          workspace({ workspaceId: "ws-feature", workspaceKind: "worktree" }),
        ],
      }),
      collapsed: true,
    });

    expect(result).toEqual({
      kind: "project_section",
      chevron: "expand",
      trailingAction: "new_worktree",
    });
  });

  it("uses thread rows, not workspace count, for thread-first expandability", () => {
    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "git",
        workspaces: [
          workspace({ workspaceId: "ws-main", workspaceKind: "checkout" }),
          workspace({ workspaceId: "ws-feature", workspaceKind: "worktree" }),
        ],
      }),
      collapsed: true,
      organizationMode: "thread-first",
    });

    expect(result).toEqual({
      kind: "project_section",
      chevron: null,
      trailingAction: "new_worktree",
    });
  });

  it("makes projects with thread rows expandable in thread-first mode", () => {
    const result = buildSidebarProjectRowModel({
      project: project({
        agents: [agent()],
      }),
      collapsed: true,
      organizationMode: "thread-first",
    });

    expect(result).toEqual({
      kind: "project_section",
      chevron: "expand",
      trailingAction: "new_worktree",
    });
  });
});

describe("isSidebarProjectFlattened", () => {
  it("returns true only for single-workspace non-git projects", () => {
    expect(
      isSidebarProjectFlattened(project({ projectKind: "git", workspaces: [workspace()] })),
    ).toBe(false);
    expect(
      isSidebarProjectFlattened(project({ projectKind: "directory", workspaces: [workspace()] })),
    ).toBe(true);
  });

  it("returns false for multi-workspace projects", () => {
    expect(
      isSidebarProjectFlattened(
        project({
          workspaces: [
            workspace({ workspaceId: "ws-main" }),
            workspace({ workspaceId: "ws-feat" }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("ignores hidden agent rows when flattening workspace-first projects", () => {
    expect(
      isSidebarProjectFlattened(
        project({
          projectKind: "directory",
          workspaces: [workspace()],
          agents: [agent()],
        }),
      ),
    ).toBe(true);
  });

  it("returns false for thread-first projects that have agent rows", () => {
    expect(
      isSidebarProjectFlattened(
        project({
          projectKind: "directory",
          workspaces: [workspace()],
          agents: [agent()],
        }),
        "thread-first",
      ),
    ).toBe(false);
  });
});
