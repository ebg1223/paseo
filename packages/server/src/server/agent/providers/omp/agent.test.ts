import { existsSync, readFileSync } from "node:fs";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

import modelsFixture from "./__fixtures__/get_available_models_reasoning.json" with { type: "json" };
import commandUpdateFixture from "./__fixtures__/available_commands_update.json" with { type: "json" };
import subagentFramesFixture from "./__fixtures__/subagent_lifecycle_progress.json" with { type: "json" };
import todoFixture from "./__fixtures__/todo_tool_reminder_state.json" with { type: "json" };
import type {
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";
import type { PaseoToolCatalog, PaseoToolDefinition, PaseoToolResult } from "../../tools/types.js";
import { withRuntimePaseoMcpServer } from "../../runtime-mcp-config.js";
import { FakePi } from "../pi-shared/test-utils/fake-pi.js";
import type { PiModel } from "../pi-shared/rpc-types.js";
import {
  OMP_MODES,
  OMP_PASEO_MCP_SYSTEM_PROMPT,
  OmpRpcAgentClient,
  resolveOmpLaunchMode,
} from "./agent.js";
import type { OmpSubagentCardScheduler } from "./subagent-card-tracker.js";
import type { OmpSubagentLifecyclePayload, OmpSubagentProgressPayload } from "./rpc-types.js";

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "omp",
    cwd: "/tmp/paseo-omp-rpc-test",
    ...overrides,
  };
}

class ManualScheduler implements OmpSubagentCardScheduler {
  private currentMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { dueMs: number; callback: () => void }>();

  now(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { dueMs: this.currentMs + delayMs, callback });
    return { token: id };
  }

  clearTimeout(timer: { token: unknown }): void {
    if (typeof timer.token === "number") {
      this.timers.delete(timer.token);
    }
  }

  advance(ms: number): void {
    this.currentMs += ms;
    const dueTimers = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueMs <= this.currentMs)
      .sort((left, right) => left[1].dueMs - right[1].dueMs);
    for (const [id, timer] of dueTimers) {
      if (this.timers.delete(id)) {
        timer.callback();
      }
    }
  }
}

function createClient(
  pi = new FakePi(),
  options: { providerParams?: unknown; subagentCardScheduler?: OmpSubagentCardScheduler } = {},
): OmpRpcAgentClient {
  return new OmpRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: pi,
    ...options,
  });
}

async function createSession(
  pi = new FakePi(),
  options: { subagentCardScheduler?: OmpSubagentCardScheduler } = {},
  configOverrides: Partial<AgentSessionConfig> = {},
  launchContext?: AgentLaunchContext,
): Promise<{
  pi: FakePi;
  session: AgentSession;
  events: SessionEvents;
}> {
  const client = createClient(pi, options);
  const session = await client.createSession(createConfig(configOverrides), launchContext);
  const events = new SessionEvents(session);
  return { pi, session, events };
}

function createFakePaseoToolCatalog(tools: PaseoToolDefinition[]): PaseoToolCatalog {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: toolMap,
    getTool: (name) => toolMap.get(name),
    executeTool: async (name, input, context = {}) => {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new Error(`Missing fake Paseo tool ${name}`);
      }
      return await tool.handler(input, context);
    },
  };
}

class SessionEvents {
  private readonly events: AgentStreamEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: AgentStreamEvent) => boolean;
    resolve: (event: AgentStreamEvent) => void;
  }> = [];

  constructor(session: AgentSession) {
    session.subscribe((event) => {
      this.events.push(event);
      for (let index = 0; index < this.waiters.length; index += 1) {
        const waiter = this.waiters[index];
        if (waiter.predicate(event)) {
          this.waiters.splice(index, 1);
          index -= 1;
          waiter.resolve(event);
        }
      }
    });
  }

  timelineItems() {
    return this.events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline",
      )
      .map((event) => event.item);
  }

  timelineAndCompletionEvents() {
    return this.events.flatMap((event) => {
      if (event.type === "timeline") {
        return [{ type: "timeline" as const, item: event.item }];
      }
      if (event.type === "turn_completed") {
        return [{ type: "turn_completed" as const }];
      }
      return [];
    });
  }

  childSessionEvents() {
    return this.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "child_session" }> =>
        event.type === "child_session",
    );
  }

  usageEvents() {
    return this.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "usage_updated" }> =>
        event.type === "usage_updated",
    );
  }

  permissionRequests() {
    return this.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
        event.type === "permission_requested",
    );
  }

  permissionResolutions() {
    return this.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "permission_resolved" }> =>
        event.type === "permission_resolved",
    );
  }

  nextPermissionRequest(): Promise<Extract<AgentStreamEvent, { type: "permission_requested" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
        event.type === "permission_requested",
    );
  }

  nextPermissionResolution(): Promise<Extract<AgentStreamEvent, { type: "permission_resolved" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "permission_resolved" }> =>
        event.type === "permission_resolved",
    );
  }

  private nextEvent<T extends AgentStreamEvent>(
    predicate: (event: AgentStreamEvent) => event is T,
  ): Promise<T> {
    const existing = this.events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.waiters.push({
        predicate,
        resolve: (event) => resolve(event as T),
      });
    });
  }
}

function readReasoningFixtureModels(): PiModel[] {
  const response = (modelsFixture as readonly unknown[])[0];
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.models)) {
    throw new Error("Reasoning fixture is missing models");
  }
  return response.data.models.map((model): PiModel => {
    if (!isRecord(model) || typeof model.id !== "string" || typeof model.provider !== "string") {
      throw new Error("Reasoning fixture model is malformed");
    }
    const piModel: PiModel = {
      id: model.id,
      provider: model.provider,
    };
    if (typeof model.name === "string") {
      piModel.name = model.name;
    }
    if (typeof model.reasoning === "boolean") {
      piModel.reasoning = model.reasoning;
    }
    return piModel;
  });
}

function toThinkingSummary(model: {
  id: string;
  thinkingOptions?: Array<{ id: string }>;
  defaultThinkingOptionId?: string;
}) {
  return {
    id: model.id,
    thinkingOptions: model.thinkingOptions?.map(readOptionId),
    defaultThinkingOptionId: model.defaultThinkingOptionId,
  };
}

function readOptionId(option: { id: string }): string {
  return option.id;
}

function expectedReasoningSummary(model: PiModel) {
  return {
    id: `${model.provider}/${model.id}`,
    thinkingOptions: ["off", "minimal", "low", "medium", "high", "xhigh"],
    defaultThinkingOptionId: "medium",
  };
}

function nonReasoningFixtureModel(): PiModel {
  return {
    id: "plain-chat",
    provider: "fixture",
    name: "Plain Chat",
    reasoning: false,
  };
}

function readTodoToolEndFixture(index: number): {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
} {
  const record = fixtureRecord(todoFixture, index, "todo");
  if (
    record.type !== "tool_execution_end" ||
    typeof record.toolCallId !== "string" ||
    typeof record.toolName !== "string"
  ) {
    throw new Error(`Todo fixture record ${index} is not a tool_execution_end`);
  }
  return {
    type: "tool_execution_end",
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    result: record.result,
    ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
  };
}

function readTodoReminderFixture(index: number): { type: "todo_reminder"; [key: string]: unknown } {
  const record = fixtureRecord(todoFixture, index, "todo");
  if (record.type !== "todo_reminder") {
    throw new Error(`Todo fixture record ${index} is not a todo_reminder`);
  }
  return {
    ...record,
    type: "todo_reminder",
  };
}

function readStateTodoPhasesFixture(): unknown {
  const record = fixtureRecord(todoFixture, 3, "todo");
  if (!isRecord(record.data)) {
    throw new Error("Todo state fixture is missing data");
  }
  return record.data.todoPhases;
}

function readCommandUpdateFixture(): { type: "available_commands_update"; [key: string]: unknown } {
  const record = fixtureRecord(commandUpdateFixture, 0, "commands");
  if (record.type !== "available_commands_update") {
    throw new Error("Command fixture is not an available_commands_update");
  }
  return {
    ...record,
    type: "available_commands_update",
  };
}

function readSubagentLifecycleFixture(): OmpSubagentLifecyclePayload {
  const frame = (subagentFramesFixture as readonly unknown[]).find(
    (candidate) => isRecord(candidate) && candidate.type === "subagent_lifecycle",
  );
  if (!isRecord(frame) || !isRecord(frame.payload)) {
    throw new Error("Subagent fixture is missing lifecycle frame");
  }
  return frame.payload as unknown as OmpSubagentLifecyclePayload;
}

function readProgressWithRecentToolFixture(): OmpSubagentProgressPayload {
  const frame = (subagentFramesFixture as readonly unknown[]).find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.type === "subagent_progress" &&
      isRecord(candidate.payload) &&
      isRecord(candidate.payload.progress) &&
      Array.isArray(candidate.payload.progress.recentTools) &&
      candidate.payload.progress.recentTools.length > 0,
  );
  if (!isRecord(frame) || !isRecord(frame.payload)) {
    throw new Error("Subagent fixture is missing progress frame with recent tools");
  }
  return frame.payload as unknown as OmpSubagentProgressPayload;
}

function fixtureRecord(values: unknown, index: number, label: string): Record<string, unknown> {
  if (!Array.isArray(values) || !isRecord(values[index])) {
    throw new Error(`Missing ${label} fixture record ${index}`);
  }
  return values[index];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for condition");
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("OMP RPC agent", () => {
  test("manifest and catalog expose only source-verified OMP launch-time modes", async () => {
    const definition = getAgentProviderDefinition("omp");
    expect(definition.defaultModeId).toBe("full");
    expect(definition.modes).toEqual(OMP_MODES);
    expect(definition.modes.map((mode) => mode.id)).toEqual(["full", "ask"]);

    const pi = new FakePi(["omp"]);
    const catalog = await createClient(pi).fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/paseo-omp-modes-test",
      force: false,
    });

    expect(catalog.modes).toEqual(OMP_MODES);
    expect(pi.recordedLaunches[0]?.argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "yolo",
    ]);
  });

  test("maps OMP modes to launch flags and reports the launch mode", async () => {
    expect(resolveOmpLaunchMode(undefined)).toEqual({
      modeId: "full",
      extraArgs: ["--approval-mode", "yolo"],
    });
    expect(resolveOmpLaunchMode("ask")).toEqual({
      modeId: "ask",
      extraArgs: ["--approval-mode", "always-ask"],
    });
    expect(
      resolveOmpLaunchMode("full", {
        smolModel: "openai/gpt-5-mini",
        slowModel: "anthropic/claude-opus-4-1",
        planModel: "openai/o3",
      }),
    ).toEqual({
      modeId: "full",
      extraArgs: [
        "--approval-mode",
        "yolo",
        "--smol",
        "openai/gpt-5-mini",
        "--slow",
        "anthropic/claude-opus-4-1",
        "--plan",
        "openai/o3",
      ],
    });
    expect(() => resolveOmpLaunchMode("plan")).toThrow("Unsupported OMP mode 'plan'");

    const pi = new FakePi(["omp"]);
    const client = createClient(pi);
    expect(client.capabilities.supportsMcpServers).toBe(true);
    expect(client.capabilities.supportsNativePaseoTools).toBe(true);
    const session = await client.createSession(createConfig({ modeId: "ask" }));
    const launch = pi.recordedLaunches[0];

    expect(session.capabilities.supportsMcpServers).toBe(true);
    expect(session.capabilities.supportsNativePaseoTools).toBe(true);
    expect(launch?.systemPrompt).toBe(OMP_PASEO_MCP_SYSTEM_PROMPT);
    expect(launch?.argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "always-ask",
      "--thinking",
      "medium",
      "--append-system-prompt",
      OMP_PASEO_MCP_SYSTEM_PROMPT,
    ]);
    await expect(session.getAvailableModes()).resolves.toEqual(OMP_MODES);
    await expect(session.getCurrentMode()).resolves.toBe("ask");
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      provider: "omp",
      modeId: "ask",
    });
    await expect(session.setMode("full")).resolves.toEqual({
      type: "info",
      message:
        "OMP approval mode is set when the agent launches. Start a new OMP session to use a different mode.",
    });
    await expect(session.getCurrentMode()).resolves.toBe("ask");
  });

  test("passes OMP model-role params through as launch flags", async () => {
    const pi = new FakePi(["omp"]);
    const client = createClient(pi, {
      providerParams: {
        smolModel: "openai/gpt-5-mini",
        slowModel: "anthropic/claude-opus-4-1",
        planModel: "openai/o3",
      },
    });

    await client.createSession(createConfig({ modeId: "ask" }));

    const launch = pi.recordedLaunches[0];
    expect(launch?.argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "always-ask",
      "--smol",
      "openai/gpt-5-mini",
      "--slow",
      "anthropic/claude-opus-4-1",
      "--plan",
      "openai/o3",
      "--thinking",
      "medium",
      "--append-system-prompt",
      OMP_PASEO_MCP_SYSTEM_PROMPT,
    ]);
  });

  test("appends the OMP task-versus-Paseo-agent system prompt context", async () => {
    const pi = new FakePi(["omp"]);
    await createSession(
      pi,
      {},
      {
        systemPrompt: "User instructions.",
        daemonAppendSystemPrompt: "Daemon context.",
      },
    );

    expect(pi.recordedLaunches[0]?.systemPrompt).toBe(
      ["User instructions.", "Daemon context.", OMP_PASEO_MCP_SYSTEM_PROMPT].join("\n\n"),
    );
  });

  test("writes OMP MCP config without probing for pi-mcp-adapter", async () => {
    const pi = new FakePi(["omp"]);
    const client = createClient(pi);
    const config = withRuntimePaseoMcpServer({
      config: createConfig({
        mcpServers: {
          localSecret: {
            type: "stdio",
            command: "node",
            args: ["secret-server.js"],
            env: { SECRET_NUMBER: "314159" },
          },
        },
      }),
      agentId: "agent-omp-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "secret-token",
    });

    const session = await client.createSession(config);

    expect(pi.recordedLaunches).toHaveLength(1);
    const launch = pi.recordedLaunches[0];
    expect(launch?.mcpConfigPath).toEqual(expect.any(String));
    expect(launch?.argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "yolo",
      "--thinking",
      "medium",
      "--append-system-prompt",
      OMP_PASEO_MCP_SYSTEM_PROMPT,
      "--mcp-config",
      launch?.mcpConfigPath,
    ]);
    expect(session.capabilities.supportsMcpServers).toBe(true);

    const injectedConfig = JSON.parse(readFileSync(launch!.mcpConfigPath!, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(injectedConfig).toEqual({
      mcpServers: {
        paseo: {
          url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-omp-1",
          headers: { Authorization: "Bearer secret-token" },
          auth: false,
          oauth: false,
        },
        localSecret: {
          command: "node",
          args: ["secret-server.js"],
          env: { SECRET_NUMBER: "314159" },
        },
      },
    });

    await session.close();
    expect(existsSync(launch!.mcpConfigPath!)).toBe(false);
  });

  test("registers launch-context Paseo tools through native OMP host tools", async () => {
    const catalog = createFakePaseoToolCatalog([
      {
        name: "create_agent",
        title: "Create agent",
        description: "Create a child agent.",
        inputSchema: {},
        handler: async () => ({ content: [] }),
      },
    ]);
    const pi = new FakePi(["omp"]);
    const client = createClient(pi);

    const session = await client.createSession(createConfig(), {
      agentId: "agent-omp-parent",
      paseoTools: catalog,
    });
    const fakeSession = pi.latestSession();

    expect(fakeSession.hostToolSetRequests).toEqual([
      {
        tools: [
          {
            name: "create_agent",
            label: "Create agent",
            description: "Create a child agent.",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ]);
    expect(pi.recordedLaunches[0]?.mcpConfigPath).toBeUndefined();
    expect(session.capabilities.supportsNativePaseoTools).toBe(true);
  });

  test("routes OMP host_tool_call through the caller-scoped Paseo catalog", async () => {
    const calls: Array<{ input: unknown; signal: AbortSignal | undefined }> = [];
    const catalog = createFakePaseoToolCatalog([
      {
        name: "create_agent",
        description: "Create a child agent.",
        inputSchema: {},
        handler: async (input, context) => {
          calls.push({ input, signal: context.signal });
          context.sendUpdate?.({
            content: [{ type: "text", text: "creating child" }],
            structuredContent: { phase: "creating" },
          });
          return {
            content: [],
            structuredContent: {
              agentId: "agent-child-1",
              status: "running",
            },
          };
        },
      },
    ]);
    const { pi } = await createSession(new FakePi(["omp"]), {}, {}, { paseoTools: catalog });
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "host_tool_call",
      id: "host-call-1",
      toolCallId: "provider-tool-call-1",
      toolName: "create_agent",
      arguments: { initialPrompt: "Inspect the bug" },
    });

    await waitFor(() => fakeSession.rawFrames.length === 2);
    expect(calls).toEqual([
      {
        input: { initialPrompt: "Inspect the bug", notifyOnFinish: false },
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(fakeSession.rawFrames).toEqual([
      {
        type: "host_tool_update",
        id: "host-call-1",
        partialResult: {
          content: [{ type: "text", text: "creating child" }],
          details: { phase: "creating" },
        },
      },
      {
        type: "host_tool_result",
        id: "host-call-1",
        result: {
          content: [
            {
              type: "text",
              text: '{\n  "agentId": "agent-child-1",\n  "status": "running"\n}',
            },
          ],
          details: {
            agentId: "agent-child-1",
            status: "running",
          },
        },
      },
    ]);
  });

  test("maps Paseo tool isError results to OMP host_tool_result errors", async () => {
    const catalog = createFakePaseoToolCatalog([
      {
        name: "wait_for_agent",
        description: "Wait for a child agent.",
        inputSchema: {},
        handler: async (): Promise<PaseoToolResult> => ({
          content: [{ type: "text", text: "agent failed" }],
          structuredContent: { agentId: "agent-child-1" },
          isError: true,
        }),
      },
    ]);
    const { pi } = await createSession(new FakePi(["omp"]), {}, {}, { paseoTools: catalog });
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "host_tool_call",
      id: "host-call-error",
      toolCallId: "provider-tool-call-error",
      toolName: "wait_for_agent",
      arguments: { agentId: "agent-child-1" },
    });

    await waitFor(() => fakeSession.rawFrames.length === 1);
    expect(fakeSession.rawFrames).toEqual([
      {
        type: "host_tool_result",
        id: "host-call-error",
        result: {
          content: [{ type: "text", text: "agent failed" }],
          details: { agentId: "agent-child-1" },
          isError: true,
        },
        isError: true,
      },
    ]);
  });

  test("aborts and drops canceled OMP host tool results", async () => {
    const deferred = createDeferred<PaseoToolResult>();
    let signal: AbortSignal | undefined;
    const catalog = createFakePaseoToolCatalog([
      {
        name: "wait_for_agent",
        description: "Wait for a child agent.",
        inputSchema: {},
        handler: async (_input, context) => {
          signal = context.signal;
          return await deferred.promise;
        },
      },
    ]);
    const { pi } = await createSession(new FakePi(["omp"]), {}, {}, { paseoTools: catalog });
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "host_tool_call",
      id: "host-call-cancel",
      toolCallId: "provider-tool-call-cancel",
      toolName: "wait_for_agent",
      arguments: { agentId: "agent-child-1" },
    });
    await waitFor(() => signal !== undefined);
    fakeSession.emit({
      type: "host_tool_cancel",
      id: "cancel-1",
      targetId: "host-call-cancel",
    });

    expect(signal?.aborted).toBe(true);
    deferred.resolve({ content: [{ type: "text", text: "late result" }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeSession.rawFrames).toEqual([]);
  });

  test("does not block a second OMP host tool frame behind a slow handler", async () => {
    const slow = createDeferred<PaseoToolResult>();
    const catalog = createFakePaseoToolCatalog([
      {
        name: "wait_for_agent",
        description: "Slow wait.",
        inputSchema: {},
        handler: async () => await slow.promise,
      },
      {
        name: "get_agent_status",
        description: "Fast status.",
        inputSchema: {},
        handler: async () => ({
          content: [{ type: "text", text: "fast status" }],
        }),
      },
    ]);
    const { pi } = await createSession(new FakePi(["omp"]), {}, {}, { paseoTools: catalog });
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "host_tool_call",
      id: "host-call-slow",
      toolCallId: "provider-tool-call-slow",
      toolName: "wait_for_agent",
      arguments: { agentId: "agent-child-1" },
    });
    fakeSession.emit({
      type: "host_tool_call",
      id: "host-call-fast",
      toolCallId: "provider-tool-call-fast",
      toolName: "get_agent_status",
      arguments: { agentId: "agent-child-2" },
    });

    await waitFor(() => fakeSession.rawFrames.length === 1);
    expect(fakeSession.rawFrames[0]).toEqual({
      type: "host_tool_result",
      id: "host-call-fast",
      result: {
        content: [{ type: "text", text: "fast status" }],
      },
    });

    slow.resolve({ content: [{ type: "text", text: "slow done" }] });
    await waitFor(() => fakeSession.rawFrames.length === 2);
    expect(fakeSession.rawFrames[1]).toEqual({
      type: "host_tool_result",
      id: "host-call-slow",
      result: {
        content: [{ type: "text", text: "slow done" }],
      },
    });
  });

  test("bridges OMP rpc-ui tool approval selects through tool permissions", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("run command");
    fakeSession.emit({
      type: "extension_ui_request",
      id: "approval-bash",
      method: "select",
      title: "Allow tool: bash\nCommand: echo rpc-ui-hi",
      options: ["Approve", "Deny"],
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      id: "approval-bash",
      provider: "omp",
      name: "bash",
      kind: "tool",
      title: "Allow tool: bash",
      detail: { type: "shell", command: "echo rpc-ui-hi" },
      metadata: {
        extensionUiMethod: "select",
        toolApproval: "omp_rpc_ui_tool_approval",
        toolName: "bash",
        toolArgs: { command: "echo rpc-ui-hi" },
        approveValue: "Approve",
        denyValue: "Deny",
      },
    });
    expect(session.getPendingPermissions()).toHaveLength(1);

    await session.respondToPermission("approval-bash", { behavior: "allow" });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "approval-bash", response: { value: "Approve" } },
    ]);
    expect(session.getPendingPermissions()).toEqual([]);
    expect(events.permissionResolutions()).toEqual([
      expect.objectContaining({
        requestId: "approval-bash",
        resolution: { behavior: "allow" },
      }),
    ]);
  });

  test("denies OMP rpc-ui tool approvals with the Deny select value", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "approval-write",
      method: "select",
      title: "Allow tool: write\nPath: created.txt\nContent:\nhello write",
      options: ["Approve", "Deny"],
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      provider: "omp",
      name: "write",
      kind: "tool",
      detail: { type: "write", filePath: "created.txt", content: "hello write" },
    });

    await session.respondToPermission("approval-write", {
      behavior: "deny",
      message: "No",
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "approval-write", response: { value: "Deny" } },
    ]);
  });

  test("keeps OMP ask_user chained select and optional comment passthrough working", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "ask-tool-1",
      toolName: "ask_user",
      args: {
        question: "Pick a path",
        options: ["A", "B"],
        allowComment: true,
        allowFreeform: false,
      },
    });
    fakeSession.emit({
      type: "extension_ui_request",
      id: "ask-select",
      method: "select",
      title: "Pick a path",
      options: ["A", "B"],
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      id: "ask-select",
      provider: "omp",
      name: "OMP ask_user",
      kind: "question",
      input: {
        questions: [
          {
            question: "Pick a path",
            header: "Response",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
          {
            question: "Optional comment",
            header: "Comment",
            options: [],
            multiSelect: false,
            placeholder: "Optional comment (press Enter to skip)...",
            allowEmpty: true,
          },
        ],
      },
    });

    await session.respondToPermission("ask-select", {
      behavior: "allow",
      updatedInput: { answers: { Response: "B", Comment: "Looks good" } },
    });

    fakeSession.emit({
      type: "extension_ui_request",
      id: "ask-comment",
      method: "input",
      title: "Pick a path\n\nSelected option:\n- B",
      placeholder: "Optional comment (press Enter to skip)...",
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "ask-select", response: { value: "B" } },
      { id: "ask-comment", response: { value: "Looks good" } },
    ]);
  });

  test("passes unrecognized OMP rpc-ui dialogs through the existing question bridge", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "plain-select",
      method: "select",
      title: "Probe select",
      options: ["first", "second"],
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      id: "plain-select",
      provider: "omp",
      name: "OMP select",
      kind: "question",
      title: "Probe select",
      input: {
        questions: [
          {
            question: "Probe select",
            header: "Response",
            options: [{ label: "first" }, { label: "second" }],
            multiSelect: false,
          },
        ],
      },
    });

    await session.respondToPermission("plain-select", {
      behavior: "allow",
      updatedInput: { answers: { Response: "second" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "plain-select", response: { value: "second" } },
    ]);
  });

  test("maps fixture reasoning models to the inherited off-through-xhigh thinking ladder and gates non-reasoning models", async () => {
    const reasoningModels = readReasoningFixtureModels();
    const nonReasoningModel = nonReasoningFixtureModel();
    const pi = new FakePi();
    pi.queueSessionSetup((session) => {
      session.models = [...reasoningModels, nonReasoningModel];
    });
    const catalog = await createClient(pi).fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/paseo-omp-models-test",
      force: false,
    });

    expect(catalog.models.map(toThinkingSummary)).toEqual([
      ...reasoningModels.map(expectedReasoningSummary),
      {
        id: `${nonReasoningModel.provider}/${nonReasoningModel.id}`,
        thinkingOptions: undefined,
        defaultThinkingOptionId: undefined,
      },
    ]);
  });

  test("suppresses raw todo tool cards and emits todo timeline items from tool results and reminders", async () => {
    const { pi, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit(readTodoToolEndFixture(1));
    fakeSession.emit(readTodoReminderFixture(2));

    expect(events.timelineItems()).toEqual([
      {
        type: "todo",
        items: [
          { text: "alpha task", completed: true },
          { text: "beta task", completed: false },
          { text: "gamma task", completed: false },
        ],
      },
      {
        type: "todo",
        items: [
          { text: "beta task", completed: false },
          { text: "gamma task", completed: false },
        ],
      },
    ]);
  });

  test("hydrates current todo state during history replay", async () => {
    const pi = new FakePi();
    pi.queueSessionSetup((session) => {
      session.state = {
        ...session.state,
        todoPhases: readStateTodoPhasesFixture(),
      };
    });
    const { session } = await createSession(pi);
    const historyEvents: AgentStreamEvent[] = [];

    for await (const event of session.streamHistory()) {
      historyEvents.push(event);
    }

    expect(historyEvents).toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "todo",
          items: [
            { text: "alpha task", completed: true },
            { text: "beta task", completed: false },
            { text: "gamma task", completed: false },
          ],
        },
      },
    ]);
  });

  test("does not emit duplicate consecutive todo timeline items", async () => {
    const { pi, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit(readTodoToolEndFixture(1));
    fakeSession.emit({
      type: "todo_reminder",
      todos: [
        { content: "alpha task", status: "completed" },
        { content: "beta task", status: "in_progress" },
        { content: "gamma task", status: "pending" },
      ],
    });

    expect(events.timelineItems()).toEqual([
      {
        type: "todo",
        items: [
          { text: "alpha task", completed: true },
          { text: "beta task", completed: false },
          { text: "gamma task", completed: false },
        ],
      },
    ]);
  });

  test("uses refreshed OMP context usage over stats-derived context usage after turns", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.stats = {
      tokens: { input: 10, output: 5, cacheRead: 3 },
      cost: 0.25,
      contextUsage: {
        tokens: 1,
        contextWindow: 2,
        percent: 50,
      },
    };
    fakeSession.state = {
      ...fakeSession.state,
      contextUsage: {
        tokens: 23656,
        contextWindow: 272000,
        percent: 8.697058823529412,
      },
    };

    await session.startTurn("measure usage");
    fakeSession.finishTurn();
    await waitFor(() => events.usageEvents().length === 1);

    expect(events.usageEvents()).toEqual([
      {
        type: "usage_updated",
        provider: "omp",
        turnId: expect.any(String),
        usage: {
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 5,
          totalCostUsd: 0.25,
          contextWindowMaxTokens: 272000,
          contextWindowUsedTokens: 23656,
        },
      },
    ]);
  });

  test("refreshes listCommands from available_commands_update frames", async () => {
    const { pi, session } = await createSession();
    pi.latestSession().emit(readCommandUpdateFixture());

    const commands = await session.listCommands();

    expect(commands.find((command) => command.name === "todo")).toEqual({
      name: "todo",
      description: "Manage todos",
      argumentHint: "<subcommand>",
      kind: "command",
    });
    expect(commands.find((command) => command.name === "handoff")).toEqual({
      name: "handoff",
      description: "Hand off from planning to implementation",
      argumentHint: "[instructions]",
      kind: "command",
    });
  });

  test("handles OMP handoff out-of-band without adding it to Pi", async () => {
    const { pi, session } = await createSession();
    const handler = session.tryHandleOutOfBand?.("/handoff implement the approved plan");
    if (!handler) {
      throw new Error("Expected OMP handoff handler");
    }

    await handler.run({ emit: () => undefined });

    expect(pi.latestSession().handoffRequests).toEqual([
      { customInstructions: "implement the approved plan" },
    ]);
  });

  test("correlates prompt_result IDs and flushes buffered output before completion", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.promptAck = { requestId: "prompt-1" };

    await session.startTurn("/local command");
    await waitFor(() => fakeSession.prompts.length === 1);
    fakeSession.emit({ type: "command_output", text: "first\n" });
    fakeSession.emit({ type: "prompt_result", id: "stale", agentInvoked: false });
    await Promise.resolve();
    expect(events.timelineAndCompletionEvents()).toEqual([]);

    fakeSession.emit({ type: "command_output", text: "second\n" });
    fakeSession.emit({ type: "prompt_result", id: "prompt-1", agentInvoked: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(events.timelineAndCompletionEvents()).toEqual([
      { type: "timeline", item: { type: "user_message", text: "/local command" } },
      { type: "timeline", item: { type: "assistant_message", text: "first" } },
      { type: "timeline", item: { type: "assistant_message", text: "second" } },
      { type: "turn_completed" },
    ]);
  });

  test("sends steer and follow-up out-of-band without starting a turn", async () => {
    const { pi, session } = await createSession();
    const steer = session.tryHandleOutOfBand?.("/steer correct the active work");
    const followUp = session.tryHandleOutOfBand?.("/follow-up verify the result");
    if (!steer || !followUp) {
      throw new Error("Expected OMP out-of-band handlers");
    }

    await steer.run({ emit: () => undefined });
    await followUp.run({ emit: () => undefined });

    expect(pi.latestSession().prompts).toEqual([]);
    expect(pi.latestSession().rawFrames).toEqual([
      { type: "steer", message: "correct the active work" },
      { type: "follow_up", message: "verify the result" },
    ]);
  });

  test("persists open_url as client-visible Markdown without requesting permission", async () => {
    const { pi, events } = await createSession();
    pi.latestSession().emit({
      type: "extension_ui_request",
      id: "oauth",
      method: "open_url",
      url: "https://auth.example/start",
      launchUrl: "https://auth.example/launch",
      instructions: "Complete sign-in in your browser.",
    });

    expect(events.timelineItems()).toContainEqual({
      type: "assistant_message",
      text: "[Open URL](https://auth.example/start)\nURL: https://auth.example/start\nLaunch URL: https://auth.example/launch\n\nComplete sign-in in your browser.",
    });
  });

  test("coalesces live subagent poll calls by target set", async () => {
    const { pi, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "poll-1",
      toolName: "subagent",
      args: { poll: ["job-b", "job-a"] },
    });
    fakeSession.emit({
      type: "tool_execution_end",
      toolCallId: "poll-1",
      toolName: "subagent",
      result: { content: [{ type: "text", text: "first poll" }] },
      isError: false,
    });
    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "poll-2",
      toolName: "subagent",
      args: { poll: ["job-a", "job-b"] },
    });
    fakeSession.emit({
      type: "tool_execution_end",
      toolCallId: "poll-2",
      toolName: "subagent",
      result: { content: [{ type: "text", text: "second poll" }] },
      isError: false,
    });
    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "poll-3",
      toolName: "subagent",
      args: { poll: ["job-c"] },
    });
    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "spawn-1",
      toolName: "subagent",
      args: { spawn: [{ task: "go" }] },
    });
    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "echo hi" },
    });

    expect(
      events.timelineItems().map((item) => (item.type === "tool_call" ? item.callId : null)),
    ).toEqual([
      "omp-poll:job-a,job-b",
      "omp-poll:job-a,job-b",
      "omp-poll:job-a,job-b",
      "omp-poll:job-a,job-b",
      "omp-poll:job-c",
      "spawn-1",
      "bash-1",
    ]);
  });

  test("folds live OMP subagent progress into the owning task tool call card", async () => {
    const scheduler = new ManualScheduler();
    const { pi, events } = await createSession(new FakePi(), {
      subagentCardScheduler: scheduler,
    });
    const fakeSession = pi.latestSession();
    const lifecycle = readSubagentLifecycleFixture();
    const progress = readProgressWithRecentToolFixture();
    const parentToolCallId = lifecycle.parentToolCallId;
    if (!parentToolCallId) {
      throw new Error("Subagent lifecycle fixture is missing parentToolCallId");
    }

    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: parentToolCallId,
      toolName: "task",
      args: {
        agent: "task",
        description: "Run echo in subagent",
      },
    });
    fakeSession.emit({
      type: "subagent_lifecycle",
      payload: lifecycle,
    });
    fakeSession.emit({
      type: "subagent_progress",
      payload: progress,
    });
    fakeSession.emit({
      type: "tool_execution_end",
      toolCallId: parentToolCallId,
      toolName: "task",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });
    scheduler.advance(500);

    const taskItems = events
      .timelineItems()
      .filter(
        (item) =>
          item.type === "tool_call" &&
          item.callId === parentToolCallId &&
          item.detail.type === "sub_agent",
      );

    expect(taskItems).toEqual([
      {
        type: "tool_call",
        callId: parentToolCallId,
        name: "task",
        status: "running",
        detail: {
          type: "sub_agent",
          subAgentType: "task",
          description: "Run echo in subagent",
          log: "",
        },
        error: null,
      },
      {
        type: "tool_call",
        callId: parentToolCallId,
        name: "task",
        status: "running",
        detail: {
          type: "sub_agent",
          subAgentType: "task",
          description: "Run echo in subagent",
          childSessionId: "/tmp/omp-task-152709ccd8364628/EchoSubagent.jsonl",
          children: [
            {
              sessionId: "/tmp/omp-task-152709ccd8364628/EchoSubagent.jsonl",
              label: "task — Run echo in subagent",
              status: "running",
            },
          ],
          log: "EchoSubagent started",
        },
        error: null,
      },
      {
        type: "tool_call",
        callId: parentToolCallId,
        name: "task",
        status: "completed",
        detail: {
          type: "sub_agent",
          subAgentType: "task",
          description: "Run echo in subagent",
          childSessionId: "/tmp/omp-task-152709ccd8364628/EchoSubagent.jsonl",
          children: [
            {
              sessionId: "/tmp/omp-task-152709ccd8364628/EchoSubagent.jsonl",
              label: "task — Run echo in subagent",
              status: "running",
            },
          ],
          log: "EchoSubagent started\n[bash] echo subagent-hi",
        },
        error: null,
      },
    ]);
  });

  test("uses the native session name as title instead of the lifecycle UUID", async () => {
    const { pi, events } = await createSession();
    const lifecycle = { ...readSubagentLifecycleFixture(), id: "019f5ce9-affa-7000-test" };

    pi.latestSession().emit({
      type: "subagent_lifecycle",
      payload: lifecycle,
    });

    expect(events.timelineItems()).toEqual([]);
    expect(events.childSessionEvents()).toEqual([
      {
        type: "child_session",
        provider: "omp",
        childSessionId: "/tmp/omp-task-152709ccd8364628/EchoSubagent.jsonl",
        status: "running",
        ownership: { owner: "provider" },
        nativeChildId: lifecycle.id,
        parentToolCallId: lifecycle.parentToolCallId,
        childIndex: lifecycle.index,
        title: "EchoSubagent",
      },
    ]);
  });

  test("absorbs live omp system-notice custom messages as synthetic tool calls", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();
    const notice = [
      "<system-notice>",
      "Background job DocsSmokeTwo has completed. Resume your work using the result below.",
      '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
      "<output>done</output>",
      "</task-result>",
      "</system-notice>",
      "DocsSmokeTwo is now idle - transcript at history://DocsSmokeTwo",
    ].join("\n");

    await session.startTurn("run the smoke checks");
    fakeSession.emit({
      type: "message_end",
      message: { role: "custom", content: [{ type: "text", text: notice }] },
    });

    expect(events.timelineAndCompletionEvents()).toEqual([
      {
        type: "timeline",
        item: {
          type: "tool_call",
          callId: "omp-notice:DocsSmokeTwo",
          name: "task_notification",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "Background job DocsSmokeTwo completed",
            text: notice,
            icon: "wrench",
          },
          metadata: {
            synthetic: true,
            source: "omp_system_notice",
            taskId: "DocsSmokeTwo",
            subagentType: "explore",
            status: "completed",
          },
          error: null,
        },
      },
      { type: "turn_completed" },
    ]);
  });
});
