import type {
  AgentCapabilityFlags,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentProviderNotice,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";
import { streamOmpHistory } from "./history.js";

export class OmpReleasedSession implements AgentSession {
  readonly id: string;
  readonly features = [];

  constructor(
    readonly provider: AgentProvider,
    private readonly sessionFile: string,
    private readonly config: AgentSessionConfig,
    readonly capabilities: AgentCapabilityFlags,
  ) {
    this.id = sessionFile;
  }

  async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    throw this.readOnlyError();
  }

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    throw this.readOnlyError();
  }

  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => undefined;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* streamOmpHistory({ sessionFile: this.sessionFile, provider: this.provider });
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.sessionFile,
      model: this.config.model ?? null,
      thinkingOptionId: this.config.thinkingOptionId ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  async setMode(_modeId: string): Promise<void | AgentProviderNotice> {
    throw this.readOnlyError();
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(_requestId: string, _response: AgentPermissionResponse): Promise<void> {
    throw this.readOnlyError();
  }

  describePersistence(): AgentPersistenceHandle {
    return {
      provider: this.provider,
      sessionId: this.sessionFile,
      nativeHandle: this.sessionFile,
      metadata: { cwd: this.config.cwd },
    };
  }

  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}

  private readOnlyError(): Error {
    return new Error("OMP history session is read-only because no live parent owns it");
  }
}
