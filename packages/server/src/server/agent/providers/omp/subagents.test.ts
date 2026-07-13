import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentSession, AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { FakePi, type FakePiSession } from "../pi-shared/test-utils/fake-pi.js";
import { OmpRpcAgentClient } from "./agent.js";

const TEST_CWD = "/tmp/paseo-pi-subagent-test";

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "omp",
    cwd: TEST_CWD,
    ...overrides,
  };
}

function createClient(pi = new FakePi()): OmpRpcAgentClient {
  return new OmpRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: pi,
  });
}

async function createParentSession(pi = new FakePi()): Promise<{
  pi: FakePi;
  client: OmpRpcAgentClient;
  session: AgentSession;
  events: SessionEvents;
}> {
  const client = createClient(pi);
  const session = await client.createSession(createConfig());
  return { pi, client, session, events: new SessionEvents(session) };
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

  childSessionEvents(): Array<Extract<AgentStreamEvent, { type: "child_session" }>> {
    return this.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: "child_session" }> =>
        event.type === "child_session",
    );
  }

  timelineItems(): Array<Extract<AgentStreamEvent, { type: "timeline" }>["item"]> {
    return this.events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
  }

  nextTimelineItem(
    predicate: (item: Extract<AgentStreamEvent, { type: "timeline" }>["item"]) => boolean,
  ): Promise<Extract<AgentStreamEvent, { type: "timeline" }>["item"]> {
    const existing = this.timelineItems().find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.waiters.push({
        predicate: (event) => event.type === "timeline" && predicate(event.item),
        resolve: (event) => {
          if (event.type !== "timeline") {
            throw new Error("Expected a timeline event");
          }
          resolve(event.item);
        },
      });
    });
  }

  turnEvents(): AgentStreamEvent[] {
    return this.events.filter(
      (event) =>
        event.type === "turn_started" ||
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled",
    );
  }

  nextEvent(predicate: (event: AgentStreamEvent) => boolean): Promise<AgentStreamEvent> {
    const existing = this.events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }
}

async function waitForSubagentMessageRequestCount(
  session: FakePiSession,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (session.subagentMessageRequests.length >= expectedCount) {
      await Promise.resolve();
      return;
    }
    await Promise.resolve();
  }
  throw new Error(
    `Expected ${expectedCount} subagent message requests, saw ${session.subagentMessageRequests.length}`,
  );
}

async function collectStreamHistory(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of session.streamHistory()) {
    events.push(event);
  }
  return events;
}

function ompNotice(taskId: string): string {
  return [
    "<system-notice>",
    `Background job ${taskId} has completed. Resume your work using the result below.`,
    `<task-result id="${taskId}" agent="explore" status="completed" duration="3.2s">`,
    "<output>done</output>",
    "</task-result>",
    "</system-notice>",
  ].join("\n");
}

function ompHookTranscript(taskId: string) {
  return [
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: `${taskId}-poll-1`,
          name: "subagent",
          arguments: { poll: ["job-b", "job-a"] },
        },
      ],
    },
    {
      role: "toolResult" as const,
      toolCallId: `${taskId}-poll-1`,
      toolName: "subagent",
      content: [{ type: "text" as const, text: "first poll" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: `${taskId}-poll-2`,
          name: "subagent",
          arguments: { poll: ["job-a", "job-b"] },
        },
      ],
    },
    {
      role: "custom" as const,
      content: ompNotice(taskId),
    },
  ];
}

function expectOmpHookedTranscript(
  items: Array<Extract<AgentStreamEvent, { type: "timeline" }>["item"]>,
  taskId: string,
): void {
  expect(items.map((item) => (item.type === "tool_call" ? item.callId : null))).toContain(
    "omp-poll:job-a,job-b",
  );
  expect(items).toContainEqual(
    expect.objectContaining({
      type: "tool_call",
      callId: `omp-notice:${taskId}`,
      name: "task_notification",
      status: "completed",
    }),
  );
  expect(items).not.toContainEqual({ type: "assistant_message", text: ompNotice(taskId) });
}

function writeImportableSessionFile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-subagent-import-"));
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, "subagent.jsonl");
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "subagent", cwd }),
      JSON.stringify({ type: "session_init", isolated: false, resumable: true }),
    ].join("\n") + "\n",
    "utf8",
  );
  return sessionFile;
}

function writeSessionFile(
  filePath: string,
  input: { id: string; cwd: string; timestamp: string; prompt: string },
): void {
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: input.id,
        timestamp: input.timestamp,
        cwd: input.cwd,
      }),
      JSON.stringify({
        type: "message",
        id: `${input.id}-message`,
        timestamp: new Date(new Date(input.timestamp).getTime() + 1000).toISOString(),
        message: { role: "user", content: input.prompt },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
}

describe("Pi native subagents", () => {
  test("emits child_session events for lifecycle frames with session files", async () => {
    const { pi, events } = await createParentSession();
    const sessionFile = "/tmp/pi-subagent-1.jsonl";

    pi.latestSession().emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-1",
        agent: "explore",
        description: "Explore implementation",
        status: "started",
        sessionFile,
        index: 0,
        detached: false,
      },
    });
    pi.latestSession().emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-1",
        agent: "explore",
        description: "Explore implementation",
        status: "completed",
        sessionFile,
        index: 0,
        detached: false,
      },
    });

    expect(events.childSessionEvents()).toEqual([
      {
        type: "child_session",
        provider: "omp",
        childSessionId: sessionFile,
        status: "running",
        ownership: { owner: "provider" },
        nativeChildId: "subagent-1",
        parentToolCallId: undefined,
        childIndex: 0,
        title: "pi-subagent-1",
      },
      {
        type: "child_session",
        provider: "omp",
        childSessionId: sessionFile,
        status: "completed",
        ownership: { owner: "provider" },
        nativeChildId: "subagent-1",
        parentToolCallId: undefined,
        childIndex: 0,
        title: "pi-subagent-1",
      },
    ]);
  });

  test("resolves terminal lifecycle frames that omit sessionFile", async () => {
    const { pi, events } = await createParentSession();
    const sessionFile = "/tmp/pi-subagent-2.jsonl";

    pi.latestSession().emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-2",
        agent: "explore",
        status: "started",
        sessionFile,
        index: 0,
      },
    });
    pi.latestSession().emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-2",
        agent: "explore",
        status: "completed",
        index: 0,
      },
    });

    expect(events.childSessionEvents().at(-1)).toEqual({
      type: "child_session",
      provider: "omp",
      childSessionId: sessionFile,
      status: "completed",
      ownership: { owner: "provider" },
      nativeChildId: "subagent-2",
      parentToolCallId: undefined,
      childIndex: 0,
      title: "pi-subagent-2",
    });
  });

  test("ignores subagent frames when no sessionFile can be resolved", async () => {
    const { pi, events } = await createParentSession();

    pi.latestSession().emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-3",
        agent: "explore",
        status: "completed",
        index: 0,
      },
    });
    pi.latestSession().emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "explore",
        task: "scan",
        progress: { id: "subagent-3", status: "running" },
      },
    });

    expect(events.childSessionEvents()).toEqual([]);
  });
  test("does not guess a missing session file across ambiguous parent tool calls", async () => {
    const { pi, events } = await createParentSession();
    const runtime = pi.latestSession();
    for (const [parentToolCallId, sessionFile] of [
      ["task-a", "/tmp/ambiguous-a.jsonl"],
      ["task-b", "/tmp/ambiguous-b.jsonl"],
    ] as const) {
      runtime.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "shared-child",
          agent: "explore",
          status: "started",
          sessionFile,
          parentToolCallId,
          index: 0,
        },
      });
    }
    const before = events.childSessionEvents().length;
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "shared-child",
        agent: "explore",
        status: "completed",
        index: 0,
      },
    });
    expect(events.childSessionEvents()).toHaveLength(before);
  });

  test("continues when a plain Pi runtime rejects subagent subscription", async () => {
    const pi = new FakePi();
    pi.queueSessionSetup((session) => {
      session.subagentSubscriptionError = new Error("Unknown command");
    });
    const { session } = await createParentSession(pi);

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({ provider: "omp" });
    expect(pi.latestSession().subagentSubscriptionRequests).toEqual(["progress"]);
  });

  test("retains provider ownership after terminal lifecycle", async () => {
    const { pi, client } = await createParentSession();
    const parentRuntime = pi.latestSession();
    const sessionFile = "/tmp/pi-live-subagent.jsonl";
    parentRuntime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-live",
        agent: "task-implementer",
        description: "Implement slice",
        status: "started",
        sessionFile,
        index: 0,
      },
    });
    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 10,
      reset: false,
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.txt" } }],
        },
      ],
    });

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd: TEST_CWD },
      { config: createConfig(), storedConfig: createConfig() },
    );
    const virtualEvents = new SessionEvents(imported.session);

    expect(virtualEvents.turnEvents()).toEqual([{ type: "turn_started", provider: "omp" }]);
    expect(pi.recordedLaunches).toHaveLength(1);
    expect(imported.timeline).toEqual([
      {
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "running",
          detail: {
            type: "read",
            filePath: "a.txt",
            content: undefined,
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
    ]);
    await expect(imported.session.startTurn("still running")).rejects.toThrow(
      "driven by its parent",
    );

    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 10,
      nextByte: 20,
      reset: false,
      messages: [
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "contents" }],
        },
      ],
    });
    parentRuntime.emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "task-implementer",
        task: "implement",
        progress: { id: "subagent-live", status: "running", description: "Implement slice" },
        sessionFile,
      },
    });

    await expect(
      virtualEvents.nextTimelineItem(
        (item) =>
          item.type === "tool_call" && item.callId === "tool-1" && item.status === "completed",
      ),
    ).resolves.toEqual({
      type: "tool_call",
      callId: "tool-1",
      name: "read",
      status: "completed",
      detail: {
        type: "read",
        filePath: "a.txt",
        content: "contents",
        offset: undefined,
        limit: undefined,
      },
      error: null,
    });

    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 20,
      nextByte: 30,
      reset: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    });
    parentRuntime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-live",
        agent: "task-implementer",
        status: "completed",
        index: 0,
      },
    });

    await expect(
      virtualEvents.nextTimelineItem(
        (item) => item.type === "assistant_message" && item.text === "done",
      ),
    ).resolves.toEqual({
      type: "assistant_message",
      text: "done",
      messageId: "omp-history-assistant-2",
    });
    await expect(imported.session.getRuntimeInfo()).resolves.toMatchObject({ provider: "omp" });
    expect(pi.recordedLaunches).toHaveLength(1);
    expect(virtualEvents.turnEvents()).toEqual([
      { type: "turn_started", provider: "omp" },
      { type: "turn_completed", provider: "omp" },
    ]);

    await expect(imported.session.startTurn("still retained")).rejects.toThrow(
      "driven by its parent",
    );
  });

  test("reports resolved model updates for live virtual subagents", async () => {
    const { pi, client } = await createParentSession();
    const parentRuntime = pi.latestSession();
    const sessionFile = "/tmp/pi-live-subagent-model.jsonl";
    parentRuntime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-live-model",
        agent: "task-implementer",
        description: "Implement model slice",
        status: "started",
        sessionFile,
        index: 0,
      },
    });
    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 0,
      reset: false,
      messages: [],
    });

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd: TEST_CWD },
      { config: createConfig(), storedConfig: createConfig() },
    );
    const virtualEvents = new SessionEvents(imported.session);

    await expect(imported.session.getRuntimeInfo()).resolves.toMatchObject({
      provider: "omp",
      model: null,
    });

    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 0,
      reset: false,
      messages: [],
    });
    parentRuntime.emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "task-implementer",
        task: "implement",
        progress: {
          id: "subagent-live-model",
          status: "running",
          description: "Implement model slice",
          resolvedModel: "openai-codex/gpt-5.5:high",
        },
        sessionFile,
      },
    });

    await expect(
      virtualEvents.nextEvent(
        (event): event is Extract<AgentStreamEvent, { type: "model_changed" }> =>
          event.type === "model_changed",
      ),
    ).resolves.toMatchObject({
      type: "model_changed",
      provider: "omp",
      runtimeInfo: {
        provider: "omp",
        model: "openai-codex/gpt-5.5",
      },
    });
    await expect(imported.session.getRuntimeInfo()).resolves.toMatchObject({
      provider: "omp",
      model: "openai-codex/gpt-5.5",
    });
  });

  test("maps virtual child transcripts with OMP history hooks", async () => {
    const { pi, client } = await createParentSession();
    const parentRuntime = pi.latestSession();
    const sessionFile = "/tmp/pi-hooked-subagent.jsonl";
    const initialMessages = ompHookTranscript("DocsSmokeInitial");
    const resetMessages = [...initialMessages, ...ompHookTranscript("DocsSmokeReset")];
    parentRuntime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-hooked",
        agent: "task-implementer",
        description: "Hooked subagent",
        status: "started",
        sessionFile,
        index: 0,
      },
    });
    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 10,
      reset: false,
      messages: initialMessages,
    });

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd: TEST_CWD },
      { config: createConfig(), storedConfig: createConfig() },
    );
    const virtualEvents = new SessionEvents(imported.session);

    expectOmpHookedTranscript(
      imported.timeline.map((entry) => entry.item),
      "DocsSmokeInitial",
    );

    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 10,
      reset: false,
      messages: initialMessages,
    });
    const historyEvents = await collectStreamHistory(imported.session);
    expectOmpHookedTranscript(
      historyEvents.flatMap((event) => (event.type === "timeline" ? [event.item] : [])),
      "DocsSmokeInitial",
    );

    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 10,
      nextByte: 20,
      reset: true,
      messages: resetMessages,
    });
    parentRuntime.emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "task-implementer",
        task: "implement",
        progress: { id: "subagent-hooked", status: "running" },
        sessionFile,
      },
    });

    await expect(
      virtualEvents.nextTimelineItem(
        (item) => item.type === "tool_call" && item.callId === "omp-notice:DocsSmokeReset",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        type: "tool_call",
        callId: "omp-notice:DocsSmokeReset",
        name: "task_notification",
        status: "completed",
      }),
    );
    expectOmpHookedTranscript(virtualEvents.timelineItems(), "DocsSmokeReset");
  });

  test("excludes task-spawned child session files from OMP import listing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-child-filter-"));
    const cwd = path.join(root, "workspace");
    const sessionsDir = path.join(root, "sessions");
    const parentStem = "2026-07-07T23-41-42-657Z_019f3ef5-7980-7000-a76d";
    const parentFile = path.join(sessionsDir, `${parentStem}.jsonl`);
    const childDir = path.join(sessionsDir, parentStem);
    const childFile = path.join(childDir, "EchoChild.jsonl");
    mkdirSync(childDir, { recursive: true });
    writeSessionFile(parentFile, {
      id: "parent",
      cwd,
      timestamp: "2026-07-07T23:41:42.657Z",
      prompt: "parent prompt",
    });
    writeSessionFile(childFile, {
      id: "child",
      cwd,
      timestamp: "2026-07-07T23:41:43.657Z",
      prompt: "child prompt",
    });
    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      providerParams: { sessionDir: sessionsDir },
    });

    await expect(client.listImportableSessions({ cwd, limit: 10 })).resolves.toEqual([
      {
        providerHandleId: parentFile,
        cwd,
        title: "parent prompt",
        firstPromptPreview: "parent prompt",
        lastPromptPreview: "parent prompt",
        lastActivityAt: new Date("2026-07-07T23:41:43.657Z"),
      },
    ]);
  });

  test("fails the virtual child turn when the subagent lifecycle reports failure", async () => {
    const { pi, client } = await createParentSession();
    const parentRuntime = pi.latestSession();
    const sessionFile = "/tmp/pi-failed-subagent.jsonl";
    parentRuntime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-fail",
        agent: "explore",
        description: "Doomed task",
        status: "started",
        sessionFile,
        index: 0,
      },
    });
    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 5,
      reset: false,
      messages: [],
    });

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd: TEST_CWD },
      { config: createConfig(), storedConfig: createConfig() },
    );
    const virtualEvents = new SessionEvents(imported.session);
    expect(virtualEvents.turnEvents()).toEqual([{ type: "turn_started", provider: "omp" }]);

    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 5,
      nextByte: 5,
      reset: false,
      messages: [],
    });
    parentRuntime.emit({
      type: "subagent_lifecycle",
      payload: { id: "subagent-fail", agent: "explore", status: "failed", sessionFile, index: 0 },
    });

    await expect(virtualEvents.nextEvent((event) => event.type === "turn_failed")).resolves.toEqual(
      { type: "turn_failed", provider: "omp", error: "Pi subagent failed" },
    );
  });

  test("buffers virtual timeline events emitted before the manager subscribes", async () => {
    const { pi, client } = await createParentSession();
    const parentRuntime = pi.latestSession();
    const sessionFile = "/tmp/pi-buffered-subagent.jsonl";
    parentRuntime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "subagent-buffered",
        agent: "task-implementer",
        description: "Buffered subagent",
        status: "started",
        sessionFile,
        index: 0,
      },
    });
    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 0,
      reset: false,
      messages: [],
    });

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd: TEST_CWD },
      { config: createConfig(), storedConfig: createConfig() },
    );
    expect(imported.timeline).toEqual([]);

    parentRuntime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 42,
      reset: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "buffered update" }] }],
    });
    parentRuntime.emit({
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "task-implementer",
        task: "implement",
        progress: { id: "subagent-buffered", status: "running" },
        sessionFile,
      },
    });
    await waitForSubagentMessageRequestCount(parentRuntime, 2);

    const lateSubscriberEvents = new SessionEvents(imported.session);

    expect(parentRuntime.subagentMessageRequests).toEqual([
      { sessionFile, fromByte: 0 },
      { sessionFile, fromByte: 0 },
    ]);
    expect(lateSubscriberEvents.timelineItems()).toEqual([
      {
        type: "assistant_message",
        text: "buffered update",
        messageId: "omp-history-assistant-1",
      },
    ]);
  });

  test("awaits final hydration and cancels a running virtual child when its parent exits", async () => {
    const { pi, client, session: parent } = await createParentSession();
    const runtime = pi.latestSession();
    const sessionFile = writeImportableSessionFile();
    const cwd = path.join(path.dirname(path.dirname(sessionFile)), "workspace");
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "released-running",
        agent: "explore",
        status: "started",
        sessionFile,
        index: 0,
      },
    });
    runtime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 10,
      reset: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "initial" }] }],
    });
    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd },
      { config: createConfig({ cwd }), storedConfig: createConfig({ cwd }) },
    );
    const childEvents = new SessionEvents(imported.session);
    runtime.queueSubagentMessages({
      sessionFile,
      fromByte: 10,
      nextByte: 20,
      reset: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    });

    await parent.close();

    expect(childEvents.timelineItems()).toContainEqual({
      type: "assistant_message",
      text: "final",
      messageId: "omp-history-assistant-2",
    });
    expect(childEvents.turnEvents()).toContainEqual({
      type: "turn_canceled",
      provider: "omp",
      reason: "OMP parent session exited",
    });
  });

  test("releases once when process exit races explicit close", async () => {
    const { pi, client, session: parent } = await createParentSession();
    const runtime = pi.latestSession();
    const sessionFile = writeImportableSessionFile();
    const cwd = path.join(path.dirname(path.dirname(sessionFile)), "workspace");
    const parentEvents = new SessionEvents(parent);
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "crashed-running",
        agent: "explore",
        status: "started",
        sessionFile,
        index: 0,
      },
    });
    runtime.queueSubagentMessages({
      sessionFile,
      fromByte: 0,
      nextByte: 10,
      reset: false,
      messages: [],
    });
    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd },
      { config: createConfig({ cwd }), storedConfig: createConfig({ cwd }) },
    );
    const childEvents = new SessionEvents(imported.session);
    runtime.queueSubagentMessages({
      sessionFile,
      fromByte: 10,
      nextByte: 20,
      reset: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "crash-final" }] }],
    });

    runtime.emit({ type: "process_exit", error: "OMP crashed" });
    await expect(
      childEvents.nextEvent((event) => event.type === "turn_canceled"),
    ).resolves.toMatchObject({ reason: "OMP parent session exited" });
    await parent.close();

    expect(childEvents.timelineItems()).toContainEqual({
      type: "assistant_message",
      text: "crash-final",
      messageId: "omp-history-assistant-1",
    });
    expect(
      parentEvents
        .childSessionEvents()
        .filter(
          (event) =>
            event.type === "child_session" &&
            event.childSessionId === sessionFile &&
            event.ownership.owner !== "provider",
        ),
    ).toHaveLength(1);
  });

  test("keeps discovered historical descendants read-only and titles them by session name", async () => {
    const { pi, client, session: parent } = await createParentSession();
    const runtime = pi.latestSession();
    const parentFile = writeImportableSessionFile();
    const cwd = path.join(path.dirname(path.dirname(parentFile)), "workspace");
    const childDirectory = parentFile.slice(0, -".jsonl".length);
    mkdirSync(childDirectory);
    const historicalFile = path.join(childDirectory, "NativeChild.jsonl");
    writeFileSync(
      historicalFile,
      [
        JSON.stringify({ type: "session", version: 3, id: "historical", cwd }),
        JSON.stringify({ type: "session_init", isolated: false, resumable: true }),
        JSON.stringify({
          type: "message",
          id: "historical-message",
          message: { role: "assistant", content: [{ type: "text", text: "historical answer" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const parentEvents = new SessionEvents(parent);
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "live-parent",
        agent: "explore",
        status: "started",
        sessionFile: parentFile,
        index: 0,
      },
    });

    await parent.close();
    const historicalEvent = parentEvents
      .childSessionEvents()
      .find((event) => event.childSessionId === historicalFile);
    expect(historicalEvent).toEqual({
      type: "child_session",
      provider: "omp",
      childSessionId: historicalFile,
      parentChildSessionId: parentFile,
      nativeChildId: "historical",
      status: "completed",
      ownership: {
        owner: "none",
        resumable: false,
        reason: "historical child transcripts are read-only",
      },
      title: "NativeChild",
    });
    const launchesBeforeImport = pi.recordedLaunches.length;

    const imported = await client.importSession(
      { providerHandleId: historicalFile, cwd },
      { config: createConfig({ cwd }), storedConfig: createConfig({ cwd }) },
    );

    expect(pi.recordedLaunches).toHaveLength(launchesBeforeImport);
    expect(imported.session.constructor.name).toBe("OmpReleasedSession");
    expect(imported.ownership).toEqual({
      owner: "none",
      resumable: false,
      reason: "historical child transcripts are read-only",
    });
    expect(imported.timeline).toContainEqual(
      expect.objectContaining({
        item: {
          type: "assistant_message",
          text: "historical answer",
          messageId: "omp-history-assistant-1",
        },
      }),
    );
    await expect(imported.session.startTurn("must remain historical")).rejects.toThrow("read-only");
  });

  test("resumes released disk handles with the same native persistence handle", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const sessionFile = writeImportableSessionFile();
    const cwd = path.join(path.dirname(path.dirname(sessionFile)), "workspace");

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd },
      { config: createConfig({ cwd }), storedConfig: createConfig({ cwd }) },
    );

    expect(pi.recordedLaunches).toHaveLength(1);
    expect(pi.recordedLaunches[0]?.session).toBe(sessionFile);
    expect(imported.persistence.nativeHandle).toBe(sessionFile);
    expect(imported.session.describePersistence()?.nativeHandle).toBe(sessionFile);
    expect(imported.ownership).toEqual({ owner: "paseo", resumable: true });
    await expect(imported.session.startTurn("follow up")).resolves.toEqual({
      turnId: expect.any(String),
    });
    expect(pi.latestSession().prompts).toEqual([{ message: "follow up", imageCount: 0 }]);
  });

  test("keeps isolated released history readable and rejects prompting", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const sessionFile = writeImportableSessionFile();
    const cwd = path.join(path.dirname(path.dirname(sessionFile)), "workspace");
    const content = readFileSync(sessionFile, "utf8")
      .replace(
        JSON.stringify({ type: "session_init", isolated: false, resumable: true }),
        JSON.stringify({ type: "session_init", isolated: true, resumable: false }),
      )
      .concat(
        `${JSON.stringify({
          type: "message",
          id: "isolated-message",
          message: { role: "assistant", content: [{ type: "text", text: "archived answer" }] },
        })}\n`,
      );
    writeFileSync(sessionFile, content, "utf8");

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd },
      { config: createConfig({ cwd }), storedConfig: createConfig({ cwd }) },
    );
    expect(imported.timeline).toContainEqual(
      expect.objectContaining({
        item: {
          type: "assistant_message",
          text: "archived answer",
          messageId: "omp-history-assistant-1",
        },
      }),
    );

    expect(pi.recordedLaunches).toHaveLength(0);
    await expect(imported.session.startTurn("must not resume")).rejects.toThrow("read-only");
    expect(
      (await collectStreamHistory(imported.session)).filter((event) => event.type === "timeline"),
    ).toContainEqual(
      expect.objectContaining({
        item: {
          type: "assistant_message",
          text: "archived answer",
          messageId: "omp-history-assistant-1",
        },
      }),
    );
    expect(imported.persistence.nativeHandle).toBe(sessionFile);
    expect(imported.ownership).toEqual({
      owner: "none",
      resumable: false,
      reason: "session is isolated or non-resumable",
    });
  });
});
