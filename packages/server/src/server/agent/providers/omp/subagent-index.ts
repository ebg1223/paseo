import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import type { OmpSubagentStatus } from "./rpc-types.js";

export type OmpTerminalSubagentStatus = "completed" | "failed" | "aborted";

export interface OmpLiveSubagentEntry {
  sessionFile: string;
  subagentId: string;
  status: OmpSubagentStatus;
  parentRuntime: PiRuntimeSession;
  ownership: "provider" | "released";
  title?: string;
  model?: string;
  classifyRelease?: () => Promise<{ resumable: boolean; reason: string }>;
  releaseClassification?: { resumable: boolean; reason: string };
  emitOwnership?: (entry: OmpLiveSubagentEntry) => void | Promise<void>;
}

export type OmpSubagentIndexEvent =
  | { type: "progress"; entry: OmpLiveSubagentEntry }
  | { type: "terminal"; status: OmpTerminalSubagentStatus }
  | { type: "released"; entry: OmpLiveSubagentEntry };

type OmpSubagentIndexSubscriber = (event: OmpSubagentIndexEvent) => void | Promise<void>;

interface OmpSubagentUpsertInput {
  sessionFile: string;
  subagentId: string;
  status: OmpSubagentStatus;
  parentRuntime: PiRuntimeSession;
  title?: string;
  model?: string;
  classifyRelease?: () => Promise<{ resumable: boolean; reason: string }>;
  emitOwnership?: (entry: OmpLiveSubagentEntry) => void | Promise<void>;
}

function buildLiveEntry(
  input: OmpSubagentUpsertInput,
  existing: OmpLiveSubagentEntry | undefined,
): OmpLiveSubagentEntry {
  const title = input.title ?? existing?.title;
  const model = input.model ?? existing?.model;
  const classifyRelease = input.classifyRelease ?? existing?.classifyRelease;
  const emitOwnership = input.emitOwnership ?? existing?.emitOwnership;
  return {
    sessionFile: input.sessionFile,
    subagentId: input.subagentId,
    status: input.status,
    parentRuntime: input.parentRuntime,
    ownership: "provider",
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(classifyRelease ? { classifyRelease } : {}),
    ...(emitOwnership ? { emitOwnership } : {}),
  };
}

export class OmpSubagentIndex {
  private readonly entriesByParent = new WeakMap<
    PiRuntimeSession,
    Map<string, OmpLiveSubagentEntry>
  >();
  private readonly entriesBySessionFile = new Map<string, Set<OmpLiveSubagentEntry>>();
  private readonly subscribersByEntry = new WeakMap<
    PiRuntimeSession,
    Map<string, Set<OmpSubagentIndexSubscriber>>
  >();
  private readonly releasingParents = new WeakMap<
    PiRuntimeSession,
    Promise<OmpLiveSubagentEntry[]>
  >();
  private readonly releasedParents = new WeakSet<PiRuntimeSession>();
  private readonly historicalSessionFiles = new Set<string>();

  recordHistorical(sessionFile: string): void {
    this.historicalSessionFiles.add(sessionFile);
  }

  isHistorical(sessionFile: string): boolean {
    return this.historicalSessionFiles.has(sessionFile);
  }

  get(sessionFile: string): OmpLiveSubagentEntry | null {
    const entries = this.entriesBySessionFile.get(sessionFile);
    if (!entries || entries.size !== 1) {
      return null;
    }
    return entries.values().next().value ?? null;
  }

  getForParent(parentRuntime: PiRuntimeSession, sessionFile: string): OmpLiveSubagentEntry | null {
    return this.entriesByParent.get(parentRuntime)?.get(sessionFile) ?? null;
  }

  upsert(input: OmpSubagentUpsertInput): void {
    if (
      this.historicalSessionFiles.has(input.sessionFile) ||
      this.releasingParents.has(input.parentRuntime) ||
      this.releasedParents.has(input.parentRuntime)
    ) {
      return;
    }
    const parentEntries = this.entriesByParent.get(input.parentRuntime) ?? new Map();
    const existing = parentEntries.get(input.sessionFile);
    if (
      existing?.ownership === "released" ||
      (existing && isTerminalOmpSubagentStatus(existing.status))
    ) {
      return;
    }
    const entry = buildLiveEntry(input, existing);
    if (existing) {
      this.entriesBySessionFile.get(input.sessionFile)?.delete(existing);
    }
    parentEntries.set(input.sessionFile, entry);
    this.entriesByParent.set(input.parentRuntime, parentEntries);
    const byFile = this.entriesBySessionFile.get(input.sessionFile) ?? new Set();
    byFile.add(entry);
    this.entriesBySessionFile.set(input.sessionFile, byFile);
  }

  updateProgress(input: OmpSubagentUpsertInput): void {
    const existing = this.getForParent(input.parentRuntime, input.sessionFile);
    if (existing && isTerminalOmpSubagentStatus(existing.status)) {
      return;
    }
    this.upsert(input);
    const entry = this.getForParent(input.parentRuntime, input.sessionFile);
    if (entry?.ownership === "provider" && !isTerminalOmpSubagentStatus(entry.status)) {
      this.notify(input.parentRuntime, input.sessionFile, { type: "progress", entry });
    }
  }

  terminal(
    parentRuntime: PiRuntimeSession,
    sessionFile: string,
    status: OmpTerminalSubagentStatus,
  ): void {
    const entry = this.getForParent(parentRuntime, sessionFile);
    if (!entry || entry.ownership !== "provider" || isTerminalOmpSubagentStatus(entry.status)) {
      return;
    }
    entry.status = status;
    this.notify(parentRuntime, sessionFile, { type: "terminal", status });
  }

  async releaseParent(parentRuntime: PiRuntimeSession): Promise<OmpLiveSubagentEntry[]> {
    const inFlight = this.releasingParents.get(parentRuntime);
    if (inFlight) {
      return await inFlight;
    }
    if (this.releasedParents.has(parentRuntime)) {
      return [];
    }
    const release = this.releaseParentOnce(parentRuntime);
    this.releasingParents.set(parentRuntime, release);
    try {
      const released = await release;
      this.releasedParents.add(parentRuntime);
      return released;
    } finally {
      this.releasingParents.delete(parentRuntime);
    }
  }

  private async releaseParentOnce(
    parentRuntime: PiRuntimeSession,
  ): Promise<OmpLiveSubagentEntry[]> {
    const entries = this.entriesByParent.get(parentRuntime);
    if (!entries) {
      return [];
    }
    const released: OmpLiveSubagentEntry[] = [];
    for (const [sessionFile, entry] of entries) {
      if (entry.ownership === "released") {
        continue;
      }
      entry.ownership = "released";
      released.push(entry);
      entry.releaseClassification = await entry.classifyRelease?.();
      await this.notify(parentRuntime, sessionFile, { type: "released", entry });
      await entry.emitOwnership?.(entry);
      this.entriesBySessionFile.get(sessionFile)?.delete(entry);
      if (this.entriesBySessionFile.get(sessionFile)?.size === 0) {
        this.entriesBySessionFile.delete(sessionFile);
      }
    }
    this.entriesByParent.delete(parentRuntime);
    this.subscribersByEntry.delete(parentRuntime);
    return released;
  }

  subscribe(
    parentRuntime: PiRuntimeSession,
    sessionFile: string,
    subscriber: OmpSubagentIndexSubscriber,
  ): () => void {
    const byFile = this.subscribersByEntry.get(parentRuntime) ?? new Map();
    const subscribers = byFile.get(sessionFile) ?? new Set();
    subscribers.add(subscriber);
    byFile.set(sessionFile, subscribers);
    this.subscribersByEntry.set(parentRuntime, byFile);
    const entry = this.getForParent(parentRuntime, sessionFile);
    if (entry && isTerminalOmpSubagentStatus(entry.status)) {
      void subscriber({ type: "terminal", status: entry.status });
    }
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        byFile.delete(sessionFile);
      }
    };
  }

  private async notify(
    parentRuntime: PiRuntimeSession,
    sessionFile: string,
    event: OmpSubagentIndexEvent,
  ): Promise<void> {
    const subscribers = this.subscribersByEntry.get(parentRuntime)?.get(sessionFile);
    if (!subscribers) {
      return;
    }
    await Promise.all([...subscribers].map(async (subscriber) => await subscriber(event)));
  }
}

export function isTerminalOmpSubagentStatus(
  status: OmpSubagentStatus,
): status is OmpTerminalSubagentStatus {
  return status === "completed" || status === "failed" || status === "aborted";
}
