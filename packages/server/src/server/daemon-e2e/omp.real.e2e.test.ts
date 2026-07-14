import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import pino from "pino";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import {
  MIN_SUPPORTED_OMP_VERSION,
  formatOmpVersionSupport,
} from "../agent/providers/omp/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createRealProviderClients, getRealProviderConfig } from "./real-provider-test-config.js";

process.env.PASEO_SUPERVISED = "0";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 300_000;
const MODEL = getRealProviderConfig("omp").model;
const SHELL_TOOL_PATTERN = /(?:bash|shell|%!)/i;
const roots = new Set<string>();

interface Harness {
  daemon: TestPaseoDaemon;
  client: DaemonClient;
  cwd: string;
  paseoHomeRoot: string;
  staticDir: string;
}

async function preflight(): Promise<void> {
  const command = process.env.OMP_COMMAND?.trim() || "omp";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, ["--version"], {
      timeout: 10_000,
    }));
  } catch (error) {
    throw new Error(`OMP real E2E gate requires an executable OMP binary (${command})`, {
      cause: error,
    });
  }
  const support = formatOmpVersionSupport(stdout);
  if (!support.includes("supported")) {
    throw new Error(`OMP real E2E gate requires OMP >= ${MIN_SUPPORTED_OMP_VERSION}: ${support}`);
  }
}

async function createHarness(): Promise<Harness> {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-"));
  const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-home-"));
  const staticDir = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-static-"));
  for (const root of [cwd, paseoHomeRoot, staticDir]) roots.add(root);
  const logger = pino({ level: process.env.OMP_E2E_LOG_LEVEL ?? "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: createRealProviderClients(["omp"], logger),
    providerOverrides: { omp: { enabled: true } },
    logger,
    paseoHomeRoot,
    staticDir,
    cleanup: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.45",
  });
  await client.connect();
  await client.fetchAgents({
    subscribe: { subscriptionId: `omp-real-${randomUUID()}` },
  });
  return { daemon, client, cwd, paseoHomeRoot, staticDir };
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.client.close().catch(() => undefined);
  await harness.daemon.close().catch(() => undefined);
  for (const root of [harness.cwd, harness.paseoHomeRoot, harness.staticDir]) {
    rmSync(root, { recursive: true, force: true });
    roots.delete(root);
  }
}

async function timeline(client: DaemonClient, agentId: string): Promise<AgentTimelineItem[]> {
  const result = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  return result.entries.map((entry) => entry.item);
}

function latestTools(items: AgentTimelineItem[]) {
  const latest = new Map<string, Extract<AgentTimelineItem, { type: "tool_call" }>>();
  for (const item of items) if (item.type === "tool_call") latest.set(item.callId, item);
  return [...latest.values()];
}

function toolResult(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  if (item.detail.type === "shell") return item.detail.output ?? "";
  if (item.detail.type === "fetch") return item.detail.result ?? "";
  if (item.detail.type === "plain_text") return item.detail.text ?? "";
  return JSON.stringify(item.detail);
}

function completedTools(items: AgentTimelineItem[], pattern: RegExp) {
  return latestTools(items).filter(
    (item) => pattern.test(item.name) && item.status === "completed",
  );
}

async function createAgent(harness: Harness, title: string, modeId = "full") {
  return await harness.client.createAgent({
    cwd: harness.cwd,
    title,
    provider: "omp",
    model: MODEL,
    modeId,
  });
}

async function promptAndFinish(harness: Harness, agentId: string, prompt: string) {
  await harness.client.sendMessage(agentId, prompt);
  const finish = await harness.client.waitForFinish(agentId, TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  const items = await timeline(harness.client, agentId);
  expect(items.some((item) => item.type === "error")).toBe(false);
  expect(latestTools(items).every((item) => item.status !== "running")).toBe(true);
  return items;
}

async function waitForProviderSubagent(
  client: DaemonClient,
  parentAgentId: string,
  status: "running" | "completed",
) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { subagents } = await client.listProviderSubagents(parentAgentId);
    const match = subagents.find((subagent) => subagent.status === status);
    if (match) return match;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for OMP provider subagent status ${status}`);
}

beforeAll(preflight, 15_000);
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("credentialed real OMP 16.3.9+ matrix", () => {
  test(
    "prompt, native tool, and resumed follow-up",
    async () => {
      const harness = await createHarness();
      try {
        const agent = await createAgent(harness, "prompt-tool-resume");
        await promptAndFinish(
          harness,
          agent.id,
          "Run exactly this bash command: printf 'OMP_FIRST\\n'",
        );
        const items = await promptAndFinish(
          harness,
          agent.id,
          "Run exactly this bash command: printf 'OMP_RESUMED\\n'",
        );
        const outputs = completedTools(items, SHELL_TOOL_PATTERN).map(toolResult);
        expect(outputs.some((output) => output.includes("OMP_FIRST"))).toBe(true);
        expect(outputs.some((output) => output.includes("OMP_RESUMED"))).toBe(true);
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "ask mode preserves multiline approval details",
    async () => {
      const harness = await createHarness();
      try {
        const agent = await createAgent(harness, "multiline-approval", "ask");
        await harness.client.sendMessage(
          agent.id,
          "Run exactly this bash command: printf 'line one\\nline two\\n'",
        );
        const pending = await harness.client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.pendingPermissions.length > 0,
          TIMEOUT_MS,
        );
        const permission = pending.pendingPermissions[0];
        expect(JSON.stringify(permission.detail)).toContain("line one");
        expect(JSON.stringify(permission.detail)).toContain("line two");
        await harness.client.respondToPermission(agent.id, permission.id, {
          behavior: "allow",
        });
        expect((await harness.client.waitForFinish(agent.id, TIMEOUT_MS)).status).toBe("idle");
        const output = completedTools(
          await timeline(harness.client, agent.id),
          SHELL_TOOL_PATTERN,
        ).map(toolResult);
        expect(output.join("\n")).toContain("line one");
        expect(output.join("\n")).toContain("line two");
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "active steer and interrupt",
    async () => {
      const harness = await createHarness();
      try {
        const agent = await createAgent(harness, "interrupt-steer");
        await harness.client.sendMessage(
          agent.id,
          "Run exactly this bash command: sleep 30; printf 'SHOULD_NOT_FINISH\\n'",
        );
        await harness.client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          TIMEOUT_MS,
        );
        await harness.client.sendMessage(
          agent.id,
          "/steer stop sleeping and run exactly this bash command: printf 'OMP_ACTIVE_STEER\\n'",
        );
        expect((await harness.client.waitForFinish(agent.id, TIMEOUT_MS)).status).toBe("idle");
        let items = await timeline(harness.client, agent.id);
        expect(completedTools(items, SHELL_TOOL_PATTERN).map(toolResult).join("\n")).toContain(
          "OMP_ACTIVE_STEER",
        );

        await harness.client.sendMessage(
          agent.id,
          "Run exactly this bash command: sleep 30; printf 'LATE\\n'",
        );
        await harness.client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.status === "running",
          TIMEOUT_MS,
        );
        await harness.client.cancelAgent(agent.id);
        expect((await harness.client.waitForFinish(agent.id, TIMEOUT_MS)).status).not.toBe(
          "running",
        );
        items = await timeline(harness.client, agent.id);
        expect(
          completedTools(items, SHELL_TOOL_PATTERN).some((call) =>
            toolResult(call).includes("LATE"),
          ),
        ).toBe(false);
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "todo lifecycle",
    async () => {
      const harness = await createHarness();
      try {
        const agent = await createAgent(harness, "todo-lifecycle");
        const items = await promptAndFinish(
          harness,
          agent.id,
          "Create exactly these two todos in order: verify first child, verify second child. Complete both, without spawning a task.",
        );
        const snapshots = items.filter((item) => item.type === "todo").map((item) => item.items);
        const hasFreshPair = (snapshot: { completed: boolean }[]): boolean =>
          snapshot.length === 2 && snapshot.every((entry) => !entry.completed);
        expect(snapshots.some(hasFreshPair)).toBe(true);
        expect(snapshots.at(-1)).toEqual([
          { text: "verify first child", completed: true },
          { text: "verify second child", completed: true },
        ]);
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "subagent lifecycle streams descriptors and timeline on the parent",
    async () => {
      const harness = await createHarness();
      try {
        const parent = await createAgent(harness, "subagent-track");
        const run = harness.client.sendMessage(
          parent.id,
          "Use task to create exactly one child named TrackChild. It must run exactly this bash command: printf 'TRACK_CHILD_OK\\n'. Wait for it.",
        );
        const started = await waitForProviderSubagent(harness.client, parent.id, "running");
        expect(started.parentAgentId).toBe(parent.id);
        await run;
        expect((await harness.client.waitForFinish(parent.id, TIMEOUT_MS)).status).toBe("idle");
        const { subagents } = await harness.client.listProviderSubagents(parent.id);
        expect(subagents).toHaveLength(1);
        expect(subagents[0].status).toBe("completed");
        const childTimeline = await harness.client.fetchProviderSubagentTimeline(
          parent.id,
          subagents[0].id,
          {
            direction: "tail",
            limit: 0,
          },
        );
        expect(childTimeline.rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(childTimeline.rows)).toContain("TRACK_CHILD_OK");
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a completed child imports as a normal promptable OMP agent",
    async () => {
      const harness = await createHarness();
      try {
        const parent = await createAgent(harness, "child-import");
        await promptAndFinish(
          harness,
          parent.id,
          "Use task to create exactly one child named ImportChild. It must run exactly this bash command: printf 'IMPORT_CHILD_DONE\\n'. Wait for it.",
        );
        const completedChild = await waitForProviderSubagent(
          harness.client,
          parent.id,
          "completed",
        );
        expect(completedChild.title).toContain("ImportChild");
        const recent = await harness.client.fetchRecentProviderSessions({
          cwd: harness.cwd,
          providers: ["omp"],
        });
        const childSession = recent.entries.find(
          (entry) =>
            entry.providerId === "omp" &&
            (entry.title?.includes("ImportChild") ||
              entry.firstPromptPreview?.includes("ImportChild") ||
              entry.lastPromptPreview?.includes("IMPORT_CHILD_DONE")),
        );
        expect(childSession).toBeDefined();
        const imported = await harness.client.importAgent({
          provider: "omp",
          sessionId: childSession!.providerHandleId,
          cwd: harness.cwd,
        });
        expect(imported.id).not.toBe(parent.id);
        const items = await promptAndFinish(
          harness,
          imported.id,
          "Run exactly this bash command: printf 'IMPORTED_CHILD_RESUMED\\n'",
        );
        expect(completedTools(items, SHELL_TOOL_PATTERN).map(toolResult).join("\n")).toContain(
          "IMPORTED_CHILD_RESUMED",
        );
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );
});
