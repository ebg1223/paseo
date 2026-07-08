import { z } from "zod";

import type { PiAgentMessage } from "../pi-shared/rpc-types.js";

export type OmpSubagentSubscriptionLevel = "off" | "progress" | "events";

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
  | OmpTodoReminderEvent
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
