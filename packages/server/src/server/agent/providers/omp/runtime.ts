import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import type {
  OmpSubagentMessagesResult,
  OmpSubagentMessagesSelector,
  OmpSubagentSnapshot,
  OmpSubagentSubscriptionLevel,
} from "./rpc-types.js";

export interface OmpRuntimeSession extends PiRuntimeSession {
  setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void>;
  getSubagents(): Promise<OmpSubagentSnapshot[]>;
  getSubagentMessages(selector: OmpSubagentMessagesSelector): Promise<OmpSubagentMessagesResult>;
}

export function asOmpRuntimeSession(session: PiRuntimeSession): OmpRuntimeSession {
  const existing = session as PiRuntimeSession & Partial<OmpRuntimeSession>;
  if (existing.setSubagentSubscription && existing.getSubagents && existing.getSubagentMessages) {
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
  });
}
