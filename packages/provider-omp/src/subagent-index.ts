import type { AgentStreamEvent } from "@getpaseo/provider-sdk";
import {
  PiHistoryMapper,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveToolCallName,
} from "@getpaseo/provider-sdk/pi-rpc";
import type { PiTrackedToolCall } from "@getpaseo/provider-sdk/pi-rpc";
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
  status: "running" | "completed" | "failed" | "canceled" | undefined;
  mapper: PiHistoryMapper;
  pendingToolCalls: Map<string, PiTrackedToolCall>;
}

export class OmpSubagentIndex {
  private readonly statesByParent = new WeakMap<object, Map<string, OmpSubagentState>>();

  handleLifecycle(parent: object, payload: OmpSubagentLifecyclePayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, payload.agent);
    const status = mapLifecycleStatus(payload.status);
    if (
      (state.status === "completed" || state.status === "failed" || state.status === "canceled") &&
      status === "running"
    )
      return [];
    state.title = payload.agent || state.title;
    state.description = payload.description ?? state.description;
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    state.status = status;
    return [this.upsert(payload.id, status, state)];
  }

  handleProgress(parent: object, payload: OmpSubagentProgressPayload): AgentStreamEvent[] {
    const id = payload.progress.id;
    const state = this.stateFor(parent, id, payload.agent);
    const status = mapProgressStatus(payload.progress.status);
    if (
      (state.status === "completed" || state.status === "failed" || state.status === "canceled") &&
      status === "running"
    )
      return [];
    state.title = payload.agent || state.title;
    state.description = payload.progress.description ?? payload.assignment ?? state.description;
    if (payload.progress.resolvedModel?.trim()) {
      state.resolvedModel = payload.progress.resolvedModel;
    }
    state.toolCallId = payload.parentToolCallId ?? state.toolCallId;
    state.status = status;
    return [this.upsert(id, status, state)];
  }

  handleEvent(parent: object, payload: OmpSubagentEventPayload): AgentStreamEvent[] {
    const state = this.stateFor(parent, payload.id, "OMP subagent");
    if (payload.event.type === "tool_execution_start") {
      const toolCall = parseToolArgs(payload.event.toolName, payload.event.args);
      state.pendingToolCalls.set(payload.event.toolCallId, toolCall);
      const detail =
        OMP_HISTORY_MAPPER_HOOKS.mapToolDetail?.(toolCall, null, {
          toolCallId: payload.event.toolCallId,
        }) ?? mapToolDetail(toolCall, null);
      return detail
        ? [
            this.timeline(payload.id, {
              type: "tool_call",
              callId: payload.event.toolCallId,
              name: toolCall.toolName,
              status: "running",
              detail,
              error: null,
            }),
          ]
        : [];
    }
    if (payload.event.type === "tool_execution_end") {
      const toolCall =
        state.pendingToolCalls.get(payload.event.toolCallId) ??
        parseToolArgs(payload.event.toolName, null);
      state.pendingToolCalls.delete(payload.event.toolCallId);
      const result = parseToolResult(payload.event.result);
      const detail =
        OMP_HISTORY_MAPPER_HOOKS.mapToolDetail?.(toolCall, result, {
          toolCallId: payload.event.toolCallId,
        }) ?? mapToolDetail(toolCall, result);
      if (!detail) return [];
      const failed = Boolean(payload.event.isError);
      const item = failed
        ? {
            type: "tool_call" as const,
            callId: payload.event.toolCallId,
            name: resolveToolCallName(toolCall, result),
            status: "failed" as const,
            detail,
            error: payload.event.result,
          }
        : {
            type: "tool_call" as const,
            callId: payload.event.toolCallId,
            name: resolveToolCallName(toolCall, result),
            status: "completed" as const,
            detail,
            error: null,
          };
      return [this.timeline(payload.id, item)];
    }
    if (payload.event.type !== "message_end") return [];
    return state.mapper
      .mapMessages([payload.event.message])
      .flatMap((mapped) =>
        mapped.type === "timeline"
          ? [this.timeline(payload.id, mapped.item, mapped.timestamp)]
          : [],
      );
  }

  terminalizeRunning(parent: object): AgentStreamEvent[] {
    const states = this.statesByParent.get(parent);
    if (!states) return [];
    const events: AgentStreamEvent[] = [];
    for (const [id, state] of states) {
      if (state.status === undefined || state.status === "running") {
        state.status = "canceled";
        events.push(this.upsert(id, "canceled", state));
      }
    }
    return events;
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
      status: undefined,
      mapper: new PiHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS),
      pendingToolCalls: new Map(),
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

  private timeline(
    id: string,
    item: Extract<AgentStreamEvent, { type: "timeline" }>["item"],
    timestamp?: string,
  ): AgentStreamEvent {
    return {
      type: "provider_subagent",
      provider: "omp",
      event: {
        type: "timeline",
        id,
        item,
        ...(timestamp ? { timestamp } : {}),
      },
    };
  }
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
