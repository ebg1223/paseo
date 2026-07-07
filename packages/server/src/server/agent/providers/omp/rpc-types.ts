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
  task: string;
  parentToolCallId?: string;
  assignment?: string;
  progress: {
    id: string;
    status: OmpSubagentStatus;
    description?: string;
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
  | { type: "subagent_progress"; payload: OmpSubagentProgressPayload };
