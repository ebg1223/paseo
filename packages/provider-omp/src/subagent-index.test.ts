import { describe, expect, test } from "vitest";

import { OmpSubagentIndex } from "./subagent-index.js";

describe("OMP provider subagent mapper", () => {
  test("maps lifecycle and progress frames to stable provider_subagent descriptors", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "explore",
        description: "Inspect files",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      }),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "upsert",
          id: "child-1",
          title: "explore",
          description: "Inspect files",
          status: "running",
          toolCallId: "task-1",
        },
      },
    ]);

    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        parentToolCallId: "task-1",
        progress: {
          id: "child-1",
          status: "running",
          resolvedModel: "openai-codex/gpt-5.5",
        },
      })[0],
    ).toMatchObject({
      event: {
        id: "child-1",
        status: "running",
        title: "explore · gpt-5.5 (openai-codex)",
      },
    });

    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        parentToolCallId: "task-1",
        progress: {
          id: "child-1",
          status: "completed",
          resolvedModel: "anthropic/claude-sonnet-5",
        },
      })[0],
    ).toMatchObject({
      event: {
        id: "child-1",
        status: "completed",
        title: "explore · claude-sonnet-5 (anthropic)",
      },
    });
  });

  test("terminalizes running subagents without reviving them from later progress", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    index.handleLifecycle(parent, {
      id: "running",
      agent: "explore",
      status: "started",
      index: 0,
    });
    index.handleLifecycle(parent, {
      id: "completed",
      agent: "task",
      status: "completed",
      index: 1,
    });

    expect(index.terminalizeRunning(parent)).toMatchObject([
      { event: { type: "upsert", id: "running", status: "canceled" } },
    ]);
    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        progress: { id: "running", status: "running" },
      }),
    ).toEqual([]);
  });

  test("maps child tool execution events onto the descriptor timeline", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "tool_execution_start",
          toolCallId: "bash-1",
          toolName: "bash",
          args: { command: "echo hello" },
        },
      }),
    ).toMatchObject([
      {
        event: {
          type: "timeline",
          id: "child-1",
          item: {
            type: "tool_call",
            callId: "bash-1",
            name: "bash",
            status: "running",
            detail: { type: "shell", command: "echo hello" },
          },
        },
      },
    ]);
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "tool_execution_end",
          toolCallId: "bash-1",
          toolName: "bash",
          result: { output: "hello\n", exitCode: 0 },
        },
      }),
    ).toMatchObject([
      {
        event: {
          type: "timeline",
          id: "child-1",
          item: {
            type: "tool_call",
            callId: "bash-1",
            name: "bash",
            status: "completed",
            detail: { type: "shell", command: "echo hello", output: "hello\n" },
          },
        },
      },
    ]);
  });

  test("maps child message events onto the descriptor timeline", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Child answer" }],
          },
        },
      }),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "timeline",
          id: "child-1",
          item: {
            type: "assistant_message",
            text: "Child answer",
            messageId: "omp-history-assistant-1",
          },
        },
      },
    ]);
  });

  test("maps aborted lifecycle status to canceled", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "task",
        status: "aborted",
        index: 0,
      })[0],
    ).toMatchObject({ event: { id: "child-1", status: "canceled" } });
  });
});
