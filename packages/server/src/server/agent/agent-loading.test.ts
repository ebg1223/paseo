import pino from "pino";
import { expect, test, vi } from "vitest";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

test("ensureAgentLoaded uses normal resume when loading persisted sessions", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const now = "2026-05-12T00:00:00.000Z";
  const record: StoredAgentRecord = {
    id: agentId,
    provider: "droid",
    cwd: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: "2026-05-12T00:01:00.000Z",
    lastUserMessageAt: "2026-05-12T00:02:00.000Z",
    labels: { kind: "custom-acp" },
    lastStatus: "closed",
    lastModeId: "auto-high",
    config: {
      model: "custom:GPT-5.5-Medium-1",
      title: "Droid session",
    },
    persistence: {
      provider: "droid",
      sessionId: "droid-session-1",
      metadata: { provider: "droid", cwd: "/tmp/project" },
    },
  };
  const snapshot = { id: agentId, provider: "droid" } as ManagedAgent;
  const resumeAgentFromPersistence = vi.fn().mockResolvedValue(snapshot);
  const agentManager = {
    getAgent: vi.fn().mockReturnValue(null),
    getRegisteredProviderIds: vi.fn().mockReturnValue(["droid"]),
    resumeAgentFromPersistence,
    hydrateTimelineFromProvider: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentManager;
  const agentStorage = {
    get: vi.fn().mockResolvedValue(record),
  } as unknown as AgentStorage;

  await expect(
    ensureAgentLoaded(agentId, {
      agentManager,
      agentStorage,
      logger: pino({ level: "silent" }),
    }),
  ).resolves.toBe(snapshot);

  expect(resumeAgentFromPersistence).toHaveBeenCalledWith(
    {
      provider: "droid",
      sessionId: "droid-session-1",
      metadata: { provider: "droid", cwd: "/tmp/project" },
    },
    {
      cwd: "/tmp/project",
      modeId: "auto-high",
      model: "custom:GPT-5.5-Medium-1",
      title: "Droid session",
    },
    agentId,
    {
      createdAt: new Date(now),
      updatedAt: new Date("2026-05-12T00:01:00.000Z"),
      lastUserMessageAt: new Date("2026-05-12T00:02:00.000Z"),
      labels: { kind: "custom-acp" },
    },
  );
});
