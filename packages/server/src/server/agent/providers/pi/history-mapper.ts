import type { AgentStreamEvent, AgentTimelineItem, ToolCallDetail } from "../../agent-sdk-types.js";
import { mapOmpSystemNoticeToToolCall } from "./omp-system-notice.js";
import type { PiAgentMessage, PiImageContent, PiTextContent } from "./rpc-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveEmittedToolCallId,
  type PiTrackedToolCall,
} from "./tool-call-mapper.js";

export interface PiCapturedUserMessageEntry {
  id: string;
  text: string;
}

function isTextContentBlock(block: unknown): block is PiTextContent {
  return (
    typeof block === "object" &&
    block !== null &&
    !Array.isArray(block) &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
  );
}

export function getUserMessageText(content: string | (PiTextContent | PiImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (isTextContentBlock(block)) {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n\n");
}

export class PiHistoryMapper {
  private readonly pendingToolCalls = new Map<string, PiTrackedToolCall>();
  private userIndex = 0;

  constructor(
    private readonly provider: string,
    private readonly userEntries: readonly PiCapturedUserMessageEntry[] = [],
  ) {}

  mapMessages(messages: readonly PiAgentMessage[]): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];

    for (const message of messages) {
      if (message.role === "user") {
        const text = getUserMessageText(message.content);
        if (text) {
          const userEntry = this.userEntries[this.userIndex];
          events.push({
            type: "timeline",
            provider: this.provider,
            item: {
              type: "user_message",
              text,
              ...(userEntry ? { messageId: userEntry.id } : {}),
            },
          });
        }
        this.userIndex += 1;
        continue;
      }

      if (message.role === "custom") {
        const item = toCustomMessageTimelineItem(getUserMessageText(message.content));
        if (item) {
          events.push({ type: "timeline", provider: this.provider, item });
        }
        continue;
      }

      if (message.role === "assistant") {
        for (const content of message.content) {
          if (content.type === "text" && content.text) {
            events.push({
              type: "timeline",
              provider: this.provider,
              item: { type: "assistant_message", text: content.text },
            });
            continue;
          }

          if (content.type === "thinking" && content.thinking) {
            events.push({
              type: "timeline",
              provider: this.provider,
              item: { type: "reasoning", text: content.thinking },
            });
            continue;
          }

          if (content.type === "toolCall") {
            const tracked = parseToolArgs(content.name, content.arguments);
            this.pendingToolCalls.set(content.id, tracked);
            const emittedCallId = resolveEmittedToolCallId(content.id, tracked);
            events.push({
              type: "timeline",
              provider: this.provider,
              item: {
                type: "tool_call",
                callId: emittedCallId,
                name: tracked.toolName,
                status: "running",
                detail: mapToolDetail(tracked, null),
                error: null,
              },
            });
          }
        }
        continue;
      }

      if (message.role === "toolResult") {
        const tracked =
          this.pendingToolCalls.get(message.toolCallId) ?? parseToolArgs(message.toolName, null);
        this.pendingToolCalls.delete(message.toolCallId);
        const result = parseToolResult({ content: message.content });
        const detail = mapToolDetail(tracked, result);
        events.push({
          type: "timeline",
          provider: this.provider,
          item: toToolResultTimelineItem({
            callId: resolveEmittedToolCallId(message.toolCallId, tracked),
            name: tracked.toolName,
            isError: Boolean(message.isError),
            detail,
            errorText: extractTextFromToolResult(result) ?? "Tool call failed",
          }),
        });
        continue;
      }

      if (message.role === "bashExecution") {
        const callId = `pi-bash-${message.timestamp}`;
        const detail: ToolCallDetail = {
          type: "shell",
          command: message.command,
          output: message.output,
          exitCode: message.exitCode ?? null,
        };
        events.push({
          type: "timeline",
          provider: this.provider,
          item: {
            type: "tool_call",
            callId,
            name: "bash",
            status: message.cancelled ? "canceled" : "completed",
            detail,
            error: null,
          },
        });
      }
    }

    return events;
  }
}

export async function* streamPiHistory(
  provider: string,
  messages: PiAgentMessage[],
  userEntries: readonly PiCapturedUserMessageEntry[] = [],
): AsyncGenerator<AgentStreamEvent> {
  const mapper = new PiHistoryMapper(provider, userEntries);
  for (const event of mapper.mapMessages(messages)) {
    yield event;
  }
}

// omp injects background-job results as custom messages; absorb them into
// synthetic tool calls instead of replaying the raw notice text. Other custom
// messages surface as assistant text, matching the live path.
function toCustomMessageTimelineItem(text: string): AgentTimelineItem | null {
  const noticeItem = mapOmpSystemNoticeToToolCall(text);
  if (noticeItem) {
    return noticeItem;
  }
  return text ? { type: "assistant_message", text } : null;
}

function toToolResultTimelineItem(input: {
  callId: string;
  name: string;
  isError: boolean;
  detail: ToolCallDetail;
  errorText: string;
}): AgentTimelineItem {
  if (input.isError) {
    return {
      type: "tool_call",
      callId: input.callId,
      name: input.name,
      status: "failed",
      detail: input.detail,
      error: input.errorText,
    };
  }
  return {
    type: "tool_call",
    callId: input.callId,
    name: input.name,
    status: "completed",
    detail: input.detail,
    error: null,
  };
}
