import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentSession, AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { FakePi } from "../pi-shared/test-utils/fake-pi.js";
import { OmpRpcAgentClient } from "./agent.js";

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "omp",
    cwd: "/tmp/paseo-omp-rpc-test",
    ...overrides,
  };
}

function createClient(pi = new FakePi()): OmpRpcAgentClient {
  return new OmpRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: pi,
  });
}

async function createSession(pi = new FakePi()): Promise<{
  pi: FakePi;
  session: AgentSession;
  events: SessionEvents;
}> {
  const client = createClient(pi);
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
}

describe("OMP RPC agent", () => {
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
