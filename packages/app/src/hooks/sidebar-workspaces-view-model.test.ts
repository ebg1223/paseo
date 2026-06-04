import { describe, expect, it } from "vitest";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarProjectsFromStructure,
  buildSidebarProjectsWithAgents,
  computeSidebarOrderUpdates,
  deriveSidebarLoadingState,
  type SidebarAgentProjectionSource,
  type SidebarProjectEntry,
} from "./sidebar-workspaces-view-model";

interface OrderedItem {
  key: string;
}

function item(key: string): OrderedItem {
  return { key };
}

function project(input: {
  projectKey: string;
  projectName?: string;
  projectKind?: WorkspaceStructureProject["projectKind"];
  iconWorkingDir?: string;
  workspaceKeys: string[];
  workspaceDetailsById?: WorkspaceStructureProject["workspaceDetailsById"];
}): WorkspaceStructureProject {
  return {
    projectKey: input.projectKey,
    projectName: input.projectName ?? input.projectKey,
    projectKind: input.projectKind ?? "git",
    iconWorkingDir: input.iconWorkingDir ?? input.projectKey,
    workspaceKeys: input.workspaceKeys,
    workspaceDetailsById: input.workspaceDetailsById,
  };
}

function sidebarProject(input: {
  projectKey: string;
  workspaceKeys: string[];
  serverId?: string;
}): SidebarProjectEntry {
  const projects = buildSidebarProjectsFromStructure({
    serverId: input.serverId ?? "srv",
    projects: [project({ projectKey: input.projectKey, workspaceKeys: input.workspaceKeys })],
  });
  const result = projects[0];
  if (!result) {
    throw new Error("expected a project entry");
  }
  return result;
}

function workspaceDescriptor(overrides: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor {
  const { statusEnteredAt = null, ...rest } = overrides;
  return {
    id: "ws-main",
    projectId: "project-1",
    projectDisplayName: "Project 1",
    projectCustomName: null,
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    name: "main",
    status: "done",
    statusEnteredAt,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    project: {
      projectKey: "project-1",
      projectName: "Project 1",
      checkout: {
        cwd: "/repo",
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: "/repo",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
    ...rest,
  };
}

function agent(
  overrides: Partial<SidebarAgentProjectionSource> = {},
): SidebarAgentProjectionSource {
  return {
    id: "agent-1",
    serverId: "srv",
    title: "Trial sidebar",
    status: "idle",
    cwd: "/repo",
    provider: "codex",
    lastActivityAt: new Date("2026-06-02T12:00:00.000Z"),
    pendingPermissionCount: 0,
    requiresAttention: false,
    archivedAt: null,
    projectPlacement: {
      projectKey: "project-1",
      projectName: "Project 1",
      checkout: {
        cwd: "/repo",
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: "/repo",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
    ...overrides,
  };
}

describe("applyStoredOrdering", () => {
  it("keeps unknown items on the baseline while applying stored order", () => {
    const result = applyStoredOrdering({
      items: [item("new"), item("a"), item("b")],
      storedOrder: ["b", "a"],
      getKey: (entry) => entry.key,
    });

    expect(result.map((entry) => entry.key)).toEqual(["new", "b", "a"]);
  });

  it("ignores stale and duplicate stored keys", () => {
    const result = applyStoredOrdering({
      items: [item("x"), item("y")],
      storedOrder: ["missing", "y", "y", "x"],
      getKey: (entry) => entry.key,
    });

    expect(result.map((entry) => entry.key)).toEqual(["y", "x"]);
  });

  it("returns baseline when there is no persisted order", () => {
    const baseline = [item("first"), item("second")];
    const result = applyStoredOrdering({
      items: baseline,
      storedOrder: [],
      getKey: (entry) => entry.key,
    });

    expect(result).toBe(baseline);
  });
});

describe("appendMissingOrderKeys", () => {
  it("appends unseen keys while preserving existing order", () => {
    const result = appendMissingOrderKeys({
      currentOrder: ["project-b", "project-a"],
      visibleKeys: ["project-a", "project-b", "project-c"],
    });

    expect(result).toEqual(["project-b", "project-a", "project-c"]);
  });

  it("returns the same array when there are no unseen keys", () => {
    const currentOrder = ["project-a", "project-b"];

    const result = appendMissingOrderKeys({
      currentOrder,
      visibleKeys: ["project-b", "project-a"],
    });

    expect(result).toBe(currentOrder);
  });
});

describe("buildSidebarProjectsFromStructure", () => {
  it("creates structural workspace rows from ordered workspace keys", () => {
    const projects = buildSidebarProjectsFromStructure({
      serverId: "srv",
      projects: [
        project({
          projectKey: "project-1",
          projectName: "Project 1",
          iconWorkingDir: "/repo/main",
          workspaceKeys: ["ws-main"],
        }),
      ],
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectName).toBe("Project 1");
    expect(projects[0]?.workspaces[0]).toMatchObject({
      workspaceKey: "srv:ws-main",
      serverId: "srv",
      workspaceId: "ws-main",
      projectRootPath: "/repo/main",
      projectKind: "git",
    });
  });

  it("preserves branch metadata for structural workspace rows", () => {
    const projects = buildSidebarProjectsFromStructure({
      serverId: "srv",
      projects: [
        project({
          projectKey: "project-1",
          projectName: "Project 1",
          iconWorkingDir: "/repo",
          workspaceKeys: ["/Users/ethan/paseo"],
          workspaceDetailsById: {
            "/Users/ethan/paseo": {
              workspaceId: "/Users/ethan/paseo",
              workspaceName: "/Users/ethan/paseo",
              workspaceDirectory: "/Users/ethan/paseo",
              workspaceKind: "local_checkout",
              currentBranch: "feature/sidebar",
            },
          },
        }),
      ],
    });

    expect(projects[0]?.workspaces[0]).toMatchObject({
      workspaceId: "/Users/ethan/paseo",
      name: "/Users/ethan/paseo",
      branchName: "feature/sidebar",
    });
  });

  it("preserves the structure hook project order", () => {
    const projects = buildSidebarProjectsFromStructure({
      serverId: "srv",
      projects: [
        project({ projectKey: "project-b", workspaceKeys: ["ws-b"] }),
        project({ projectKey: "project-a", workspaceKeys: ["ws-a"] }),
      ],
    });

    expect(projects.map((entry) => entry.projectKey)).toEqual(["project-b", "project-a"]);
  });

  it("preserves the structure hook workspace order", () => {
    const projects = buildSidebarProjectsFromStructure({
      serverId: "srv",
      projects: [project({ projectKey: "project-1", workspaceKeys: ["feature", "main"] })],
    });

    expect(projects[0]?.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      "feature",
      "main",
    ]);
  });
});

describe("buildSidebarProjectsWithAgents", () => {
  it("groups active agents under an existing project by workspace cwd", () => {
    const baseProjects = buildSidebarProjectsFromStructure({
      serverId: "srv",
      projects: [
        project({
          projectKey: "project-1",
          projectName: "Project 1",
          iconWorkingDir: "/repo",
          workspaceKeys: ["ws-main"],
        }),
      ],
    });

    const projects = buildSidebarProjectsWithAgents({
      projects: baseProjects,
      agents: [agent({ status: "running", pendingPermissionCount: 2 })],
      workspaces: [workspaceDescriptor()],
    });

    expect(projects).toHaveLength(1);
    expect(projects[0]?.agents).toEqual([
      expect.objectContaining({
        rowKey: "srv:agent:agent-1",
        agentId: "agent-1",
        projectKey: "project-1",
        workspaceId: "ws-main",
        title: "Trial sidebar",
        statusBucket: "needs_input",
        branchName: "main",
      }),
    ]);
  });

  it("does not count initializing agents as running", () => {
    const baseProjects = buildSidebarProjectsFromStructure({
      serverId: "srv",
      projects: [
        project({
          projectKey: "project-1",
          projectName: "Project 1",
          iconWorkingDir: "/repo",
          workspaceKeys: ["ws-main"],
        }),
      ],
    });

    const projects = buildSidebarProjectsWithAgents({
      projects: baseProjects,
      agents: [agent({ status: "initializing" })],
      workspaces: [workspaceDescriptor()],
    });

    expect(projects[0]?.agents[0]?.statusBucket).toBe("done");
  });

  it("creates a synthetic project for active agents without a workspace descriptor", () => {
    const projects = buildSidebarProjectsWithAgents({
      projects: [],
      agents: [
        agent({
          id: "agent-orphan",
          cwd: "/repo/worktree-a",
          projectPlacement: {
            projectKey: "project-1",
            projectName: "Project 1",
            checkout: {
              cwd: "/repo/worktree-a",
              isGit: true,
              currentBranch: "trial",
              remoteUrl: null,
              worktreeRoot: "/repo/worktree-a",
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          },
        }),
      ],
      workspaces: [],
    });

    expect(projects).toEqual([
      expect.objectContaining({
        projectKey: "project-1",
        projectName: "Project 1",
        projectKind: "git",
        workspaces: [],
        agents: [
          expect.objectContaining({
            agentId: "agent-orphan",
            workspaceId: null,
            branchName: "trial",
          }),
        ],
      }),
    ]);
  });
});

describe("computeSidebarOrderUpdates", () => {
  it("returns no updates when there are no visible projects", () => {
    const updates = computeSidebarOrderUpdates({
      projects: [],
      persistedProjectOrder: ["stale-project"],
      getWorkspaceOrder: () => [],
    });

    expect(updates).toEqual({ projectOrder: null, workspaceOrders: [] });
  });

  it("appends unseen projects and workspaces to the persisted orders", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-1", "ws-2"] }),
      sidebarProject({ projectKey: "project-b", workspaceKeys: ["ws-3"] }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-a"],
      getWorkspaceOrder: (projectKey) => (projectKey === "project-a" ? ["srv:ws-1"] : []),
    });

    expect(updates.projectOrder).toEqual(["project-a", "project-b"]);
    expect(updates.workspaceOrders).toEqual([
      { projectKey: "project-a", order: ["srv:ws-1", "srv:ws-2"] },
      { projectKey: "project-b", order: ["srv:ws-3"] },
    ]);
  });

  it("returns no project-order update when persisted order already covers visible keys", () => {
    const projects = [
      sidebarProject({ projectKey: "project-a", workspaceKeys: ["ws-1"] }),
      sidebarProject({ projectKey: "project-b", workspaceKeys: ["ws-2"] }),
    ];

    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: ["project-b", "project-a"],
      getWorkspaceOrder: (projectKey) => (projectKey === "project-a" ? ["srv:ws-1"] : ["srv:ws-2"]),
    });

    expect(updates.projectOrder).toBeNull();
    expect(updates.workspaceOrders).toEqual([]);
  });
});

describe("deriveSidebarLoadingState", () => {
  it("reports initial-load while active and unhydrated with no projects", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverId: "srv",
        hasHydratedWorkspaces: false,
        hasProjects: false,
      }),
    ).toEqual({ isLoading: true, isInitialLoad: true, isRevalidating: false });
  });

  it("stays loading but not initial once projects are visible", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverId: "srv",
        hasHydratedWorkspaces: false,
        hasProjects: true,
      }),
    ).toEqual({ isLoading: true, isInitialLoad: false, isRevalidating: false });
  });

  it("clears loading once workspaces have hydrated", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: true,
        serverId: "srv",
        hasHydratedWorkspaces: true,
        hasProjects: true,
      }),
    ).toEqual({ isLoading: false, isInitialLoad: false, isRevalidating: false });
  });

  it("short-circuits to idle when inactive", () => {
    expect(
      deriveSidebarLoadingState({
        isActive: false,
        serverId: "srv",
        hasHydratedWorkspaces: false,
        hasProjects: false,
      }),
    ).toEqual({ isLoading: false, isInitialLoad: false, isRevalidating: false });
  });
});
