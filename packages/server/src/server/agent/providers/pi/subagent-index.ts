import type { PiRuntimeSession } from "./runtime.js";
import type { PiSubagentStatus } from "./rpc-types.js";

export type PiTerminalSubagentStatus = "completed" | "failed" | "aborted";

export interface PiLiveSubagentEntry {
  subagentId: string;
  status: PiSubagentStatus;
  parentRuntime: PiRuntimeSession;
  title?: string;
}

export type PiSubagentIndexEvent =
  | { type: "progress"; entry: PiLiveSubagentEntry }
  | { type: "terminal"; status: PiTerminalSubagentStatus };

type PiSubagentIndexSubscriber = (event: PiSubagentIndexEvent) => void;

export class PiSubagentIndex {
  private readonly liveBySessionFile = new Map<string, PiLiveSubagentEntry>();
  private readonly subscribersBySessionFile = new Map<string, Set<PiSubagentIndexSubscriber>>();

  get(sessionFile: string): PiLiveSubagentEntry | null {
    return this.liveBySessionFile.get(sessionFile) ?? null;
  }

  upsert(input: {
    sessionFile: string;
    subagentId: string;
    status: PiSubagentStatus;
    parentRuntime: PiRuntimeSession;
    title?: string;
  }): void {
    const existing = this.liveBySessionFile.get(input.sessionFile);
    const title = input.title ?? existing?.title;
    const entry: PiLiveSubagentEntry = {
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
    status: PiSubagentStatus;
    parentRuntime: PiRuntimeSession;
    title?: string;
  }): void {
    this.upsert(input);
    const entry = this.liveBySessionFile.get(input.sessionFile);
    if (entry) {
      this.notify(input.sessionFile, { type: "progress", entry });
    }
  }

  terminal(sessionFile: string, status: PiTerminalSubagentStatus): void {
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

  subscribe(sessionFile: string, subscriber: PiSubagentIndexSubscriber): () => void {
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

  private notify(sessionFile: string, event: PiSubagentIndexEvent): void {
    const subscribers = this.subscribersBySessionFile.get(sessionFile);
    if (!subscribers) {
      return;
    }
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }
}

export function isTerminalPiSubagentStatus(
  status: PiSubagentStatus,
): status is PiTerminalSubagentStatus {
  return status === "completed" || status === "failed" || status === "aborted";
}
