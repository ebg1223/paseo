import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";

import pino from "pino";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL, PROVIDER_CHILD_OWNER_LABEL } from "@getpaseo/protocol/agent-labels";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import {
  MIN_SUPPORTED_OMP_VERSION,
  OmpRpcAgentClient,
  formatOmpVersionSupport,
} from "../agent/providers/omp/agent.js";
import { PiCliRuntime } from "../agent/providers/pi-shared/cli-runtime.js";
import type {
  PiRuntime,
  PiRuntimeSession,
  PiStartSessionInput,
} from "../agent/providers/pi-shared/runtime.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createRealProviderClients, getRealProviderConfig } from "./real-provider-test-config.js";

process.env.PASEO_SUPERVISED = "0";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 300_000;
const MODEL = getRealProviderConfig("omp").model;
const SHELL_TOOL_PATTERN = /^(?:bash|shell)$/i;
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
    ({ stdout } = await execFileAsync(command, ["--version"], { timeout: 10_000 }));
  } catch (error) {
    throw new Error(`OMP real E2E gate requires an executable OMP binary (${command})`, {
      cause: error,
    });
  }
  const support = formatOmpVersionSupport(stdout);
  if (!support.includes("(supported;")) {
    throw new Error(
      `OMP real E2E gate requires OMP >= ${MIN_SUPPORTED_OMP_VERSION}; found ${support}`,
    );
  }
}

async function createHarness(): Promise<Harness> {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-"));
  const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-home-"));
  const staticDir = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-static-"));
  roots.add(cwd);
  roots.add(paseoHomeRoot);
  roots.add(staticDir);
  const logger = pino({ level: process.env.OMP_E2E_LOG_LEVEL ?? "silent" });
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["omp"], logger),
      providerOverrides: { omp: { enabled: true } },
      logger,
      paseoHomeRoot,
      staticDir,
      cleanup: false,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.45",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: `omp-real-${randomUUID()}` } });
    return { daemon, client, cwd, paseoHomeRoot, staticDir };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const root of [cwd, paseoHomeRoot, staticDir]) {
      rmSync(root, { recursive: true, force: true });
      roots.delete(root);
    }
    throw error;
  }
}

async function restartHarness(harness: Harness): Promise<void> {
  await harness.client.close();
  await harness.daemon.close();
  const logger = pino({ level: process.env.OMP_E2E_LOG_LEVEL ?? "silent" });
  harness.daemon = await createTestPaseoDaemon({
    agentClients: createRealProviderClients(["omp"], logger),
    providerOverrides: { omp: { enabled: true } },
    logger,
    paseoHomeRoot: harness.paseoHomeRoot,
    staticDir: harness.staticDir,
    cleanup: false,
  });
  harness.client = new DaemonClient({
    url: `ws://127.0.0.1:${harness.daemon.port}/ws`,
    appVersion: "0.1.45",
  });
  await harness.client.connect();
  await harness.client.fetchAgents({
    subscribe: { subscriptionId: `omp-real-restart-${randomUUID()}` },
  });
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

async function waitForTimelineItem(
  client: DaemonClient,
  agentId: string,
  predicate: (item: AgentTimelineItem) => boolean,
  timeoutMs = 30_000,
): Promise<AgentTimelineItem> {
  const deadline = Date.now() + timeoutMs;
  let lastItems: AgentTimelineItem[] = [];
  while (Date.now() < deadline) {
    lastItems = await timeline(client, agentId);
    const item = lastItems.find(predicate);
    if (item) {
      return item;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for OMP timeline item: ${JSON.stringify(lastItems)}`);
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = sleep(timeoutMs, undefined, { signal: controller.signal }).then(() => {
    throw new Error(`Timed out waiting ${timeoutMs}ms for OMP login request to settle`);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    controller.abort();
  }
}

class CapturingPiRuntime implements PiRuntime {
  session: PiRuntimeSession | undefined;

  constructor(private readonly runtime: PiRuntime) {}

  async startSession(input: PiStartSessionInput): Promise<PiRuntimeSession> {
    this.session = await this.runtime.startSession(input);
    return this.session;
  }
}

function latestSettledTimelineItem(items: AgentTimelineItem[]): AgentTimelineItem | null {
  return (
    items.toReversed().find((item) => item.type !== "tool_call" || item.status !== "running") ??
    null
  );
}

async function scenarioDiagnostic(
  harness: Harness,
  agentId: string,
  items: AgentTimelineItem[],
): Promise<string> {
  const snapshot = await harness.client.fetchAgent(agentId).catch(() => undefined);
  const finalError = items.toReversed().find((item) => item.type === "error");
  const latestFrame = latestSettledTimelineItem(items);
  return JSON.stringify({
    finalAgentError: finalError ?? null,
    status: snapshot?.agent.status ?? null,
    lastError: snapshot?.agent.lastError ?? null,
    labels: snapshot?.agent.labels ?? null,
    handle: snapshot?.agent.persistence?.sessionId ?? null,
    latestFrame,
    recentToolCalls: latestToolCalls(items).slice(-6),
  });
}

async function runScenario(
  title: string,
  prompt: string,
  verify: (items: AgentTimelineItem[], harness: Harness, agentId: string) => Promise<void> | void,
  releaseBeforeVerify = false,
): Promise<void> {
  const harness = await createHarness();
  try {
    const agent = await harness.client.createAgent({
      cwd: harness.cwd,
      title,
      provider: "omp",
      model: MODEL,
      modeId: "full",
      thinkingOptionId: "medium",
    });
    await harness.client.sendMessage(agent.id, prompt);
    const finish = await harness.client.waitForFinish(agent.id, TIMEOUT_MS);
    const items = await timeline(harness.client, agent.id);
    const diagnostic = await scenarioDiagnostic(harness, agent.id, items);
    try {
      expect(finish.status, JSON.stringify(finish)).toBe("idle");
      expect(items.some((item) => item.type === "error")).toBe(false);
      expectCompletedToolResults(items);
      if (releaseBeforeVerify) {
        await harness.client.refreshAgent(agent.id);
      }
      await verify(items, harness, agent.id);
    } catch (error) {
      throw new Error(`Scenario ${title} failed: ${diagnostic}`, { cause: error });
    }
  } finally {
    await closeHarness(harness);
  }
}

function latestToolCalls(items: AgentTimelineItem[]) {
  const latest = new Map<string, Extract<AgentTimelineItem, { type: "tool_call" }>>();
  for (const item of items) {
    if (item.type === "tool_call") latest.set(item.callId, item);
  }
  return [...latest.values()];
}

function completedTools(items: AgentTimelineItem[], pattern: RegExp) {
  return latestToolCalls(items).filter(
    (item) => pattern.test(item.name) && item.status === "completed",
  );
}

function toolResult(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  if (item.detail.type === "shell") return item.detail.output ?? "";
  if (item.detail.type === "fetch") return item.detail.result ?? "";
  if (item.detail.type === "plain_text") return item.detail.text ?? "";
  if (item.detail.type === "unknown") return JSON.stringify(item.detail.output ?? "");
  if (item.detail.type === "sub_agent") return item.detail.log;
  return JSON.stringify(item.detail);
}

function expectCompletedToolResults(items: AgentTimelineItem[]): void {
  const calls = latestToolCalls(items);
  expect(calls.length).toBeGreaterThan(0);
  expect(
    calls.every((item) => item.status !== "running"),
    JSON.stringify(calls),
  ).toBe(true);
  for (const call of calls.filter((item) => item.status === "completed")) {
    expect(toolResult(call).trim(), `${call.name} must expose a result`).not.toBe("");
  }
}

function expectTool(items: AgentTimelineItem[], pattern: RegExp, diagnostic?: string): void {
  expect(completedTools(items, pattern).length, diagnostic).toBeGreaterThan(0);
}

async function expectTodoBatchScenario(
  items: AgentTimelineItem[],
  harness: Harness,
  agentId: string,
): Promise<void> {
  const snapshots = items.filter((item) => item.type === "todo").map((item) => item.items);
  expect(snapshots).toContainEqual([
    { text: "verify first child", completed: false },
    { text: "verify second child", completed: false },
  ]);
  expect(snapshots.at(-1)).toEqual([
    { text: "verify first child", completed: true },
    { text: "verify second child", completed: true },
  ]);
  expectTool(items, /^task$/i);
  const agents = (await harness.client.fetchAgents({})).entries.map((entry) => entry.agent);
  const children = agents.filter(
    (agent) => agent.id !== agentId && Object.values(agent.labels ?? {}).includes(agentId),
  );
  expect(children).toHaveLength(2);
  expect(new Set(children.map((child) => child.persistence?.sessionId)).size).toBe(2);
  for (const child of children) {
    expect(child.persistence?.sessionId).toEqual(expect.any(String));
    expect((await timeline(harness.client, child.id)).length).toBeGreaterThan(0);
  }
}

async function expectChildFollowUpScenario(
  items: AgentTimelineItem[],
  harness: Harness,
  agentId: string,
): Promise<void> {
  const agents = (await harness.client.fetchAgents({})).entries.map((entry) => entry.agent);
  const children = agents.filter((agent) => Object.values(agent.labels ?? {}).includes(agentId));
  expect(children).toHaveLength(1);
  const child = children[0]!;
  expect(child.labels?.[PROVIDER_CHILD_OWNER_LABEL]).toBe("paseo");
  try {
    await harness.client.sendMessage(
      child.id,
      "Run exactly this bash command: printf 'FOLLOWUP_OK\\n'",
    );
  } catch (error) {
    throw new Error(
      `Released child follow-up failed: ${await scenarioDiagnostic(harness, child.id, await timeline(harness.client, child.id))}`,
      { cause: error },
    );
  }
  expect((await harness.client.waitForFinish(child.id, TIMEOUT_MS)).status).toBe("idle");
  expect(
    completedTools(await timeline(harness.client, child.id), SHELL_TOOL_PATTERN).some((item) =>
      toolResult(item).includes("FOLLOWUP_OK"),
    ),
  ).toBe(true);
  expectTool(items, /^task$/i);
}

async function expectParentScopedChildrenScenario(
  items: AgentTimelineItem[],
  harness: Harness,
  agentId: string,
): Promise<void> {
  expect(completedTools(items, /^task$/i)).toHaveLength(1);
  const agents = (await harness.client.fetchAgents({})).entries.map((entry) => entry.agent);
  const parents = agents.filter((agent) => agent.labels?.[PARENT_AGENT_ID_LABEL] === agentId);
  expect(parents).toHaveLength(2);
  const nested = agents.filter((agent) =>
    parents.some((parent) => agent.labels?.[PARENT_AGENT_ID_LABEL] === parent.id),
  );
  expect(nested).toHaveLength(2);
  expect(new Set(nested.map((child) => child.id)).size).toBe(2);
  expect(new Set(nested.map((child) => child.persistence?.sessionId)).size).toBe(2);
  expect(new Set(nested.map((child) => child.labels?.[PARENT_AGENT_ID_LABEL]))).toEqual(
    new Set(parents.map((parent) => parent.id)),
  );
  expect(new Set(parents.map((parent) => parent.title))).toEqual(
    new Set(["ParentAlpha", "ParentBeta"]),
  );
  for (const child of nested) {
    expect(child.title).toContain("SameChild");
    expect(child.labels?.[PROVIDER_CHILD_OWNER_LABEL]).toMatch(/^(paseo|none)$/);
    await waitForTimelineItem(harness.client, child.id, () => true);
  }
}

async function expectTaskTopologyScenario(
  items: AgentTimelineItem[],
  harness: Harness,
  agentId: string,
  title: string,
): Promise<void> {
  expectTool(items, /task/i);
  const agents = (await harness.client.fetchAgents({})).entries.map((entry) => entry.agent);
  const child = agents.find((candidate) => candidate.title === title);
  const diagnostic = JSON.stringify({
    title,
    agentId,
    child: child
      ? {
          id: child.id,
          labels: child.labels,
          handle: child.persistence?.sessionId,
        }
      : null,
    latestFrame: items.at(-1) ?? null,
  });
  expect(child, diagnostic).toBeDefined();
  expect(child?.labels?.[PARENT_AGENT_ID_LABEL], diagnostic).toBe(agentId);
  expect(child?.persistence?.sessionId, diagnostic).toEqual(expect.any(String));
  expect(child?.labels?.[PROVIDER_CHILD_OWNER_LABEL], diagnostic).toMatch(/^(paseo|none)$/);
  const childItems = await timeline(harness.client, child!.id);
  expect(
    childItems.length,
    await scenarioDiagnostic(harness, child!.id, childItems),
  ).toBeGreaterThan(0);
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
        const agent = await harness.client.createAgent({
          cwd: harness.cwd,
          title: "prompt-tool-resume",
          provider: "omp",
          model: MODEL,
          modeId: "full",
        });
        await harness.client.sendMessage(
          agent.id,
          "Run exactly this bash command: printf 'OMP_FIRST\\n'",
        );
        expect((await harness.client.waitForFinish(agent.id, TIMEOUT_MS)).status).toBe("idle");
        await harness.client.sendMessage(
          agent.id,
          "Run exactly this bash command: printf 'OMP_RESUMED\\n'",
        );
        expect((await harness.client.waitForFinish(agent.id, TIMEOUT_MS)).status).toBe("idle");
        const items = await timeline(harness.client, agent.id);
        expectCompletedToolResults(items);
        const shellCalls = completedTools(items, SHELL_TOOL_PATTERN);
        const outputs = shellCalls.map(toolResult);
        expect(
          outputs.some((output) => output.includes("OMP_FIRST")),
          JSON.stringify(shellCalls),
        ).toBe(true);
        expect(
          outputs.some((output) => output.includes("OMP_RESUMED")),
          JSON.stringify(shellCalls),
        ).toBe(true);
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "always-ask preserves multiline approval command and output",
    async () => {
      const harness = await createHarness();
      try {
        const agent = await harness.client.createAgent({
          cwd: harness.cwd,
          title: "multiline-approval",
          provider: "omp",
          model: MODEL,
          modeId: "ask",
        });
        await harness.client.sendMessage(
          agent.id,
          "Run exactly this bash command: printf 'line one\\nline two\\n'",
        );
        const pending = await harness.client.waitForAgentUpsert(
          agent.id,
          (snapshot) => snapshot.pendingPermissions.length > 0,
          TIMEOUT_MS,
        );
        const permission = pending.pendingPermissions[0]!;
        expect(JSON.stringify(permission.detail)).toContain("printf");
        expect(JSON.stringify(permission.detail)).toContain("line one");
        expect(JSON.stringify(permission.detail)).toContain("line two");
        await harness.client.respondToPermission(agent.id, permission.id, {
          behavior: "allow",
          message: "approved\nby real OMP gate",
        });
        expect((await harness.client.waitForFinish(agent.id, TIMEOUT_MS)).status).toBe("idle");
        const items = await timeline(harness.client, agent.id);
        const bash = completedTools(items, SHELL_TOOL_PATTERN);
        expect(bash).toHaveLength(1);
        expect(toolResult(bash[0]!)).toContain("line one");
        expect(toolResult(bash[0]!)).toContain("line two");
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
        const agent = await harness.client.createAgent({
          cwd: harness.cwd,
          title: "interrupt-steer",
          provider: "omp",
          model: MODEL,
          modeId: "full",
        });
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
        const steeredItems = await timeline(harness.client, agent.id);
        const steeredOutputs = completedTools(steeredItems, SHELL_TOOL_PATTERN).map(toolResult);
        expect(steeredOutputs.some((output) => output.includes("OMP_ACTIVE_STEER"))).toBe(true);
        expect(steeredOutputs.some((output) => output.includes("SHOULD_NOT_FINISH"))).toBe(false);

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
        const canceled = await harness.client.waitForFinish(agent.id, TIMEOUT_MS);
        expect(canceled.status).not.toBe("running");
        const canceledItems = await timeline(harness.client, agent.id);
        expect(
          completedTools(canceledItems, SHELL_TOOL_PATTERN).some((call) =>
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
    "todo lifecycle and exactly two imported batch children",
    () =>
      runScenario(
        "todo-batch",
        "Create exactly these two todos in this order: 'verify first child' and 'verify second child'. Mark the first in progress, then completed, then complete the second. Use task.batch with exactly two tiny workers named BatchAlpha and BatchBeta. BatchAlpha must run exactly this bash command: printf 'BatchAlpha\\n'. BatchBeta must run exactly this bash command: printf 'BatchBeta\\n'. Wait for both. Do not create any other child.",
        expectTodoBatchScenario,
      ),
    TIMEOUT_MS,
  );

  test(
    "single child ownership and follow-up after parent release",
    () =>
      runScenario(
        "child-release-followup",
        "Use task to create exactly one child named GateChild. It must inspect no files and return a valid structured result with summary INITIAL_OK, files [], and architecture 'none'. Wait for it. Do not create another child.",
        expectChildFollowUpScenario,
        true,
      ),
    TIMEOUT_MS,
  );

  test(
    "identical child IDs from two parents remain parent-scoped",
    () =>
      runScenario(
        "parent-scoped-identical-child",
        "Use task.batch to start exactly two parent workers named ParentAlpha and ParentBeta. Each parent must create its own nested child with id SameChild. ParentAlpha's child must run exactly this bash command: printf 'ParentAlpha\\n'. ParentBeta's child must run exactly this bash command: printf 'ParentBeta\\n'. Wait for both.",
        expectParentScopedChildrenScenario,
        true,
      ),
    TIMEOUT_MS,
  );

  test(
    "detached task exposes persisted topology and ownership",
    () =>
      runScenario(
        "detached-task-semantics",
        "Use OMP's native task tool, not Paseo create_agent, to create exactly one detached worker named DetachedGate. It must run exactly this bash command: printf 'DetachedGate\\n'. Wait for every reachable result.",
        (items, harness, agentId) =>
          expectTaskTopologyScenario(items, harness, agentId, "DetachedGate"),
        true,
      ),
    TIMEOUT_MS,
  );

  test(
    "isolated task exposes persisted topology and ownership",
    () =>
      runScenario(
        "isolated-task-semantics",
        "Use OMP's native task tool, not Paseo create_agent, to create exactly one isolated worker named IsolatedGate. It must run exactly this bash command: printf 'IsolatedGate\\n'. Wait for every reachable result.",
        (items, harness, agentId) =>
          expectTaskTopologyScenario(items, harness, agentId, "IsolatedGate"),
        true,
      ),
    TIMEOUT_MS,
  );

  test(
    "nested task exposes persisted topology and ownership",
    () =>
      runScenario(
        "nested-task-semantics",
        "Use OMP's native task tool, not Paseo create_agent, to create exactly one normal nested worker named NestedGate. It must run exactly this bash command: printf 'NestedGate\\n'. Wait for it.",
        (items, harness, agentId) =>
          expectTaskTopologyScenario(items, harness, agentId, "NestedGate"),
        true,
      ),
    TIMEOUT_MS,
  );

  test(
    "archive and import recover a persisted child handle",
    async () => {
      const harness = await createHarness();
      try {
        const parent = await harness.client.createAgent({
          cwd: harness.cwd,
          title: "archive-import-race",
          provider: "omp",
          model: MODEL,
          modeId: "full",
        });
        await harness.client.sendMessage(
          parent.id,
          "Use OMP's native task tool, not Paseo create_agent, to create exactly one worker named ArchiveChild. It must run exactly this bash command: printf 'ARCHIVE_RACE_OK\\n'. Wait for it.",
        );
        expect((await harness.client.waitForFinish(parent.id, TIMEOUT_MS)).status).toBe("idle");
        const child = (await harness.client.fetchAgents({})).entries
          .map((entry) => entry.agent)
          .find((agent) => agent.labels?.[PARENT_AGENT_ID_LABEL] === parent.id);
        expect(child?.persistence?.sessionId).toEqual(expect.any(String));
        const handle = child!.persistence!.sessionId;
        await harness.client.refreshAgent(parent.id);
        const releasedChild = await harness.client.waitForAgentUpsert(
          child!.id,
          (snapshot) => snapshot.labels?.[PROVIDER_CHILD_OWNER_LABEL] === "paseo",
          TIMEOUT_MS,
        );
        expect(releasedChild.labels?.[PROVIDER_CHILD_OWNER_LABEL]).toBe("paseo");
        await harness.client.archiveAgent(child!.id);
        const imported = await harness.client.importAgent({
          provider: "omp",
          sessionId: handle,
          cwd: harness.cwd,
        });
        expect(imported.persistence?.nativeHandle).toBe(handle);
        await harness.client.sendMessage(
          imported.id,
          "Run exactly this bash command: printf 'ARCHIVE_IMPORT_RESUMED\\n'",
        );
        expect((await harness.client.waitForFinish(imported.id, TIMEOUT_MS)).status).toBe("idle");
        expect(
          completedTools(await timeline(harness.client, imported.id), SHELL_TOOL_PATTERN).some(
            (call) => toolResult(call).includes("ARCHIVE_IMPORT_RESUMED"),
          ),
        ).toBe(true);
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "daemon process restart resumes a persisted child handle",
    async () => {
      const harness = await createHarness();
      try {
        const parent = await harness.client.createAgent({
          cwd: harness.cwd,
          title: "exit-restart-recovery",
          provider: "omp",
          model: MODEL,
          modeId: "full",
        });
        await harness.client.sendMessage(
          parent.id,
          "Create exactly one task named RestartChild. It must run exactly this bash command: printf 'RESTART_RECOVERED\\n'. Wait for it.",
        );
        expect((await harness.client.waitForFinish(parent.id, TIMEOUT_MS)).status).toBe("idle");
        const child = (await harness.client.fetchAgents({})).entries
          .map((entry) => entry.agent)
          .find(
            (agent) =>
              agent.title === "RestartChild" && agent.labels?.[PARENT_AGENT_ID_LABEL] === parent.id,
          );
        const childItems = child ? await timeline(harness.client, child.id) : [];
        const childDiagnostic = await scenarioDiagnostic(
          harness,
          child?.id ?? parent.id,
          childItems,
        );
        expect(child?.persistence?.sessionId, childDiagnostic).toEqual(expect.any(String));
        expect(child?.labels?.[PROVIDER_CHILD_OWNER_LABEL], childDiagnostic).toBe("provider");
        const childId = child!.id;
        const handle = child!.persistence!.sessionId;
        await restartHarness(harness);
        const recovered = await harness.client.fetchAgent(childId);
        const recoveredItems = await timeline(harness.client, childId);
        const recoveredDiagnostic = await scenarioDiagnostic(harness, childId, recoveredItems);
        expect(recovered?.agent.persistence?.sessionId, recoveredDiagnostic).toBe(handle);
        expect(recovered?.agent.labels?.[PARENT_AGENT_ID_LABEL], recoveredDiagnostic).toBe(
          parent.id,
        );
        expect(recovered?.agent.labels?.[PROVIDER_CHILD_OWNER_LABEL], recoveredDiagnostic).toBe(
          "paseo",
        );
        await harness.client.sendMessage(
          childId,
          "Run exactly this bash command: printf 'RESTART_HANDLE_RESUMED\\n'",
        );
        expect((await harness.client.waitForFinish(childId, TIMEOUT_MS)).status).toBe("idle");
        const resumedItems = await timeline(harness.client, childId);
        expect(
          completedTools(resumedItems, SHELL_TOOL_PATTERN).some((call) =>
            toolResult(call).includes("RESTART_HANDLE_RESUMED"),
          ),
          await scenarioDiagnostic(harness, childId, resumedItems),
        ).toBe(true);
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "maps an unauthenticated OMP OAuth login URL onto the assistant timeline",
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-oauth-work-"));
      const home = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-oauth-home-"));
      const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-oauth-paseo-"));
      const staticDir = mkdtempSync(path.join(tmpdir(), "paseo-real-omp-oauth-static-"));
      for (const root of [cwd, home, paseoHomeRoot, staticDir]) {
        roots.add(root);
      }
      const logger = pino({ level: "silent" });
      const profile = `paseo-oauth-${randomUUID()}`;
      const runtime = new CapturingPiRuntime(
        new PiCliRuntime({
          logger,
          command: [process.env.OMP_COMMAND?.trim() || "omp"],
          runtimeSettings: {
            env: {
              HOME: home,
              PI_CONFIG_DIR: path.join(home, "config"),
              OMP_PROFILE: profile,
              XDG_DATA_HOME: path.join(home, "data"),
              XDG_STATE_HOME: path.join(home, "state"),
              XDG_CACHE_HOME: path.join(home, "cache"),
              PI_CODING_AGENT_DIR: undefined,
            },
          },
        }),
      );
      let daemon: TestPaseoDaemon | undefined;
      let client: DaemonClient | undefined;
      let loginRequestSettled = false;
      let settledLoginRequest: Promise<void> | undefined;
      let scenarioError: unknown;
      let teardownError: unknown;
      try {
        daemon = await createTestPaseoDaemon({
          agentClients: {
            omp: new OmpRpcAgentClient({ logger, runtime }),
          },
          providerOverrides: { omp: { enabled: true } },
          logger,
          paseoHomeRoot,
          staticDir,
          cleanup: false,
        });
        client = new DaemonClient({
          url: `ws://127.0.0.1:${daemon.port}/ws`,
          appVersion: "0.1.45",
        });
        await client.connect();
        await client.fetchAgents({
          subscribe: { subscriptionId: `omp-real-oauth-${randomUUID()}` },
        });
        const agent = await client.createAgent({
          cwd,
          title: "omp-real-oauth-open-url",
          provider: "omp",
          model: "openai-codex/gpt-5.6-sol",
          modeId: "full",
        });
        const session = runtime.session;
        expect(session, "OMP session must be captured after agent creation").toBeDefined();
        const loginProviders = (await session!.request({
          type: "get_login_providers",
        })) as { providers?: Array<{ id?: string; authenticated?: boolean }> };
        expect(loginProviders.providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "openai-codex",
              authenticated: false,
            }),
          ]),
        );

        settledLoginRequest = session!
          .request({
            type: "login",
            providerId: "openai-codex",
          })
          .then(
            () => {
              loginRequestSettled = true;
              return undefined;
            },
            () => {
              loginRequestSettled = true;
              return undefined;
            },
          );
        const openUrl = await waitForTimelineItem(
          client,
          agent.id,
          (item) =>
            item.type === "assistant_message" &&
            item.text.includes("[Open URL](") &&
            item.text.includes("URL:"),
        );
        expect(openUrl).toMatchObject({ type: "assistant_message" });
        await Promise.resolve();
        expect(loginRequestSettled, "OMP login must remain pending until OAuth completes").toBe(
          false,
        );
      } catch (error) {
        scenarioError = error;
      } finally {
        await client?.close().catch(() => undefined);
        try {
          await daemon?.close();
        } catch (error) {
          teardownError = error;
        }
        try {
          if (settledLoginRequest) {
            await waitForPromise(settledLoginRequest, 10_000);
          }
        } catch (error) {
          teardownError ??= error;
        }
        for (const root of [cwd, home, paseoHomeRoot, staticDir]) {
          rmSync(root, { recursive: true, force: true });
          roots.delete(root);
        }
      }
      if (scenarioError) {
        throw scenarioError;
      }
      if (teardownError) {
        throw teardownError;
      }
    },
    TIMEOUT_MS,
  );

  test(
    "native rewind creates a reloadable handle and restores the prompt",
    async () => {
      const harness = await createHarness();
      try {
        const agent = await harness.client.createAgent({
          cwd: harness.cwd,
          title: "rewind-reload-restored-prompt",
          provider: "omp",
          model: MODEL,
          modeId: "full",
        });
        const restoredPrompt = "Run exactly this bash command: printf 'BEFORE_REWIND\\n'";
        await harness.client.sendMessage(agent.id, restoredPrompt);
        expect((await harness.client.waitForFinish(agent.id, TIMEOUT_MS)).status).toBe("idle");
        const nativeMessage = (await timeline(harness.client, agent.id)).find(
          (item) => item.type === "user_message" && item.text === restoredPrompt,
        );
        expect(nativeMessage?.messageId, "OMP timeline must emit a native user message ID").toEqual(
          expect.any(String),
        );
        const nativeMessageId = nativeMessage!.messageId!;
        const before = await harness.client.fetchAgent(agent.id);
        const beforeHandle = before?.agent.persistence?.sessionId;
        expect(beforeHandle).toEqual(expect.any(String));

        const rewind = await harness.client.rewindAgent(agent.id, nativeMessageId, "conversation");
        expect(rewind.restoredPrompt).toBe(restoredPrompt);
        const after = await harness.client.fetchAgent(agent.id);
        const afterHandle = after?.agent.persistence?.sessionId;
        expect(afterHandle).toEqual(expect.any(String));
        expect(afterHandle).not.toBe(beforeHandle);
        await restartHarness(harness);
        const persisted = await harness.client.fetchAgent(agent.id);
        expect(persisted?.agent.persistence?.sessionId).toBe(afterHandle);

        await harness.client.sendMessage(
          agent.id,
          "Run exactly this bash command: printf 'REWIND_RELOAD_OK\\n'",
        );
        expect((await harness.client.waitForFinish(agent.id, TIMEOUT_MS)).status).toBe("idle");
        const reloaded = await timeline(harness.client, agent.id);
        expect(
          completedTools(reloaded, SHELL_TOOL_PATTERN).some((call) =>
            toolResult(call).includes("REWIND_RELOAD_OK"),
          ),
        ).toBe(true);
      } finally {
        await closeHarness(harness);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "native Paseo host tools and cancellation",
    () =>
      runScenario(
        "paseo-host-tools-cancel",
        'Use Paseo create_agent to create one independent agent. Use send_agent_prompt to tell it: "Run exactly this bash command: sleep 30". Cancel that agent through the native Paseo cancel_agent operation, then use wait_for_agent until it is terminal. Do not substitute OMP task for the Paseo host tools.',
        (items) => {
          const latestFrame = JSON.stringify(latestSettledTimelineItem(items));
          expectTool(items, /create_agent/i, `create_agent failed; latest=${latestFrame}`);
          expectTool(
            items,
            /send_agent_prompt/i,
            `send_agent_prompt failed; latest=${latestFrame}`,
          );
          expectTool(items, /cancel_agent/i, `cancel_agent failed; latest=${latestFrame}`);
          const waits = completedTools(items, /wait_for_agent/i);
          expect(waits.length, `wait_for_agent failed; latest=${latestFrame}`).toBeGreaterThan(0);
          expect(
            waits.map(toolResult).join("\n"),
            `wait_for_agent terminal frame invalid; latest=${latestFrame}`,
          ).toMatch(/cancel|idle|error|closed|terminal/i);
        },
      ),
    TIMEOUT_MS,
  );
});
