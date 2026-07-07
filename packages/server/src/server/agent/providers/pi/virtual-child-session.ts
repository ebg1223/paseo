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
import { PiHistoryMapper, streamPiHistory } from "./history-mapper.js";
import type { PiRuntimeSession } from "./runtime.js";
import type { PiSubagentMessagesResult } from "./rpc-types.js";
import type { PiSubagentIndex, PiSubagentIndexEvent } from "./subagent-index.js";

interface PiVirtualChildSessionOptions {
  provider: AgentProvider;
  sessionFile: string;
  index: PiSubagentIndex;
  parentRuntime: PiRuntimeSession;
  initialMessages: PiSubagentMessagesResult;
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

export class PiVirtualChildSession implements AgentSession {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingEvents: AgentStreamEvent[] = [];
  private readonly initialTimeline: ImportedTimelineEntry[];
  private readonly unsubscribeIndex: () => void;
  private readonly sessionFile: string;
  private readonly parentRuntime: PiRuntimeSession;
  private readonly persistence: AgentPersistenceHandle;
  private readonly config: AgentSessionConfig;
  private readonly resumeSession: PiVirtualChildSessionOptions["resumeSession"];
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

  constructor(options: PiVirtualChildSessionOptions) {
    this.provider = options.provider;
    this.capabilities = options.capabilities;
    this.sessionFile = options.sessionFile;
    this.parentRuntime = options.parentRuntime;
    this.persistence = options.persistence;
    this.config = options.config;
    this.resumeSession = options.resumeSession;
    this.launchContext = options.launchContext;
    this.logger = options.logger;
    this.mapper = new PiHistoryMapper(options.provider);
    this.fromByte = options.initialMessages.nextByte;

    const initialEvents = this.mapNewEvents(options.initialMessages.messages, { reset: false });
    this.initialTimeline = collectTimeline(initialEvents);
    this.unsubscribeIndex = options.index.subscribe(options.sessionFile, (event) => {
      this.handleIndexEvent(event);
    });
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
    const result = await this.parentRuntime.getSubagentMessages({
      sessionFile: this.sessionFile,
      fromByte: 0,
    });
    yield* streamPiHistory(this.provider, result.messages);
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const delegate = await this.promotedDelegate();
    if (delegate) {
      return await delegate.getRuntimeInfo();
    }
    return {
      provider: this.provider,
      sessionId: null,
      model: null,
      thinkingOptionId: null,
      modeId: null,
    };
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

  private handleIndexEvent(event: PiSubagentIndexEvent): void {
    if (event.type === "progress") {
      void this.queueFetch();
      return;
    }
    void this.promoteAfterTerminal();
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
    const result = await this.parentRuntime.getSubagentMessages({
      sessionFile: this.sessionFile,
      fromByte: this.fromByte,
    });
    if (result.reset) {
      // The parent detected transcript truncation and restarted from byte 0.
      // Rebuild mapper state from the replay and skip the timeline prefix that
      // was already emitted. Resets are rare; if the old prefix changed, the
      // virtual session keeps the existing UI rows until promotion hydrates the
      // final standalone session.
      this.mapper = new PiHistoryMapper(this.provider);
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
    messages: PiSubagentMessagesResult["messages"],
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
