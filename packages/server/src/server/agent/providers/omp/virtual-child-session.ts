import { access, readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPermissionResult,
  AgentPromptInput,
  AgentProvider,
  AgentProviderNotice,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  ImportedTimelineEntry,
} from "../../agent-sdk-types.js";
import { PiHistoryMapper, streamPiHistory } from "../pi-shared/history-mapper.js";
import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { streamOmpHistory } from "./history.js";
import type { OmpSubagentMessagesResult } from "./rpc-types.js";
import { asOmpRuntimeSession } from "./runtime.js";
import type {
  OmpSubagentIndex,
  OmpSubagentIndexEvent,
  OmpTerminalSubagentStatus,
} from "./subagent-index.js";

interface OmpVirtualChildSessionOptions {
  provider: AgentProvider;
  sessionFile: string;
  index: OmpSubagentIndex;
  parentRuntime: PiRuntimeSession;
  initialMessages: OmpSubagentMessagesResult;
  persistence: AgentPersistenceHandle;
  config: AgentSessionConfig;
  capabilities: AgentCapabilityFlags;
  resumeSession: (
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ) => Promise<AgentSession>;
  launchContext?: AgentLaunchContext;
  logger: Logger;
}

export class OmpVirtualChildSession implements AgentSession {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingEvents: AgentStreamEvent[] = [];
  private readonly initialTimeline: ImportedTimelineEntry[];
  private readonly unsubscribeIndex: () => void;
  private readonly sessionFile: string;
  private readonly index: OmpSubagentIndex;
  private readonly parentRuntime: PiRuntimeSession;
  private readonly persistence: AgentPersistenceHandle;
  private readonly config: AgentSessionConfig;
  private readonly resumeSession: OmpVirtualChildSessionOptions["resumeSession"];
  private readonly launchContext?: AgentLaunchContext;
  private readonly logger: Logger;
  private delegate: AgentSession | null = null;
  private unsubscribeDelegate: (() => void) | null = null;
  private closed = false;
  private mapper: PiHistoryMapper;
  private emittedTimelineCount = 0;
  private fromByte: number;
  private fetchChain: Promise<void> = Promise.resolve();
  private promotionPromise: Promise<void> | null = null;
  private promotionError: Error | null = null;
  private hasAttachedSubscriber = false;
  private lastReportedLiveModel: string | null = null;
  private released = false;
  private turnEnded = false;
  private resumable = false;
  private nonResumableReason = "Pi subagent is still owned by its parent session";

  constructor(options: OmpVirtualChildSessionOptions) {
    this.provider = options.provider;
    this.capabilities = options.capabilities;
    this.sessionFile = options.sessionFile;
    this.index = options.index;
    this.parentRuntime = options.parentRuntime;
    this.persistence = options.persistence;
    this.config = options.config;
    this.resumeSession = options.resumeSession;
    this.launchContext = options.launchContext;
    this.logger = options.logger;
    this.mapper = new PiHistoryMapper(options.provider, [], OMP_HISTORY_MAPPER_HOOKS);
    this.fromByte = options.initialMessages.nextByte;

    const initialEvents = this.mapNewEvents(options.initialMessages.messages, { reset: false });
    this.initialTimeline = collectTimeline(initialEvents);
    this.unsubscribeIndex = options.index.subscribe(
      options.parentRuntime,
      options.sessionFile,
      (event) => this.handleIndexEvent(event),
    );
    if (
      options.index.getForParent(options.parentRuntime, options.sessionFile)?.ownership ===
      "provider"
    ) {
      this.emit({ type: "turn_started", provider: this.provider });
    } else {
      void this.handleRelease();
    }
  }

  get id(): string | null {
    return this.delegate?.id ?? null;
  }

  get features(): AgentFeature[] | undefined {
    return this.delegate?.features;
  }

  getInitialTimeline(): ImportedTimelineEntry[] {
    return this.initialTimeline;
  }
  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    await this.promoteAfterRelease();
    if (this.delegate) {
      return await this.delegate.run(prompt, options);
    }
    throw this.readOnlyError();
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    await this.promoteAfterRelease();
    if (this.delegate) {
      return await this.delegate.startTurn(prompt, options);
    }
    throw this.readOnlyError();
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    const shouldFlushPendingEvents = !this.hasAttachedSubscriber;
    this.hasAttachedSubscriber = true;
    this.subscribers.add(callback);
    if (shouldFlushPendingEvents) {
      const pendingEvents = this.pendingEvents.splice(0);
      for (const event of pendingEvents) {
        callback(event);
      }
    }
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (this.delegate) {
      yield* this.delegate.streamHistory();
      return;
    }
    if (this.released) {
      yield* streamOmpHistory({ sessionFile: this.sessionFile, provider: this.provider });
      return;
    }
    const result = await asOmpRuntimeSession(this.parentRuntime).getSubagentMessages({
      sessionFile: this.sessionFile,
      fromByte: 0,
    });
    yield* streamPiHistory(this.provider, result.messages, [], OMP_HISTORY_MAPPER_HOOKS);
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const delegate = await this.promotedDelegate();
    if (delegate) {
      return await delegate.getRuntimeInfo();
    }
    return this.liveRuntimeInfo();
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    const delegate = await this.promotedDelegate();
    if (delegate) {
      return await delegate.getAvailableModes();
    }
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    const delegate = await this.promotedDelegate();
    if (delegate) {
      return await delegate.getCurrentMode();
    }
    return null;
  }

  async setMode(modeId: string): Promise<void | AgentProviderNotice> {
    const delegate = await this.promotedDelegate();
    if (delegate) {
      return await delegate.setMode(modeId);
    }
    void modeId;
    throw new Error("Pi does not expose selectable modes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.delegate?.getPendingPermissions() ?? [];
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    const delegate = await this.promotedDelegate();
    if (delegate) {
      return await delegate.respondToPermission(requestId, response);
    }
    void response;
    throw new Error(`No pending permission request with id '${requestId}'`);
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.delegate?.describePersistence() ?? this.persistence;
  }

  async interrupt(): Promise<void> {
    await (await this.promotedDelegate())?.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeIndex();
    this.unsubscribeDelegate?.();
    await this.delegate?.close();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const delegate = await this.promotedDelegate();
    if (!delegate?.listCommands) {
      return [];
    }
    return await delegate.listCommands();
  }

  async setModel(modelId: string | null): Promise<void> {
    const delegate = await this.promotedDelegate();
    if (delegate?.setModel) {
      await delegate.setModel(modelId);
      return;
    }
    throw this.readOnlyError();
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void | AgentProviderNotice> {
    const delegate = await this.promotedDelegate();
    if (delegate?.setThinkingOption) {
      return await delegate.setThinkingOption(thinkingOptionId);
    }
    throw this.readOnlyError();
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    const delegate = await this.promotedDelegate();
    if (delegate?.setFeature) {
      await delegate.setFeature(featureId, value);
      return;
    }
    throw this.readOnlyError();
  }

  async revertConversation(input: { messageId: string }): Promise<void> {
    const delegate = await this.promotedDelegate();
    if (delegate?.revertConversation) {
      await delegate.revertConversation(input);
      return;
    }
    throw this.readOnlyError();
  }

  async revertFiles(input: { messageId: string }): Promise<void> {
    const delegate = await this.promotedDelegate();
    if (delegate?.revertFiles) {
      await delegate.revertFiles(input);
      return;
    }
    throw this.readOnlyError();
  }

  async revertBoth(input: { messageId: string }): Promise<void> {
    const delegate = await this.promotedDelegate();
    if (delegate?.revertBoth) {
      await delegate.revertBoth(input);
      return;
    }
    throw this.readOnlyError();
  }

  tryHandleOutOfBand(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null {
    return this.delegate?.tryHandleOutOfBand?.(prompt) ?? null;
  }

  private handleIndexEvent(event: OmpSubagentIndexEvent): void | Promise<void> {
    if (event.type === "progress") {
      this.reportLiveModelIfChanged(event.entry.model ?? null);
      void this.queueFetch();
      return;
    }
    if (event.type === "released") {
      return this.handleRelease(event.entry.releaseClassification);
    }
    void this.finishTerminal(event.status);
  }

  private async finishTerminal(status: OmpTerminalSubagentStatus): Promise<void> {
    await this.queueFetch();
    if (!this.closed) {
      this.emitTurnEnd(status);
    }
  }

  private async handleRelease(classification?: {
    resumable: boolean;
    reason: string;
  }): Promise<void> {
    if (this.released) {
      return;
    }
    await this.queueFetch();
    const resolvedClassification =
      classification ?? (await classifyReleasedOmpChild(this.sessionFile, this.config.cwd));
    this.released = true;
    this.resumable = resolvedClassification.resumable;
    this.nonResumableReason = resolvedClassification.reason;
    if (!this.closed && !this.turnEnded) {
      this.turnEnded = true;
      this.emit({
        type: "turn_canceled",
        provider: this.provider,
        reason: "OMP parent session exited",
      });
    }
    this.unsubscribeIndex();
  }

  private emitTurnEnd(status: OmpTerminalSubagentStatus): void {
    this.turnEnded = true;
    if (status === "failed") {
      this.emit({ type: "turn_failed", provider: this.provider, error: "Pi subagent failed" });
      return;
    }
    if (status === "aborted") {
      this.emit({ type: "turn_canceled", provider: this.provider, reason: "Pi subagent aborted" });
      return;
    }
    this.emit({ type: "turn_completed", provider: this.provider });
  }

  private queueFetch(): Promise<void> {
    const next = this.fetchChain.then(() => this.fetchIncrement());
    this.fetchChain = next.catch((error: unknown) => {
      this.logger.debug(
        { err: error, sessionFile: this.sessionFile },
        "Pi subagent transcript fetch failed",
      );
    });
    return this.fetchChain;
  }

  private async fetchIncrement(): Promise<void> {
    if (this.closed || this.delegate) {
      return;
    }
    const result = await asOmpRuntimeSession(this.parentRuntime).getSubagentMessages({
      sessionFile: this.sessionFile,
      fromByte: this.fromByte,
    });
    if (result.reset) {
      // The parent detected transcript truncation and restarted from byte 0.
      // Rebuild mapper state from the replay and skip the timeline prefix that
      // was already emitted. Resets are rare; if the old prefix changed, the
      // virtual session keeps the existing UI rows until promotion hydrates the
      // final standalone session.
      this.mapper = new PiHistoryMapper(this.provider, [], OMP_HISTORY_MAPPER_HOOKS);
      this.fromByte = 0;
    }
    this.fromByte = result.nextByte;
    this.emitMappedEvents(this.mapNewEvents(result.messages, { reset: result.reset }));
  }

  private async promoteAfterRelease(): Promise<void> {
    if (!this.released || !this.resumable || this.delegate) {
      return;
    }
    if (!this.promotionPromise) {
      this.promotionPromise = this.promoteOnce();
    }
    await this.promotionPromise;
  }

  private async promoteOnce(): Promise<void> {
    if (!this.released || !this.resumable) {
      return;
    }
    if (this.closed || this.delegate) {
      return;
    }
    try {
      const delegate = await this.resumeSession(this.persistence, this.config, this.launchContext);
      if (this.closed) {
        await delegate.close();
        return;
      }
      this.delegate = delegate;
      this.unsubscribeDelegate = delegate.subscribe((event) => {
        this.emit(event);
      });
    } catch (error) {
      this.promotionError = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        { err: error, sessionFile: this.sessionFile },
        "Pi virtual subagent promotion failed",
      );
    }
  }

  private async promotedDelegate(): Promise<AgentSession | null> {
    if (this.delegate) {
      return this.delegate;
    }
    return null;
  }

  private mapNewEvents(
    messages: OmpSubagentMessagesResult["messages"],
    options: { reset: boolean },
  ): AgentStreamEvent[] {
    const events = this.mapper.mapMessages(messages);
    if (options.reset) {
      const visibleEvents = events.slice(this.emittedTimelineCount);
      this.emittedTimelineCount = events.length;
      return visibleEvents;
    }
    this.emittedTimelineCount += events.length;
    return events;
  }

  private emitMappedEvents(events: AgentStreamEvent[]): void {
    for (const event of events) {
      this.emit(event);
    }
  }

  private emit(event: AgentStreamEvent): void {
    if (!this.hasAttachedSubscriber && this.subscribers.size === 0) {
      this.pendingEvents.push(event);
      return;
    }
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private readOnlyError(): Error {
    if (!this.released) {
      return new Error("Pi subagent is driven by its parent session until it finishes");
    }
    if (!this.resumable) {
      return new Error(`Pi subagent is read-only: ${this.nonResumableReason}`);
    }
    if (this.promotionError) {
      return new Error(
        `Pi subagent was released, but Paseo could not resume it: ${this.promotionError.message}`,
      );
    }
    return new Error("Pi subagent is released and can be resumed by sending a prompt");
  }

  private liveRuntimeInfo(): AgentRuntimeInfo {
    const model = this.index.get(this.sessionFile)?.model ?? null;
    this.lastReportedLiveModel = model;
    return {
      provider: this.provider,
      sessionId: null,
      model,
      thinkingOptionId: null,
      modeId: null,
    };
  }

  private reportLiveModelIfChanged(model: string | null): void {
    if (model === this.lastReportedLiveModel) {
      return;
    }
    this.lastReportedLiveModel = model;
    this.emit({
      type: "model_changed",
      provider: this.provider,
      runtimeInfo: {
        provider: this.provider,
        sessionId: null,
        model,
        thinkingOptionId: null,
        modeId: null,
      },
    });
  }
}

function collectTimeline(events: readonly AgentStreamEvent[]): ImportedTimelineEntry[] {
  return events.flatMap((event) => {
    if (event.type !== "timeline") {
      return [];
    }
    return [
      {
        item: event.item,
        ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      },
    ];
  });
}

export async function classifyReleasedOmpChild(
  sessionFile: string,
  expectedCwd?: string,
): Promise<{ resumable: boolean; reason: string }> {
  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch {
    return { resumable: false, reason: "session transcript is missing" };
  }
  const records = content
    .split("\n")
    .slice(0, 2_000)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  const header = records.find(
    (record) =>
      record.type === "session" && typeof record.id === "string" && typeof record.cwd === "string",
  );
  const init = records.find((record) => record.type === "session_init");
  if (!header || !init) {
    return { resumable: false, reason: "session transcript has no resumable contract" };
  }
  if (init.isolated === true || init.resumable === false) {
    return { resumable: false, reason: "session is isolated or non-resumable" };
  }
  const cwd = header.cwd as string;
  if (expectedCwd && cwd !== expectedCwd) {
    return { resumable: false, reason: "session uses an isolated workspace" };
  }
  try {
    await access(cwd);
  } catch {
    return { resumable: false, reason: "session workspace is missing" };
  }
  return { resumable: true, reason: "" };
}

export interface ReleasedOmpHistoricalChild {
  sessionFile: string;
  parentSessionFile: string;
  nativeChildId: string;
  ownership: { owner: "none"; resumable: false; reason: string };
}

export async function discoverReleasedOmpHistoricalChildren(
  parentSessionFile: string,
  expectedCwd?: string,
): Promise<ReleasedOmpHistoricalChild[]> {
  const root = parentSessionFile.slice(0, -path.extname(parentSessionFile).length);
  const parentDescriptor = await readReleasedDescriptor(parentSessionFile);
  const classifiedCwd = expectedCwd ?? parentDescriptor?.cwd;
  const discovered: ReleasedOmpHistoricalChild[] = [];
  const visit = async (directory: string, parentFile: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== ".jsonl") {
        continue;
      }
      const descriptor = await readReleasedDescriptor(entryPath);
      if (!descriptor) {
        continue;
      }
      const classification = await classifyReleasedOmpChild(entryPath, classifiedCwd);
      discovered.push({
        sessionFile: entryPath,
        parentSessionFile: parentFile,
        nativeChildId: descriptor.id,
        ownership: {
          owner: "none",
          resumable: false,
          reason: classification.reason || "historical child transcripts are read-only",
        },
      });
      const nestedRoot = entryPath.slice(0, -path.extname(entryPath).length);
      await visit(nestedRoot, entryPath);
    }
  };
  await visit(root, parentSessionFile);
  return discovered;
}

async function readReleasedDescriptor(
  sessionFile: string,
): Promise<{ id: string; cwd: string } | null> {
  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split("\n").slice(0, 2_000)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        value.type === "session" &&
        typeof value.id === "string" &&
        typeof value.cwd === "string"
      ) {
        return { id: value.id, cwd: value.cwd };
      }
    } catch {
      continue;
    }
  }
  return null;
}
