import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";

import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProviderNotice,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  FetchCatalogOptions,
  ImportedProviderSession,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
  ProviderCatalog,
} from "./agent-sdk-types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

interface RecordingLogger {
  logger: Logger;
  warn: ReturnType<typeof vi.fn>;
}

function createRecordingLogger(): RecordingLogger {
  const warn = vi.fn();
  const log = vi.fn();
  const logger = {
    child: () => logger,
    warn,
    error: log,
    trace: log,
    debug: log,
    info: log,
    fatal: log,
  };
  return { logger: logger as unknown as Logger, warn };
}

class FakeAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly features = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    readonly config: AgentSessionConfig,
    readonly id: string | null,
  ) {}

  async run(_prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<AgentRunResult> {
    return { sessionId: this.id ?? "session", finalText: "", timeline: [] };
  }

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    return { turnId: "turn" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  emit(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(_modeId: string): Promise<void | AgentProviderNotice> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {}

  describePersistence(): AgentPersistenceHandle | null {
    if (this.id == null) {
      return null;
    }
    return {
      provider: this.provider,
      sessionId: this.id,
      nativeHandle: this.id,
      metadata: { provider: this.provider, cwd: this.config.cwd },
    };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class ChildImportClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly createdSessions: FakeAgentSession[] = [];
  readonly importCalls: ImportProviderSessionInput[] = [];
  importGate: Promise<void> | null = null;
  importFailure: Error | null = null;
  importCalled: Deferred<void> | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new FakeAgentSession(
      config,
      `parent-native-${this.createdSessions.length + 1}`,
    );
    this.createdSessions.push(session);
    return session;
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    throw new Error("unused");
  }

  async fetchCatalog(_options: FetchCatalogOptions): Promise<ProviderCatalog> {
    return { models: [], modes: [] };
  }

  async listCommands(_config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    return [];
  }

  async importSession(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession> {
    this.importCalls.push(input);
    this.importCalled?.resolve(undefined);
    if (this.importGate) {
      await this.importGate;
    }
    if (this.importFailure) {
      throw this.importFailure;
    }
    return {
      session: new FakeAgentSession(context.storedConfig, input.providerHandleId),
      config: { provider: "codex", cwd: input.cwd },
      persistence: {
        provider: "codex",
        sessionId: input.providerHandleId,
        nativeHandle: input.providerHandleId,
        metadata: { provider: "codex", cwd: input.cwd },
      },
      timeline: [],
    };
  }
}

function nextAgentId(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${(++next).toString().padStart(12, "0")}`;
}

function createHarness(): {
  client: ChildImportClient;
  logger: RecordingLogger;
  manager: AgentManager;
  storage: AgentStorage;
  workdir: string;
} {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-child-session-"));
  const logger = createRecordingLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger.logger);
  const client = new ChildImportClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger: logger.logger,
    idFactory: nextAgentId(),
  });
  return { client, logger, manager, storage, workdir };
}

async function createParent(input: {
  manager: AgentManager;
  workdir: string;
  workspaceId?: string;
}) {
  return await input.manager.createAgent(
    { provider: "codex", cwd: input.workdir },
    undefined,
    input.workspaceId ? { workspaceId: input.workspaceId } : undefined,
  );
}

test("child_session imports a provider-native child agent with parent label and title", async () => {
  const { client, manager, storage, workdir } = createHarness();
  const parent = await createParent({ manager, workdir, workspaceId: "workspace-child" });

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-1",
    status: "running",
    title: "Investigate flaky test",
  });
  await manager.flush();

  const child = manager
    .listAgents()
    .find((agent) => agent.persistence?.sessionId === "native-child-1");
  expect(child).toMatchObject({
    provider: "codex",
    workspaceId: "workspace-child",
    labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
    persistence: { sessionId: "native-child-1", nativeHandle: "native-child-1" },
  });
  expect(manager.listAgents().map((agent) => agent.id)).toContain(child?.id);
  expect((await storage.get(child?.id ?? "missing"))?.title).toBe("Investigate flaky test");
});

test("second child_session for the same child handle does not import twice", async () => {
  const { client, manager, workdir } = createHarness();
  await createParent({ manager, workdir, workspaceId: "workspace-child" });

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-2",
    status: "running",
  });
  await manager.flush();
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-2",
    status: "completed",
  });
  await manager.flush();

  expect(client.importCalls).toEqual([{ providerHandleId: "native-child-2", cwd: workdir }]);
  expect(
    manager.listAgents().filter((agent) => agent.persistence?.sessionId === "native-child-2"),
  ).toHaveLength(1);
});

test("rapid back-to-back child_session events share one in-flight import", async () => {
  const { client, manager, workdir } = createHarness();
  await createParent({ manager, workdir, workspaceId: "workspace-child" });
  const importGate = deferred<void>();
  client.importGate = importGate.promise;
  client.importCalled = deferred<void>();

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-3",
    status: "running",
  });
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-3",
    status: "completed",
  });
  await client.importCalled.promise;
  await Promise.resolve();
  await Promise.resolve();

  expect(client.importCalls).toEqual([{ providerHandleId: "native-child-3", cwd: workdir }]);
  importGate.resolve(undefined);
  await manager.flush();
  expect(client.importCalls).toHaveLength(1);
  expect(
    manager.listAgents().filter((agent) => agent.persistence?.sessionId === "native-child-3"),
  ).toHaveLength(1);
});

test("parent without workspaceId skips child_session import and logs a warning", async () => {
  const { client, logger, manager, workdir } = createHarness();
  await createParent({ manager, workdir });

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-4",
    status: "running",
  });
  await manager.flush();

  expect(client.importCalls).toEqual([]);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ childSessionId: "native-child-4" }),
    "Skipping child session import because parent agent has no workspaceId",
  );
});

test("child_session is never dispatched to manager subscribers as a stream event", async () => {
  const { client, manager, workdir } = createHarness();
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), { replayState: false });
  await createParent({ manager, workdir, workspaceId: "workspace-child" });

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-5",
    status: "running",
  });
  await manager.flush();

  const streamEvents = events.filter((event) => event.type === "agent_stream");
  expect(streamEvents.map((event) => event.event.type)).not.toContain("child_session");
});

test("failed child_session import leaves the parent agent unaffected", async () => {
  const { client, logger, manager, workdir } = createHarness();
  const parent = await createParent({ manager, workdir, workspaceId: "workspace-child" });
  client.importFailure = new Error("provider import failed");

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-6",
    status: "running",
  });
  await manager.flush();

  expect(manager.getAgent(parent.id)).toMatchObject({ id: parent.id, lifecycle: "idle" });
  expect(manager.listAgents().map((agent) => agent.id)).toEqual([parent.id]);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ childSessionId: "native-child-6", err: client.importFailure }),
    "Failed to import child provider session",
  );
});
