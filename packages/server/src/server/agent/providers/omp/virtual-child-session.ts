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
    this.unsubscribeIndex = options.index.subscribe(options.sessionFile, (event) => {
      this.handleIndexEvent(event);
    });
    if (options.index.get(options.sessionFile)) {
      this.emit({ type: "turn_started", provider: this.provider });
    } else {
      // The subagent went terminal between the import-time liveness check and
      // this subscription; no index event will arrive, so promote directly.
      void this.promoteAfterTerminal();
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
    const delegate = await this.promotedDelegate();
    if (delegate) {
      return await delegate.run(prompt, options);
    }
    throw this.readOnlyError();
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    const delegate = await this.promotedDelegate();
    if (delegate) {
      return await delegate.startTurn(prompt, options);
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
    const delegate = await this.promotedDelegate();
    if (delegate) {
      yield* delegate.streamHistory();
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

  private handleIndexEvent(event: OmpSubagentIndexEvent): void {
    if (event.type === "progress") {
      this.reportLiveModelIfChanged(event.entry.model ?? null);
      void this.queueFetch();
      return;
    }
    // Close the turn before promotion so the child never keeps a stale
    // spinner if resuming the standalone session fails.
    this.emitTurnEnd(event.status);
    void this.promoteAfterTerminal();
  }

  private emitTurnEnd(status: OmpTerminalSubagentStatus): void {
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

  private async promoteAfterTerminal(): Promise<void> {
    if (this.promotionPromise) {
      await this.promotionPromise;
      return;
    }
    this.promotionPromise = this.promoteOnce();
    await this.promotionPromise;
  }

  private async promoteOnce(): Promise<void> {
    await this.queueFetch();
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
    if (this.promotionPromise) {
      await this.promotionPromise;
    }
    return this.delegate;
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
    if (this.promotionError) {
      return new Error(
        `Pi subagent finished, but Paseo could not resume it as a standalone session: ${this.promotionError.message}`,
      );
    }
    return new Error("Pi subagent is driven by its parent session until it finishes");
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
