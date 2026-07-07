import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, "subagent.jsonl");
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: "subagent", cwd })}\n`,
    "utf8",
  );
  return sessionFile;
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
      },
    });

    expect(events.childSessionEvents()).toEqual([
      {
        type: "child_session",
        provider: "omp",
        childSessionId: sessionFile,
        status: "running",
        title: "Explore implementation",
      },
      {
        type: "child_session",
        provider: "omp",
        childSessionId: sessionFile,
        status: "completed",
        title: "Explore implementation",
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

  test("continues when a plain Pi runtime rejects subagent subscription", async () => {
    const pi = new FakePi();
    pi.queueSessionSetup((session) => {
      session.subagentSubscriptionError = new Error("Unknown command");
    });
    const { session } = await createParentSession(pi);

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({ provider: "omp" });
    expect(pi.latestSession().subagentSubscriptionRequests).toEqual(["progress"]);
  });

  test("imports live subagents as virtual sessions and promotes after terminal lifecycle", async () => {
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
    ).resolves.toEqual({ type: "assistant_message", text: "done" });
    await expect(imported.session.getRuntimeInfo()).resolves.toMatchObject({ provider: "omp" });
    expect(pi.recordedLaunches).toHaveLength(2);
    expect(pi.recordedLaunches[1]).toMatchObject({ session: sessionFile });
    expect(virtualEvents.turnEvents()).toEqual([
      { type: "turn_started", provider: "omp" },
      { type: "turn_completed", provider: "omp" },
    ]);

    await imported.session.startTurn("after promotion");
    expect(pi.latestSession().prompts).toEqual([{ message: "after promotion", imageCount: 0 }]);
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
      { type: "assistant_message", text: "buffered update" },
    ]);
  });

  test("imports unknown handles through the normal resume path", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const sessionFile = writeImportableSessionFile();

    await client.importSession(
      { providerHandleId: sessionFile, cwd: TEST_CWD },
      { config: createConfig(), storedConfig: createConfig() },
    );

    expect(pi.recordedLaunches).toHaveLength(1);
    expect(pi.recordedLaunches[0]).toMatchObject({ session: sessionFile });
  });
});
