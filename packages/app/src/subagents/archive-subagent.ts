import type { Agent } from "@/stores/session-store";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface ResolveArchiveSubagentDialogInput {
  title: Agent["title"] | null | undefined;
  status: Agent["status"] | null | undefined;
  providerChildOwnership?: Agent["providerChildOwnership"];
}

function resolveSubagentLabel(title: Agent["title"] | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

function resolveArchiveMessage(
  subagentLabel: string,
  isRunning: boolean,
  isProviderOwned: boolean,
): string {
  if (isProviderOwned) {
    return `Remove ${subagentLabel} from Paseo. The provider-owned child will keep running until its parent provider session exits.`;
  }
  if (isRunning) {
    return `${subagentLabel} is still running. Archiving it will stop the subagent and remove it from the track.`;
  }
  return `Remove ${subagentLabel} from the track. The subagent will be archived.`;
}

export function resolveArchiveSubagentDialog(
  input: ResolveArchiveSubagentDialogInput,
): ConfirmDialogInput {
  const subagentLabel = resolveSubagentLabel(input.title) ?? "this subagent";
  const isRunning = input.status === "running";
  const isProviderOwned = input.providerChildOwnership?.owner === "provider";

  return {
    title: isRunning ? "Archive running subagent?" : "Archive subagent?",
    message: resolveArchiveMessage(subagentLabel, isRunning, isProviderOwned),
    confirmLabel: "Archive",
    cancelLabel: "Cancel",
    destructive: true,
  };
}

export interface ArchiveSubagentDeps {
  getSubagent: (subagentId: string) => ResolveArchiveSubagentDialogInput | undefined;
  confirm: (input: ConfirmDialogInput) => Promise<boolean>;
  archiveAgent: (input: { serverId: string; agentId: string }) => Promise<void>;
  reportError: (error: unknown) => void;
}

export interface RequestArchiveSubagentInput {
  serverId: string;
  subagentId: string;
}

export async function requestArchiveSubagent(
  input: RequestArchiveSubagentInput,
  deps: ArchiveSubagentDeps,
): Promise<void> {
  const subagent = deps.getSubagent(input.subagentId);
  const confirmed = await deps.confirm(
    resolveArchiveSubagentDialog({
      title: subagent?.title,
      status: subagent?.status,
      providerChildOwnership: subagent?.providerChildOwnership,
    }),
  );
  if (!confirmed) {
    return;
  }
  try {
    await deps.archiveAgent({ serverId: input.serverId, agentId: input.subagentId });
  } catch (error) {
    deps.reportError(error);
  }
}
