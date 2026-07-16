import type { AgentStreamEvent } from "@getpaseo/provider-sdk";
import { PiHistoryMapper } from "@getpaseo/provider-sdk/pi-rpc";
import type { PiAgentMessage, PiAgentSessionEvent } from "@getpaseo/provider-sdk/pi-rpc";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { formatOmpSubagentTitle } from "./subagent-title.js";
import type {
  OmpSubagentEventPayload,
  OmpSubagentLifecyclePayload,
  OmpSubagentProgressPayload,
} from "./rpc-types.js";

interface OmpSubagentState {
  title: string;
  description: string | null;
  resolvedModel: string | null;
  toolCallId: string | null;
  mapper: PiHistoryMapper;
}

export class OmpSubagentIndex {
  private readonly statesByParent = new WeakMap<object, Map<string, OmpSubagentState>>();

  handleLifecycle(parent: object, payload: OmpSubagentLifecyclePayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.description ?? state.description;
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    return [this.upsert(payload.id, mapLifecycleStatus(payload.status), state)];
  }

  handleProgress(parent: object, payload: OmpSubagentProgressPayload): AgentStreamEvent[] {
    const id = payload.progress.id;
    const state = this.stateFor(parent, id, payload.agent);
    state.title = payload.agent || state.title;
    state.description = payload.progress.description ?? payload.assignment ?? state.description;
    if (payload.progress.resolvedModel?.trim()) {
      state.resolvedModel = payload.progress.resolvedModel;
    }
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    return [this.upsert(id, mapProgressStatus(payload.progress.status), state)];
  }

  handleEvent(parent: object, payload: OmpSubagentEventPayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, "OMP subagent");
    const messages = messagesFromSessionEvent(payload.event);
    return state.mapper.mapMessages(messages).flatMap((mapped) =>
      mapped.type === "timeline"
        ? [
            {
              type: "provider_subagent" as const,
              provider: "omp",
              event: {
                type: "timeline" as const,
                id: payload.id,
                item: mapped.item,
                ...(mapped.timestamp ? { timestamp: mapped.timestamp } : {}),
              },
            },
          ]
        : [],
    );
  }

  clear(parent: object): void {
    this.statesByParent.delete(parent);
  }

  private stateFor(parent: object, id: string, title: string): OmpSubagentState {
    const states = this.statesByParent.get(parent) ?? new Map<string, OmpSubagentState>();
    const existing = states.get(id);
    if (existing) return existing;
    const state: OmpSubagentState = {
      title,
      description: null,
      resolvedModel: null,
      toolCallId: null,
      mapper: new PiHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS),
    };
    states.set(id, state);
    this.statesByParent.set(parent, states);
    return state;
  }

  private upsert(
    id: string,
    status: "running" | "completed" | "failed" | "canceled",
    state: OmpSubagentState,
  ): AgentStreamEvent {
    return {
      type: "provider_subagent",
      provider: "omp",
      event: {
        type: "upsert",
        id,
        title: formatOmpSubagentTitle(state.title, state.resolvedModel),
        description: state.description,
        status,
        toolCallId: state.toolCallId,
      },
    };
  }
}

function messagesFromSessionEvent(event: PiAgentSessionEvent): PiAgentMessage[] {
  if (event.type === "message_end") return [event.message];
  return [];
}

function mapLifecycleStatus(
  status: OmpSubagentLifecyclePayload["status"],
): "running" | "completed" | "failed" | "canceled" {
  if (status === "started") return "running";
  return status === "aborted" ? "canceled" : status;
}

function mapProgressStatus(
  status: OmpSubagentProgressPayload["progress"]["status"],
): "running" | "completed" | "failed" | "canceled" {
  if (status === "completed" || status === "failed") return status;
  return status === "aborted" ? "canceled" : "running";
}
