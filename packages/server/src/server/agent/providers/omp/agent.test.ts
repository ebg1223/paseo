import pino from "pino";
import { describe, expect, test } from "vitest";

import modelsFixture from "./__fixtures__/get_available_models_reasoning.json" with { type: "json" };
import commandUpdateFixture from "./__fixtures__/available_commands_update.json" with { type: "json" };
import subagentFramesFixture from "./__fixtures__/subagent_lifecycle_progress.json" with { type: "json" };
import todoFixture from "./__fixtures__/todo_tool_reminder_state.json" with { type: "json" };
import type { AgentSession, AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { FakePi } from "../pi-shared/test-utils/fake-pi.js";
import type { PiModel } from "../pi-shared/rpc-types.js";
import { OmpRpcAgentClient } from "./agent.js";
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
  options: { subagentCardScheduler?: OmpSubagentCardScheduler } = {},
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
): Promise<{
  pi: FakePi;
  session: AgentSession;
  events: SessionEvents;
}> {
  const client = createClient(pi, options);
  const session = await client.createSession(createConfig());
  const events = new SessionEvents(session);
  return { pi, session, events };
}

class SessionEvents {
  private readonly events: AgentStreamEvent[] = [];

  constructor(session: AgentSession) {
    session.subscribe((event) => {
      this.events.push(event);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("OMP RPC agent", () => {
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
          log: "EchoSubagent started\n[bash] echo subagent-hi",
        },
        error: null,
      },
    ]);
  });

  test("ignores subagent card updates whose parent task tool call is unknown", async () => {
    const { pi, events } = await createSession();
    const lifecycle = readSubagentLifecycleFixture();

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
        title: "Run echo in subagent",
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
