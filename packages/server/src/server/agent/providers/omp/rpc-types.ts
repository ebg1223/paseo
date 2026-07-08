import { z } from "zod";

import type { PiAgentMessage } from "../pi-shared/rpc-types.js";

export type OmpSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface OmpAgentToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details?: unknown;
  isError?: boolean;
}

export interface OmpRpcHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
}

export interface OmpRpcHostToolCallRequest {
  type: "host_tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface OmpRpcHostToolCancelRequest {
  type: "host_tool_cancel";
  id: string;
  targetId: string;
}

export interface OmpRpcHostToolUpdate {
  type: "host_tool_update";
  id: string;
  partialResult: OmpAgentToolResult;
}

export interface OmpRpcHostToolResult {
  type: "host_tool_result";
  id: string;
  result: OmpAgentToolResult;
  isError?: boolean;
}

export type OmpSubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface OmpSubagentSnapshot {
  id: string;
  index: number;
  agent: string;
  description?: string;
  status: OmpSubagentStatus;
  task?: string;
  assignment?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  lastUpdate?: number;
}

export interface OmpSubagentLifecyclePayload {
  id: string;
  agent: string;
  agentSource?: string;
  description?: string;
  status: "started" | "completed" | "failed" | "aborted";
  sessionFile?: string;
  parentToolCallId?: string;
  index: number;
  detached?: boolean;
}

export interface OmpSubagentProgressPayload {
  index: number;
  agent: string;
  agentSource?: string;
  task: string;
  parentToolCallId?: string;
  assignment?: string;
  progress: {
    id: string;
    status: OmpSubagentStatus;
    description?: string;
    currentTool?: unknown;
    recentTools?: unknown[];
    recentOutput?: unknown[];
  };
  sessionFile?: string;
  detached?: boolean;
}

export interface OmpSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: PiAgentMessage[];
}

export interface OmpSubagentMessagesSelector {
  subagentId?: string;
  sessionFile?: string;
  fromByte?: number;
}

export type OmpRuntimeEvent =
  | { type: "subagent_lifecycle"; payload: OmpSubagentLifecyclePayload }
  | { type: "subagent_progress"; payload: OmpSubagentProgressPayload }
  | OmpRpcHostToolCallRequest
  | OmpRpcHostToolCancelRequest
  | OmpRpcHostToolUpdate
  | OmpTodoReminderEvent
  | OmpNoticeEvent
  | OmpGoalUpdatedEvent
  | OmpAutoRetryStartEvent
  | OmpAutoRetryEndEvent
  | OmpRetryFallbackAppliedEvent
  | OmpRetryFallbackSucceededEvent
  | OmpAutoCompactionStartEvent
  | OmpAutoCompactionEndEvent
  | OmpTtsrTriggeredEvent
  | OmpIrcMessageEvent
  | OmpTodoAutoClearEvent
  | OmpAvailableCommandsUpdateEvent;

export type OmpTodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export const OmpTodoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "abandoned"]),
  })
  .passthrough();

export const OmpTodoPhaseSchema = z
  .object({
    name: z.string(),
    tasks: z.array(OmpTodoItemSchema),
  })
  .passthrough();

export const OmpTodoReminderEventSchema = z
  .object({
    type: z.literal("todo_reminder"),
    todos: z.array(OmpTodoItemSchema),
  })
  .passthrough();

export type OmpTodoItem = z.infer<typeof OmpTodoItemSchema>;
export type OmpTodoPhase = z.infer<typeof OmpTodoPhaseSchema>;
export type OmpTodoReminderEvent = z.infer<typeof OmpTodoReminderEventSchema>;

export const OmpNoticeEventSchema = z
  .object({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
    source: z.string().optional(),
  })
  .passthrough();

export const OmpGoalSchema = z
  .object({
    id: z.string().optional(),
    objective: z.string().optional(),
    status: z.string().optional(),
    tokenBudget: z.number().optional(),
    tokensUsed: z.number().optional(),
    timeUsedSeconds: z.number().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const OmpGoalModeStateSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.string().optional(),
    reason: z.string().optional(),
    goal: OmpGoalSchema.optional(),
  })
  .passthrough();

export const OmpGoalUpdatedEventSchema = z
  .object({
    type: z.literal("goal_updated"),
    goal: OmpGoalSchema.nullable().optional(),
    state: OmpGoalModeStateSchema.optional(),
  })
  .passthrough();

export const OmpAutoRetryStartEventSchema = z
  .object({
    type: z.literal("auto_retry_start"),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    errorMessage: z.string(),
    errorId: z.number().int().optional(),
  })
  .passthrough();

export const OmpAutoRetryEndEventSchema = z
  .object({
    type: z.literal("auto_retry_end"),
    success: z.boolean(),
    attempt: z.number().int().nonnegative(),
    finalError: z.string().optional(),
    recoveredErrors: z.unknown().optional(),
  })
  .passthrough();

export const OmpRetryFallbackAppliedEventSchema = z
  .object({
    type: z.literal("retry_fallback_applied"),
    from: z.string(),
    to: z.string(),
    role: z.string(),
  })
  .passthrough();

export const OmpRetryFallbackSucceededEventSchema = z
  .object({
    type: z.literal("retry_fallback_succeeded"),
    model: z.string(),
    role: z.string(),
  })
  .passthrough();

export const OmpAutoCompactionStartEventSchema = z
  .object({
    type: z.literal("auto_compaction_start"),
    reason: z.string(),
    action: z.string(),
  })
  .passthrough();

export const OmpAutoCompactionEndEventSchema = z
  .object({
    type: z.literal("auto_compaction_end"),
    action: z.string().optional(),
    result: z.unknown().optional(),
    aborted: z.boolean(),
    willRetry: z.boolean(),
    errorMessage: z.string().optional(),
    skipped: z.boolean().optional(),
  })
  .passthrough();

export const OmpTtsrTriggeredEventSchema = z
  .object({
    type: z.literal("ttsr_triggered"),
    rules: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const OmpIrcMessageEventSchema = z
  .object({
    type: z.literal("irc_message"),
    message: z.unknown().optional(),
  })
  .passthrough();

export const OmpTodoAutoClearEventSchema = z
  .object({
    type: z.literal("todo_auto_clear"),
  })
  .passthrough();

export type OmpNoticeEvent = z.infer<typeof OmpNoticeEventSchema>;
export type OmpGoal = z.infer<typeof OmpGoalSchema>;
export type OmpGoalUpdatedEvent = z.infer<typeof OmpGoalUpdatedEventSchema>;
export type OmpAutoRetryStartEvent = z.infer<typeof OmpAutoRetryStartEventSchema>;
export type OmpAutoRetryEndEvent = z.infer<typeof OmpAutoRetryEndEventSchema>;
export type OmpRetryFallbackAppliedEvent = z.infer<typeof OmpRetryFallbackAppliedEventSchema>;
export type OmpRetryFallbackSucceededEvent = z.infer<typeof OmpRetryFallbackSucceededEventSchema>;
export type OmpAutoCompactionStartEvent = z.infer<typeof OmpAutoCompactionStartEventSchema>;
export type OmpAutoCompactionEndEvent = z.infer<typeof OmpAutoCompactionEndEventSchema>;
export type OmpTtsrTriggeredEvent = z.infer<typeof OmpTtsrTriggeredEventSchema>;
export type OmpIrcMessageEvent = z.infer<typeof OmpIrcMessageEventSchema>;
export type OmpTodoAutoClearEvent = z.infer<typeof OmpTodoAutoClearEventSchema>;

export const OmpAvailableCommandSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: z.string().optional(),
    input: z
      .object({
        hint: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const OmpAvailableCommandsUpdateEventSchema = z
  .object({
    type: z.literal("available_commands_update"),
    commands: z.array(OmpAvailableCommandSchema),
  })
  .passthrough();

export type OmpAvailableCommand = z.infer<typeof OmpAvailableCommandSchema>;
export type OmpAvailableCommandsUpdateEvent = z.infer<typeof OmpAvailableCommandsUpdateEventSchema>;

export const OmpAgentToolResultSchema = z
  .object({
    content: z.array(
      z
        .object({
          type: z.string(),
          text: z.string().optional(),
        })
        .passthrough(),
    ),
    details: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

export const OmpRpcHostToolCallRequestSchema = z
  .object({
    type: z.literal("host_tool_call"),
    id: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const OmpRpcHostToolCancelRequestSchema = z
  .object({
    type: z.literal("host_tool_cancel"),
    id: z.string(),
    targetId: z.string(),
  })
  .passthrough();

export const OmpRpcHostToolUpdateSchema = z
  .object({
    type: z.literal("host_tool_update"),
    id: z.string(),
    partialResult: OmpAgentToolResultSchema,
  })
  .passthrough();
