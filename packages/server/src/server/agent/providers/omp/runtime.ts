import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import type {
  OmpRpcHostToolDefinition,
  OmpRpcHostToolResult,
  OmpRpcHostToolUpdate,
  OmpSubagentMessagesResult,
  OmpSubagentMessagesSelector,
  OmpSubagentSnapshot,
  OmpSubagentSubscriptionLevel,
} from "./rpc-types.js";

export interface OmpRuntimeSession extends PiRuntimeSession {
  setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void>;
  getSubagents(): Promise<OmpSubagentSnapshot[]>;
  getSubagentMessages(selector: OmpSubagentMessagesSelector): Promise<OmpSubagentMessagesResult>;
  branch(entryId: string): Promise<{ text: string }>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  activeBranchEntryId?: string;
  setSessionName(name: string): Promise<void>;
  setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]>;
  sendHostToolResult(result: OmpRpcHostToolResult): void;
  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void;
  steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): void;
  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void;
}

export function asOmpRuntimeSession(session: PiRuntimeSession): OmpRuntimeSession {
  const existing = session as PiRuntimeSession & Partial<OmpRuntimeSession>;
  existing.branch ??= async (entryId: string) => {
    const data = (await session.request({ type: "branch", entryId })) as {
      text?: unknown;
      cancelled?: unknown;
    };
    if (data.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof data.text !== "string") {
      throw new Error("OMP branch response did not include restored prompt text");
    }
    existing.activeBranchEntryId = entryId;
    return { text: data.text };
  };
  existing.getBranchMessages ??= async () => {
    const data = (await session.request({ type: "get_branch_messages" })) as {
      messages?: Array<{ entryId: string; text: string }>;
    };
    return data.messages ?? [];
  };
  if (existing.setSubagentSubscription && existing.getSubagents && existing.getSubagentMessages) {
    existing.setSessionName ??= async (name: string) => setOmpSessionName(session, name);
    existing.setHostTools ??= async (tools: OmpRpcHostToolDefinition[]) =>
      setOmpHostTools(session, tools);
    existing.sendHostToolResult ??= (result: OmpRpcHostToolResult) => {
      session.sendRawFrame(result);
    };
    existing.sendHostToolUpdate ??= (update: OmpRpcHostToolUpdate) => {
      session.sendRawFrame(update);
    };
    existing.steer ??= (message, images) => {
      session.sendRawFrame({
        type: "steer",
        message,
        ...(images?.length ? { images } : {}),
      } as object & { type: string });
    };
    existing.followUp ??= (message, images) => {
      session.sendRawFrame({
        type: "follow_up",
        message,
        ...(images?.length ? { images } : {}),
      } as object & { type: string });
    };
    return existing as OmpRuntimeSession;
  }
  return Object.assign(session, {
    setSubagentSubscription: async (level: OmpSubagentSubscriptionLevel) => {
      await session.request({ type: "set_subagent_subscription", level });
    },
    getSubagents: async () => {
      const data = (await session.request({ type: "get_subagents" })) as {
        subagents?: OmpSubagentSnapshot[];
      };
      return data.subagents ?? [];
    },
    getSubagentMessages: async (selector: OmpSubagentMessagesSelector) =>
      (await session.request({
        type: "get_subagent_messages",
        ...selector,
      })) as OmpSubagentMessagesResult,
    branch: async (entryId: string) => {
      const data = (await session.request({ type: "branch", entryId })) as {
        text?: unknown;
        cancelled?: unknown;
      };
      if (data.cancelled === true) {
        throw new Error("OMP branch was cancelled");
      }
      if (typeof data.text !== "string") {
        throw new Error("OMP branch response did not include restored prompt text");
      }
      (session as OmpRuntimeSession).activeBranchEntryId = entryId;
      return { text: data.text };
    },
    getBranchMessages: async () => {
      const data = (await session.request({ type: "get_branch_messages" })) as {
        messages?: Array<{ entryId: string; text: string }>;
      };
      return data.messages ?? [];
    },
    setSessionName: async (name: string) => setOmpSessionName(session, name),
    setHostTools: async (tools: OmpRpcHostToolDefinition[]) => setOmpHostTools(session, tools),
    sendHostToolResult: (result: OmpRpcHostToolResult) => {
      session.sendRawFrame(result);
    },
    sendHostToolUpdate: (update: OmpRpcHostToolUpdate) => {
      session.sendRawFrame(update);
    },
    steer: (message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>) => {
      session.sendRawFrame({
        type: "steer",
        message,
        ...(images?.length ? { images } : {}),
      } as object & { type: string });
    },
    followUp: (
      message: string,
      images?: Array<{ type: "image"; data: string; mimeType: string }>,
    ) => {
      session.sendRawFrame({
        type: "follow_up",
        message,
        ...(images?.length ? { images } : {}),
      } as object & { type: string });
    },
  });
}

async function setOmpSessionName(session: PiRuntimeSession, name: string): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return;
  }
  await session.request({ type: "set_session_name", name: trimmedName });
}

async function setOmpHostTools(
  session: PiRuntimeSession,
  tools: OmpRpcHostToolDefinition[],
): Promise<string[]> {
  const data = (await session.request({ type: "set_host_tools", tools })) as {
    toolNames?: string[];
  };
  return data.toolNames ?? [];
}
