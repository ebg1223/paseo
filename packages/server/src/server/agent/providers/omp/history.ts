import { readFile } from "node:fs/promises";

import type { AgentProvider, AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamPiHistory, type PiCapturedUserMessageEntry } from "../pi-shared/history-mapper.js";
import type { PiAgentMessage } from "../pi-shared/rpc-types.js";
import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { asOmpRuntimeSession } from "./runtime.js";

interface OmpSessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  message?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function* streamOmpHistory(input: {
  sessionFile?: string;
  runtimeSession?: PiRuntimeSession;
  provider: AgentProvider;
}): AsyncGenerator<AgentStreamEvent> {
  if (!input.sessionFile) {
    return;
  }
  let entries: OmpSessionEntry[];
  try {
    entries = await readActiveOmpEntryChain(
      input.sessionFile,
      input.runtimeSession
        ? asOmpRuntimeSession(input.runtimeSession).activeBranchEntryId
        : undefined,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const messages: PiAgentMessage[] = [];
  const userEntries: PiCapturedUserMessageEntry[] = [];
  for (const entry of entries) {
    const mapped = mapEntryMessage(entry);
    if (!mapped) continue;
    messages.push(mapped);
    if (mapped.role === "user" && entry.id) {
      userEntries.push({ id: entry.id, text: textOf(mapped.content) });
    }
  }
  yield* streamPiHistory(input.provider, messages, userEntries, OMP_HISTORY_MAPPER_HOOKS);
}

export async function readActiveOmpEntryChain(
  sessionFile: string,
  activeEntryId?: string,
): Promise<OmpSessionEntry[]> {
  const content = await readFile(sessionFile, "utf8");
  const entries = content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as OmpSessionEntry;
      return value && typeof value === "object" && typeof value.id === "string" ? [value] : [];
    } catch {
      return [];
    }
  });
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id!, entry]));
  const parentIds = new Set(entries.flatMap((entry) => (entry.parentId ? [entry.parentId] : [])));
  const leaves = entries.filter((entry) => !parentIds.has(entry.id!));
  let current: OmpSessionEntry | undefined =
    (activeEntryId ? byId.get(activeEntryId) : undefined) ?? leaves.at(-1) ?? entries.at(-1);
  const chain: OmpSessionEntry[] = [];
  const seen = new Set<string>();
  while (current?.id && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain.toReversed();
}

function mapEntryMessage(entry: OmpSessionEntry): PiAgentMessage | null {
  const message = entry.message;
  if (message && typeof message.role === "string") {
    if (message.role === "system") {
      return null;
    }
    if (["user", "assistant", "toolResult", "custom", "bashExecution"].includes(message.role)) {
      return message as unknown as PiAgentMessage;
    }
    return visibleFallback(message.role, message);
  }
  if (!entry.type || isControlEntryType(entry.type)) {
    return null;
  }
  return visibleFallback(entry.type, entry);
}

function isControlEntryType(type: string): boolean {
  return (
    type === "session" ||
    type === "session_init" ||
    type === "system" ||
    type === "title" ||
    type === "title_change" ||
    type === "custom" ||
    type === "system_prompt" ||
    type === "model_change" ||
    type === "thinking_level_change" ||
    type === "tool_execution" ||
    type.startsWith("tool_execution_")
  );
}

function visibleFallback(role: string, value: Record<string, unknown>): PiAgentMessage {
  let text = "Unsupported history record";
  if (typeof value.content === "string") {
    text = value.content;
  } else if (typeof value.text === "string") {
    text = value.text;
  }
  return { role: "custom", content: `[${role}] ${text}` } as PiAgentMessage;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}
