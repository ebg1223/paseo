import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { PiAgentMessage } from "./rpc-types.js";
import { streamPiHistory, type PiCapturedUserMessageEntry } from "./history-mapper.js";

async function collectHistory(
  messages: PiAgentMessage[],
  userEntries: PiCapturedUserMessageEntry[] = [],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory("pi", messages, userEntries)) {
    events.push(event);
  }
  return events;
}

describe("Pi history mapper", () => {
  test("replays user, assistant, reasoning, and completed tool calls", async () => {
    await expect(
      collectHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            { type: "image", data: "base64", mimeType: "image/png" },
            { type: "text", text: "then answer" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "checking file" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
            { type: "text", text: "done" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "read this\n\nthen answer",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "reasoning", text: "checking file" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "running",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: undefined,
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "done" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "completed",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: "file contents",
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
    ]);
  });

  test("replays bash execution records as completed shell calls", async () => {
    await expect(
      collectHistory([
        {
          role: "bashExecution",
          command: "echo hi",
          output: "hi\n",
          exitCode: 0,
          timestamp: 123,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-bash-123",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
          error: null,
        },
      },
    ]);
  });

  test("coalesces replayed subagent poll calls by target set", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "poll-1", name: "subagent", arguments: { poll: ["job-a"] } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "poll-1",
        toolName: "subagent",
        content: [{ type: "text", text: "first poll" }],
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "poll-2", name: "subagent", arguments: { poll: ["job-a"] } },
          { type: "toolCall", id: "poll-3", name: "subagent", arguments: { poll: ["job-b"] } },
          {
            type: "toolCall",
            id: "spawn-1",
            name: "subagent",
            arguments: { spawn: [{ task: "go" }] },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "poll-2",
        toolName: "subagent",
        content: [{ type: "text", text: "second poll" }],
      },
      {
        role: "toolResult",
        toolCallId: "poll-3",
        toolName: "subagent",
        content: [{ type: "text", text: "other poll" }],
      },
      {
        role: "toolResult",
        toolCallId: "spawn-1",
        toolName: "subagent",
        content: [{ type: "text", text: "spawned" }],
      },
    ]);

    expect(
      events.map((event) => (event.item.type === "tool_call" ? event.item.callId : null)),
    ).toEqual([
      "omp-poll:job-a",
      "omp-poll:job-a",
      "omp-poll:job-a",
      "omp-poll:job-b",
      "spawn-1",
      "omp-poll:job-a",
      "omp-poll:job-b",
      "spawn-1",
    ]);
  });

  test("absorbs replayed omp system-notice custom messages as synthetic tool calls", async () => {
    const notice = [
      "<system-notice>",
      "Background job DocsSmokeTwo has completed. Resume your work using the result below.",
      '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
      "<output>done</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "custom", content: notice },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
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
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });

  test("replays non-notice custom messages as assistant text, matching the live path", async () => {
    await expect(
      collectHistory([{ role: "custom", content: "Extension command output" }]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "Extension command output" },
      },
    ]);
  });

  test("uses Pi tree entry ids for replayed user messages", async () => {
    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "assistant", content: [{ type: "text", text: "first answer" }] },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "first answer" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });
});
