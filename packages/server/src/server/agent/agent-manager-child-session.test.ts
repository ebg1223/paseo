import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  PARENT_AGENT_ID_LABEL,
  PROVIDER_CHILD_OWNER_LABEL,
  PROVIDER_CHILD_REASON_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";

import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
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
  readonly closeEvents: AgentStreamEvent[] = [];

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

  async close(): Promise<void> {
    for (const event of this.closeEvents) {
      this.emit(event);
    }
  }
}

class ChildImportClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly createdSessions: FakeAgentSession[] = [];
  readonly importCalls: ImportProviderSessionInput[] = [];
  importGate: Promise<void> | null = null;
  importFailure: Error | null = null;
  importCalled: Deferred<void> | null = null;
  importOwnership: ImportedProviderSession["ownership"];

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
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new FakeAgentSession(overrides as AgentSessionConfig, handle.sessionId);
    this.createdSessions.push(session);
    return session;
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
      ownership: this.importOwnership,
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
  return await input.manager.createAgent({ provider: "codex", cwd: input.workdir }, undefined, {
    workspaceId: input.workspaceId,
  });
}
test("disk-only provider imports persist read-only ownership", async () => {
  const { client, manager, storage, workdir } = createHarness();
  client.importOwnership = {
    owner: "none",
    resumable: false,
    reason: "Historical session is read-only",
  };

  const imported = await manager.importProviderSession({
    provider: "codex",
    providerHandleId: "disk-only-child",
    cwd: workdir,
    workspaceId: "workspace-child",
  });

  expect(await storage.get(imported.id)).toMatchObject({
    labels: {
      [PROVIDER_CHILD_OWNER_LABEL]: "none",
      [PROVIDER_CHILD_REASON_LABEL]: "Historical session is read-only",
    },
  });
});

test("child_session imports a provider-native child agent with parent label and title", async () => {
  const { client, manager, storage, workdir } = createHarness();
  const parent = await createParent({ manager, workdir, workspaceId: "workspace-child" });

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-1",
    status: "running",
    ownership: { owner: "provider" },
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
    ownership: { owner: "provider" },
  });
  await manager.flush();
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-2",
    status: "completed",
    ownership: { owner: "none", resumable: false, reason: "Provider process exited" },
  });
  await manager.flush();

  expect(client.importCalls).toEqual([{ providerHandleId: "native-child-2", cwd: workdir }]);
  expect(
    manager.listAgents().filter((agent) => agent.persistence?.sessionId === "native-child-2"),
  ).toHaveLength(1);
  const updatedChild = manager
    .listAgents()
    .find((agent) => agent.persistence?.sessionId === "native-child-2");
  expect(updatedChild?.labels).toMatchObject({
    [PROVIDER_CHILD_OWNER_LABEL]: "none",
    [PROVIDER_CHILD_REASON_LABEL]: "Provider process exited",
  });
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
    ownership: { owner: "provider" },
  });
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-3",
    status: "completed",
    ownership: { owner: "paseo", resumable: true },
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
  const updatedChild = manager
    .listAgents()
    .find((agent) => agent.persistence?.sessionId === "native-child-3");
  expect(updatedChild?.labels).toMatchObject({ [PROVIDER_CHILD_OWNER_LABEL]: "paseo" });
});

test("nested child_session imports use the imported provider child as parent", async () => {
  const { client, manager, workdir } = createHarness();
  await createParent({ manager, workdir, workspaceId: "workspace-child" });

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-parent-child",
    status: "running",
    ownership: { owner: "provider" },
  });
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-grandchild",
    parentChildSessionId: "native-parent-child",
    status: "running",
    ownership: { owner: "provider" },
  });
  await manager.flush();

  expect(client.importCalls.map((call) => call.providerHandleId)).toEqual([
    "native-parent-child",
    "native-grandchild",
  ]);
  const importedParent = manager
    .listAgents()
    .find((agent) => agent.persistence?.sessionId === "native-parent-child");
  const grandchild = manager
    .listAgents()
    .find((agent) => agent.persistence?.sessionId === "native-grandchild");
  expect(grandchild?.labels[PARENT_AGENT_ID_LABEL]).toBe(importedParent?.id);
});

test("release event arriving during label persistence is drained", async () => {
  const { client, manager, storage, workdir } = createHarness();
  await createParent({ manager, workdir, workspaceId: "workspace-child" });
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-release-race",
    status: "running",
    ownership: { owner: "provider" },
  });
  await manager.flush();

  const writeStarted = deferred<void>();
  const allowWrite = deferred<void>();
  const originalApplySnapshot = storage.applySnapshot.bind(storage);
  let delayNextWrite = true;
  vi.spyOn(storage, "applySnapshot").mockImplementation(async (...args) => {
    if (delayNextWrite) {
      delayNextWrite = false;
      writeStarted.resolve(undefined);
      await allowWrite.promise;
    }
    return await originalApplySnapshot(...args);
  });

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-release-race",
    status: "running",
    ownership: { owner: "provider" },
  });
  await writeStarted.promise;
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-release-race",
    status: "completed",
    ownership: { owner: "paseo", resumable: true },
  });
  allowWrite.resolve(undefined);
  await manager.flush();

  const child = manager
    .listAgents()
    .find((agent) => agent.persistence?.sessionId === "native-child-release-race");
  expect(child?.labels[PROVIDER_CHILD_OWNER_LABEL]).toBe("paseo");
});

test("reload and ensure-loaded reject restricted provider children", async () => {
  const { client, logger, manager, storage, workdir } = createHarness();
  await createParent({ manager, workdir, workspaceId: "workspace-child" });
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-restricted-child",
    status: "running",
    ownership: { owner: "provider" },
  });
  await manager.flush();

  const child = manager
    .listAgents()
    .find((agent) => agent.persistence?.sessionId === "native-restricted-child");
  expect(child).toBeDefined();
  await expect(manager.reloadAgentSession(child?.id ?? "missing")).rejects.toThrow(
    "Provider-owned child sessions cannot be reloaded",
  );

  await manager.closeAgent(child?.id ?? "missing");
  await expect(
    ensureAgentLoaded(child?.id ?? "missing", {
      agentManager: manager,
      agentStorage: storage,
      logger: logger.logger,
    }),
  ).rejects.toThrow("Provider-owned child sessions cannot be loaded");
});

test("archived none-owned child rejects loading without unarchiving or starting runtime", async () => {
  const { client, logger, manager, storage, workdir } = createHarness();
  await createParent({ manager, workdir, workspaceId: "workspace-child" });
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-historical-child",
    status: "completed",
    ownership: { owner: "none", resumable: false, reason: "Historical session is read-only" },
  });
  await manager.flush();
  const child = manager
    .listAgents()
    .find((agent) => agent.persistence?.sessionId === "native-historical-child");
  await manager.closeAgent(child?.id ?? "missing");
  const stored = await storage.get(child?.id ?? "missing");
  expect(stored).not.toBeNull();
  await storage.upsert({ ...stored!, archivedAt: "2026-07-13T00:00:00.000Z" });

  await expect(
    ensureAgentLoaded(child?.id ?? "missing", {
      agentManager: manager,
      agentStorage: storage,
      logger: logger.logger,
    }),
  ).rejects.toThrow("Historical session is read-only");
  expect((await storage.get(child?.id ?? "missing"))?.archivedAt).toBe("2026-07-13T00:00:00.000Z");
});

test("archive drains release and nested child events emitted during provider close", async () => {
  const { client, manager, storage, workdir } = createHarness();
  const parent = await createParent({ manager, workdir, workspaceId: "workspace-child" });
  client.createdSessions[0]?.closeEvents.push(
    {
      type: "child_session",
      provider: "codex",
      childSessionId: "close-child",
      status: "completed",
      ownership: { owner: "paseo", resumable: true },
    },
    {
      type: "child_session",
      provider: "codex",
      childSessionId: "close-grandchild",
      parentChildSessionId: "close-child",
      status: "aborted",
      ownership: { owner: "none", resumable: false, reason: "Historical session" },
    },
  );

  await manager.archiveAgent(parent.id);

  const records = await storage.list();
  const child = records.find((record) => record.persistence?.sessionId === "close-child");
  const grandchild = records.find((record) => record.persistence?.sessionId === "close-grandchild");
  expect(child?.archivedAt).toEqual(expect.any(String));
  expect(grandchild).toMatchObject({
    archivedAt: expect.any(String),
    lastStatus: "closed",
    labels: {
      [PARENT_AGENT_ID_LABEL]: child?.id,
      [PROVIDER_CHILD_OWNER_LABEL]: "none",
    },
  });
});

test("reload drains provider child records before installing the replacement session", async () => {
  const { client, manager, storage, workdir } = createHarness();
  const parent = await createParent({ manager, workdir, workspaceId: "workspace-child" });
  client.createdSessions[0]?.closeEvents.push({
    type: "child_session",
    provider: "codex",
    childSessionId: "reload-close-child",
    status: "completed",
    ownership: { owner: "none", resumable: false, reason: "Released during close" },
  });

  await manager.reloadAgentSession(parent.id);

  expect(client.createdSessions).toHaveLength(2);
  expect(
    (await storage.list()).find((record) => record.persistence?.sessionId === "reload-close-child"),
  ).toMatchObject({
    lastStatus: "idle",
    labels: {
      [PARENT_AGENT_ID_LABEL]: parent.id,
      [PROVIDER_CHILD_OWNER_LABEL]: "none",
    },
  });
});

test.each([
  ["completed", "idle", undefined],
  ["failed", "error", "Provider child session failed"],
] as const)(
  "later %s event updates a stored child without requiring a live agent",
  async (status, expectedLifecycle, expectedLastError) => {
    const { client, logger, manager, storage, workdir } = createHarness();
    await createParent({ manager, workdir, workspaceId: "workspace-child" });
    client.createdSessions[0]?.emit({
      type: "child_session",
      provider: "codex",
      childSessionId: `stored-child-${status}`,
      status: "running",
      ownership: { owner: "provider" },
    });
    await manager.flush();
    const child = manager
      .listAgents()
      .find((agent) => agent.persistence?.sessionId === `stored-child-${status}`);
    await manager.closeAgent(child?.id ?? "missing");

    client.createdSessions[0]?.emit({
      type: "child_session",
      provider: "codex",
      childSessionId: `stored-child-${status}`,
      status,
      title: `Stored ${status}`,
      ownership: { owner: "none", resumable: false, reason: "Released" },
    });
    await manager.flush();

    expect(await storage.get(child?.id ?? "missing")).toMatchObject({
      title: `Stored ${status}`,
      lastStatus: expectedLifecycle,
      lastError: expectedLastError,
      labels: { [PROVIDER_CHILD_OWNER_LABEL]: "none" },
    });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: `stored-child-${status}` }),
      "Failed to import child provider session",
    );
  },
);

test.each([
  ["completed", "idle"],
  ["failed", "error"],
  ["aborted", "idle"],
] as const)("recovered %s child persists %s lifecycle", async (status, expectedLifecycle) => {
  const { client, manager, storage, workdir } = createHarness();
  await createParent({ manager, workdir, workspaceId: "workspace-child" });
  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: `recovered-${status}`,
    status,
    ownership: { owner: "none", resumable: false, reason: "Historical session" },
  });
  await manager.flush();

  const recovered = (await storage.list()).find(
    (record) => record.persistence?.sessionId === `recovered-${status}`,
  );
  expect(recovered).toMatchObject({
    lastStatus: expectedLifecycle,
    labels: { [PROVIDER_CHILD_OWNER_LABEL]: "none" },
  });
});

test("archiving a parent waits for an in-flight child import before cascading", async () => {
  const { client, manager, storage, workdir } = createHarness();
  const parent = await createParent({ manager, workdir, workspaceId: "workspace-child" });
  const importGate = deferred<void>();
  client.importGate = importGate.promise;
  client.importCalled = deferred<void>();

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-archive-race",
    status: "running",
    ownership: { owner: "provider" },
  });
  await client.importCalled.promise;
  const archivePromise = manager.archiveAgent(parent.id);
  importGate.resolve(undefined);
  await archivePromise;
  await manager.flush();

  const child = (await storage.list()).find(
    (record) => record.persistence?.sessionId === "native-child-archive-race",
  );
  expect(child?.archivedAt).toEqual(expect.any(String));
});

test("parent without workspaceId skips child_session import and logs a warning", async () => {
  const { client, logger, manager, workdir } = createHarness();
  await createParent({ manager, workdir });

  client.createdSessions[0]?.emit({
    type: "child_session",
    provider: "codex",
    childSessionId: "native-child-4",
    status: "running",
    ownership: { owner: "provider" },
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
    ownership: { owner: "provider" },
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
    ownership: { owner: "provider" },
  });
  await manager.flush();

  expect(manager.getAgent(parent.id)).toMatchObject({ id: parent.id, lifecycle: "idle" });
  expect(manager.listAgents().map((agent) => agent.id)).toEqual([parent.id]);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ childSessionId: "native-child-6", err: client.importFailure }),
    "Failed to import child provider session",
  );
});
