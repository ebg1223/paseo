import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import type { OmpSubagentSubscriptionLevel } from "./rpc-types.js";

export interface OmpRuntimeSession extends PiRuntimeSession {
  setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void>;
  branch(entryId: string): Promise<{ text: string }>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  activeBranchEntryId?: string;
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
  if (existing.setSubagentSubscription) {
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
    branch: existing.branch,
    getBranchMessages: existing.getBranchMessages,
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
