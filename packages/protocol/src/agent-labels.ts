export const PROVIDER_CHILD_OWNER_LABEL = "paseo.provider-child-owner";
export const PROVIDER_CHILD_RESUMABLE_LABEL = "paseo.provider-child-resumable";
export const PROVIDER_CHILD_REASON_LABEL = "paseo.provider-child-reason";

export type ProviderChildOwnership =
  | { owner: "provider" }
  | { owner: "paseo"; resumable: true }
  | { owner: "none"; resumable: false; reason: string };

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function getProviderChildOwnershipFromLabels(
  labels: Record<string, unknown> | null | undefined,
): ProviderChildOwnership | null {
  const owner = labels?.[PROVIDER_CHILD_OWNER_LABEL];
  if (owner === "provider") {
    return { owner };
  }
  if (owner === "paseo" && labels?.[PROVIDER_CHILD_RESUMABLE_LABEL] === "true") {
    return { owner, resumable: true };
  }
  if (owner === "none" && labels?.[PROVIDER_CHILD_RESUMABLE_LABEL] === "false") {
    const reason = labels?.[PROVIDER_CHILD_REASON_LABEL];
    return {
      owner,
      resumable: false,
      reason: typeof reason === "string" && reason.trim() ? reason : "Provider child is read-only",
    };
  }
  return null;
}

export function getProviderChildOwnershipLabels(
  ownership: ProviderChildOwnership,
): Record<string, string> {
  if (ownership.owner === "provider") {
    return {
      [PROVIDER_CHILD_OWNER_LABEL]: ownership.owner,
      [PROVIDER_CHILD_RESUMABLE_LABEL]: "false",
    };
  }
  if (ownership.owner === "paseo") {
    return {
      [PROVIDER_CHILD_OWNER_LABEL]: ownership.owner,
      [PROVIDER_CHILD_RESUMABLE_LABEL]: "true",
    };
  }
  return {
    [PROVIDER_CHILD_OWNER_LABEL]: ownership.owner,
    [PROVIDER_CHILD_RESUMABLE_LABEL]: "false",
    [PROVIDER_CHILD_REASON_LABEL]: ownership.reason,
  };
}
