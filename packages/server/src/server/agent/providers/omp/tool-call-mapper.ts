import type { ToolCallDetail } from "../../agent-sdk-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail as mapPiToolDetail,
  type PiToolResult,
  type PiTrackedToolCall,
} from "../pi-shared/tool-call-mapper.js";

export function mapOmpToolDetail(
  toolCall: PiTrackedToolCall,
  result: PiToolResult,
  context?: {
    toolCallId: string;
    mapSubagentDetail?: (baseDetail: ToolCallDetail) => ToolCallDetail;
  },
): ToolCallDetail | null {
  if (toolCall.toolName === "todo") {
    return null;
  }
  if (toolCall.toolName === "task") {
    const detail = mapOmpTaskDetail(toolCall.args, result);
    return context?.mapSubagentDetail?.(detail) ?? detail;
  }
  const paseoDetail = mapPaseoHostToolDetail(toolCall, result);
  if (paseoDetail) {
    return paseoDetail;
  }
  if (toolCall.toolName === "edit") {
    return mapOmpEditDetail(toolCall, result);
  }
  if (toolCall.toolName === "read") {
    return mapOmpReadDetail(toolCall, result);
  }
  return mapPiToolDetail(toolCall, result);
}

export const PASEO_HOST_TOOL_NAMES = new Set([
  "archive_agent",
  "archive_worktree",
  "browser_back",
  "browser_click",
  "browser_close_tab",
  "browser_drag",
  "browser_evaluate",
  "browser_fill",
  "browser_forward",
  "browser_hover",
  "browser_keypress",
  "browser_list_tabs",
  "browser_logs",
  "browser_navigate",
  "browser_new_tab",
  "browser_reload",
  "browser_resize",
  "browser_screenshot",
  "browser_scroll",
  "browser_select",
  "browser_snapshot",
  "browser_type",
  "browser_upload",
  "browser_wait",
  "cancel_agent",
  "capture_terminal",
  "create_agent",
  "create_heartbeat",
  "create_schedule",
  "create_terminal",
  "create_worktree",
  "delete_schedule",
  "get_agent_activity",
  "get_agent_status",
  "inspect_provider",
  "inspect_schedule",
  "kill_agent",
  "kill_terminal",
  "list_agents",
  "list_models",
  "list_pending_permissions",
  "list_providers",
  "list_schedules",
  "list_terminals",
  "list_worktrees",
  "pause_schedule",
  "rename_workspace",
  "respond_to_permission",
  "resume_schedule",
  "schedule_logs",
  "send_agent_prompt",
  "send_terminal_keys",
  "set_agent_mode",
  "speak",
  "update_agent",
  "update_schedule",
  "wait_for_agent",
]);

function mapPaseoHostToolDetail(
  toolCall: PiTrackedToolCall,
  result: PiToolResult,
): ToolCallDetail | null {
  if (toolCall.toolName === "create_agent") {
    return mapPaseoCreateAgentDetail(toolCall.args, result);
  }
  if (!PASEO_HOST_TOOL_NAMES.has(toolCall.toolName)) {
    return null;
  }
  return {
    type: "plain_text",
    label: formatPaseoToolLabel(toolCall.toolName),
    text: formatPaseoHostToolText(toolCall.args, result),
    icon: toolCall.toolName === "speak" ? "mic_vocal" : "bot",
  };
}

function mapPaseoCreateAgentDetail(args: unknown, result: PiToolResult): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const details = resultDetails(result);
  return {
    type: "sub_agent",
    subAgentType: firstString(argRecord.provider, argRecord.model, details?.type),
    description: firstString(argRecord.title, argRecord.initialPrompt, argRecord.prompt),
    ...(firstString(details?.agentId) ? { childSessionId: firstString(details?.agentId) } : {}),
    log: extractTextFromToolResult(result)?.trim() ?? "",
  };
}

function formatPaseoHostToolText(args: unknown, result: PiToolResult): string | undefined {
  const resultText = extractTextFromToolResult(result)?.trim();
  const argSummary = summarizePaseoToolArgs(args);
  if (resultText && argSummary) {
    return `${argSummary}\n\n${resultText}`;
  }
  return resultText ?? argSummary;
}

function summarizePaseoToolArgs(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const parts = [
    firstString(args.agentId) ? `agentId=${firstString(args.agentId)}` : null,
    firstString(args.terminalId) ? `terminalId=${firstString(args.terminalId)}` : null,
    firstString(args.scheduleId) ? `scheduleId=${firstString(args.scheduleId)}` : null,
    firstString(args.browserId) ? `browserId=${firstString(args.browserId)}` : null,
    firstString(args.text),
    firstString(args.prompt),
    firstString(args.command),
    firstString(args.url),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function formatPaseoToolLabel(toolName: string): string {
  return `Paseo ${toolName.replaceAll("_", " ")}`;
}

function mapOmpTaskDetail(args: unknown, result: PiToolResult): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const resultText = extractTextFromToolResult(result);
  const childSessionId = readChildSessionId(result);
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
    ...(childSessionId ? { childSessionId } : {}),
    log: resultText?.trim() ?? "",
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

function readChildSessionId(result: PiToolResult): string | undefined {
  const details = resultDetails(result);
  const direct = firstString(details?.sessionFile, details?.session_file, details?.childSessionId);
  if (direct) {
    return direct;
  }
  const text = extractTextFromToolResult(result);
  return text?.match(/(?:session|transcript)(?: file)?:\s*(?<path>\/\S+\.jsonl)/i)?.groups?.path;
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
