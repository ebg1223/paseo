import type { WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";

export interface WorkspaceStructureProject {
  projectKey: string;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  workspaceKeys: string[];
  workspaceDetailsById?: Record<string, WorkspaceStructureWorkspaceDetails>;
}

export interface WorkspaceStructureWorkspaceDetails {
  workspaceId: string;
  workspaceName: string;
  workspaceDirectory: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  currentBranch: string | null;
}

export interface WorkspaceStructure {
  projects: WorkspaceStructureProject[];
}

const EMPTY_WORKSPACE_STRUCTURE: WorkspaceStructure = { projects: [] };

function compareWorkspaceStructureItems(
  left: { workspaceId: string; workspaceName: string },
  right: { workspaceId: string; workspaceName: string },
): number {
  const nameDelta = left.workspaceName.localeCompare(right.workspaceName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (nameDelta !== 0) {
    return nameDelta;
  }

  return left.workspaceId.localeCompare(right.workspaceId, undefined, {
    sensitivity: "base",
  });
}

function compareWorkspaceStructureProjects(
  left: WorkspaceStructureProject,
  right: WorkspaceStructureProject,
): number {
  return left.projectName.localeCompare(right.projectName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function buildWorkspaceStructureProjects(input: {
  serverId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
}): WorkspaceStructureProject[] {
  const workspaceList = Array.from(input.workspaces);
  if (workspaceList.length === 0) {
    return EMPTY_WORKSPACE_STRUCTURE.projects;
  }

  const byProject = new Map<
    string,
    WorkspaceStructureProject & {
      workspaces: Array<WorkspaceStructureWorkspaceDetails & { workspaceKey: string }>;
      workspaceDetailsById: Record<string, WorkspaceStructureWorkspaceDetails>;
    }
  >();

  for (const workspace of workspaceList) {
    const project =
      byProject.get(workspace.projectId) ??
      ({
        projectKey: workspace.projectId,
        projectName:
          workspace.projectDisplayName || projectDisplayNameFromProjectId(workspace.projectId),
        projectKind: workspace.projectKind,
        iconWorkingDir: workspace.projectRootPath,
        workspaceKeys: [],
        workspaceDetailsById: {},
        workspaces: [],
      } satisfies WorkspaceStructureProject & {
        workspaces: Array<WorkspaceStructureWorkspaceDetails & { workspaceKey: string }>;
        workspaceDetailsById: Record<string, WorkspaceStructureWorkspaceDetails>;
      });

    const workspaceDetails = {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceDirectory: workspace.workspaceDirectory,
      workspaceKind: workspace.workspaceKind,
      currentBranch: workspace.gitRuntime?.currentBranch ?? null,
    };
    project.workspaces.push({
      ...workspaceDetails,
      workspaceKey: `${input.serverId}:${workspace.id}`,
    });
    project.workspaceDetailsById[workspace.id] = workspaceDetails;
    byProject.set(workspace.projectId, project);
  }

  const projects = Array.from(byProject.values()).map(
    ({ workspaces: projectWorkspaces, ...project }) => {
      const sortedWorkspaces = [...projectWorkspaces].sort(compareWorkspaceStructureItems);

      return Object.assign({}, project, {
        workspaceKeys: sortedWorkspaces.map((workspace) => workspace.workspaceId),
      });
    },
  );

  projects.sort(compareWorkspaceStructureProjects);
  return projects;
}
