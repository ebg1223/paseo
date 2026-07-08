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
  setSessionName(name: string): Promise<void>;
  setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]>;
  sendHostToolResult(result: OmpRpcHostToolResult): void;
  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void;
}

export function asOmpRuntimeSession(session: PiRuntimeSession): OmpRuntimeSession {
  const existing = session as PiRuntimeSession & Partial<OmpRuntimeSession>;
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
    setSessionName: async (name: string) => setOmpSessionName(session, name),
    setHostTools: async (tools: OmpRpcHostToolDefinition[]) => setOmpHostTools(session, tools),
    sendHostToolResult: (result: OmpRpcHostToolResult) => {
      session.sendRawFrame(result);
    },
    sendHostToolUpdate: (update: OmpRpcHostToolUpdate) => {
      session.sendRawFrame(update);
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
