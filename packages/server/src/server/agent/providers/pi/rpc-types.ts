export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

export type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCallContent;

export type PiAgentMessage =
  | {
      role: "user";
      content: string | Array<PiTextContent | PiImageContent>;
    }
  | {
      role: "custom";
      content: string | Array<PiTextContent | PiImageContent>;
    }
  | {
      role: "assistant";
      content: PiAssistantContent[];
      provider?: string;
      model?: string;
      responseId?: string;
      responseModel?: string;
      errorMessage?: string | null;
      stopReason?: string;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown;
      isError?: boolean;
    }
  | {
      role: "bashExecution";
      command: string;
      output?: string;
      exitCode?: number | null;
      cancelled?: boolean;
      timestamp: number;
    };

export interface PiModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  api?: string;
  baseUrl?: string;
  input?: string[];
  cost?: Record<string, unknown>;
  compat?: unknown;
}

export interface PiSessionState {
  model?: PiModel | null;
  thinkingLevel: PiThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled?: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount: number;
}

export interface PiSessionStats {
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number | null;
    percent?: number | null;
  };
}

export interface PiRpcSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: Record<string, unknown>;
}

export type PiCommandsRpcType = "get_commands" | "get_available_commands";

export type PiSubagentSubscriptionLevel = "off" | "progress" | "events";

export type PiSubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface PiSubagentSnapshot {
  id: string;
  index: number;
  agent: string;
  description?: string;
  status: PiSubagentStatus;
  task?: string;
  assignment?: string;
  sessionFile?: string;
  parentToolCallId?: string;
  lastUpdate?: number;
}

export interface PiSubagentLifecyclePayload {
  id: string;
  agent: string;
  description?: string;
  status: "started" | "completed" | "failed" | "aborted";
  sessionFile?: string;
  parentToolCallId?: string;
  index: number;
  detached?: boolean;
}

export interface PiSubagentProgressPayload {
  index: number;
  agent: string;
  task: string;
  parentToolCallId?: string;
  assignment?: string;
  progress: {
    id: string;
    status: PiSubagentStatus;
    description?: string;
  };
  sessionFile?: string;
  detached?: boolean;
}

export interface PiSubagentMessagesResult {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: PiAgentMessage[];
}

export type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: PiImageContent[] }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "abort" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "set_thinking_level"; level: PiThinkingLevel }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: PiCommandsRpcType }
  | { id?: string; type: "set_subagent_subscription"; level: PiSubagentSubscriptionLevel }
  | { id?: string; type: "get_subagents" }
  | {
      id?: string;
      type: "get_subagent_messages";
      subagentId?: string;
      sessionFile?: string;
      fromByte?: number;
    };

export interface PiRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type PiAssistantMessageEvent =
  | { type: "text_delta"; delta?: string }
  | { type: "thinking_delta"; delta?: string }
  | { type: "start" | "text_start" | "text_end" | "thinking_start" | "thinking_end" | "done" };

export type PiAgentSessionEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: PiAgentMessage }
  | { type: "message_end"; message: PiAgentMessage }
  | {
      type: "message_update";
      message: PiAgentMessage;
      assistantMessageEvent: PiAssistantMessageEvent;
    }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }
  | { type: "compaction_start"; reason?: "manual" | "threshold" | "overflow" | string }
  | { type: "compaction_end"; reason?: string; errorMessage?: string; aborted?: boolean }
  | { type: "agent_end"; messages?: PiAgentMessage[] };

export type PiRuntimeEvent =
  | PiAgentSessionEvent
  | { type: "subagent_lifecycle"; payload: PiSubagentLifecyclePayload }
  | { type: "subagent_progress"; payload: PiSubagentProgressPayload }
  | {
      type: "extension_ui_request";
      id: string;
      method: string;
      [key: string]: unknown;
    }
  | {
      type: "process_exit";
      error: string;
    };
