import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import type { OmpSubagentStatus } from "./rpc-types.js";

export type OmpTerminalSubagentStatus = "completed" | "failed" | "aborted";

export interface OmpLiveSubagentEntry {
  subagentId: string;
  status: OmpSubagentStatus;
  parentRuntime: PiRuntimeSession;
  title?: string;
}

export type OmpSubagentIndexEvent =
  | { type: "progress"; entry: OmpLiveSubagentEntry }
  | { type: "terminal"; status: OmpTerminalSubagentStatus };

type OmpSubagentIndexSubscriber = (event: OmpSubagentIndexEvent) => void;

export class OmpSubagentIndex {
  private readonly liveBySessionFile = new Map<string, OmpLiveSubagentEntry>();
  private readonly subscribersBySessionFile = new Map<string, Set<OmpSubagentIndexSubscriber>>();

  get(sessionFile: string): OmpLiveSubagentEntry | null {
    return this.liveBySessionFile.get(sessionFile) ?? null;
  }

  upsert(input: {
    sessionFile: string;
    subagentId: string;
    status: OmpSubagentStatus;
    parentRuntime: PiRuntimeSession;
    title?: string;
  }): void {
    const existing = this.liveBySessionFile.get(input.sessionFile);
    const title = input.title ?? existing?.title;
    const entry: OmpLiveSubagentEntry = {
      subagentId: input.subagentId,
      status: input.status,
      parentRuntime: input.parentRuntime,
      ...(title ? { title } : {}),
    };
    this.liveBySessionFile.set(input.sessionFile, entry);
  }

  updateProgress(input: {
    sessionFile: string;
    subagentId: string;
    status: OmpSubagentStatus;
    parentRuntime: PiRuntimeSession;
    title?: string;
  }): void {
    this.upsert(input);
    const entry = this.liveBySessionFile.get(input.sessionFile);
    if (entry) {
      this.notify(input.sessionFile, { type: "progress", entry });
    }
  }

  terminal(sessionFile: string, status: OmpTerminalSubagentStatus): void {
    if (!this.liveBySessionFile.has(sessionFile)) {
      return;
    }
    this.notify(sessionFile, { type: "terminal", status });
    this.liveBySessionFile.delete(sessionFile);
  }

  clearParent(parentRuntime: PiRuntimeSession): void {
    const sessionFiles: string[] = [];
    for (const [sessionFile, entry] of this.liveBySessionFile.entries()) {
      if (entry.parentRuntime === parentRuntime) {
        sessionFiles.push(sessionFile);
      }
    }
    for (const sessionFile of sessionFiles) {
      this.terminal(sessionFile, "aborted");
    }
  }

  subscribe(sessionFile: string, subscriber: OmpSubagentIndexSubscriber): () => void {
    const subscribers = this.subscribersBySessionFile.get(sessionFile) ?? new Set();
    subscribers.add(subscriber);
    this.subscribersBySessionFile.set(sessionFile, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        this.subscribersBySessionFile.delete(sessionFile);
      }
    };
  }

  private notify(sessionFile: string, event: OmpSubagentIndexEvent): void {
    const subscribers = this.subscribersBySessionFile.get(sessionFile);
    if (!subscribers) {
      return;
    }
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }
}

export function isTerminalOmpSubagentStatus(
  status: OmpSubagentStatus,
): status is OmpTerminalSubagentStatus {
  return status === "completed" || status === "failed" || status === "aborted";
}
