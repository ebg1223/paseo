import type { ToolCallDetail } from "../../agent-sdk-types.js";
import {
  mapToolDetail as mapPiToolDetail,
  type PiToolResult,
  type PiTrackedToolCall,
} from "../pi-shared/tool-call-mapper.js";

export function mapOmpToolDetail(
  toolCall: PiTrackedToolCall,
  result: PiToolResult,
): ToolCallDetail | null {
  if (toolCall.toolName === "todo") {
    return null;
  }
  if (toolCall.toolName === "task") {
    return mapOmpTaskDetail(toolCall.args);
  }
  if (toolCall.toolName === "edit") {
    return mapOmpEditDetail(toolCall, result);
  }
  if (toolCall.toolName === "read") {
    return mapOmpReadDetail(toolCall, result);
  }
  return mapPiToolDetail(toolCall, result);
}

function mapOmpTaskDetail(args: unknown): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  return {
    type: "sub_agent",
    subAgentType: firstString(
      argRecord.agent,
      argRecord.subAgentType,
      argRecord.agentType,
      argRecord.type,
    ),
    description: firstString(
      argRecord.description,
      argRecord.task,
      argRecord.prompt,
      argRecord.assignment,
    ),
    log: "",
  };
}

function mapOmpEditDetail(toolCall: PiTrackedToolCall, result: PiToolResult): ToolCallDetail {
  const fallback = mapPiToolDetail(toolCall, result);
  const details = resultDetails(result);
  const filePath =
    firstString(details?.path, details?.filePath) ?? readPatchInputPath(toolCall.args);
  if (!filePath) {
    return fallback;
  }
  return {
    type: "edit",
    filePath,
    oldString: firstString(details?.oldText, details?.old_string),
    newString: firstString(details?.newText, details?.new_string),
    unifiedDiff: firstString(details?.diff),
  };
}

function mapOmpReadDetail(toolCall: PiTrackedToolCall, result: PiToolResult): ToolCallDetail {
  const fallback = mapPiToolDetail(toolCall, result);
  if (fallback.type !== "read") {
    return fallback;
  }
  const details = resultDetails(result);
  const displayContent = isRecord(details?.displayContent) ? details.displayContent : null;
  const displayText = firstString(displayContent?.text);
  if (!displayText) {
    return fallback;
  }
  return {
    ...fallback,
    content: displayText,
  };
}

function resultDetails(result: PiToolResult): Record<string, unknown> | null {
  if (typeof result === "string" || result === null) {
    return null;
  }
  return isRecord(result.details) ? result.details : null;
}

function readPatchInputPath(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const input = args.input;
  if (typeof input !== "string") {
    return undefined;
  }
  const match = /^\[(?<path>.+?)#[^\]\n]+]/m.exec(input);
  return match?.groups?.path;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
