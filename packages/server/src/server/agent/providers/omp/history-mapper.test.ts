import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamPiHistory, type PiCapturedUserMessageEntry } from "../pi-shared/history-mapper.js";
import type { PiAgentMessage } from "../pi-shared/rpc-types.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";

async function collectHistory(
  messages: PiAgentMessage[],
  userEntries: PiCapturedUserMessageEntry[] = [],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory(
    "omp",
    messages,
    userEntries,
    OMP_HISTORY_MAPPER_HOOKS,
  )) {
    events.push(event);
  }
  return events;
}

describe("OMP history mapper", () => {
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
        provider: "omp",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "omp",
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
        provider: "omp",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });

  test("suppresses replayed raw todo tool calls through the OMP detail hook", async () => {
    await expect(
      collectHistory([
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "view" } }],
        },
        {
          role: "toolResult",
          toolCallId: "todo-1",
          toolName: "todo",
          content: [{ type: "text", text: "todos" }],
        },
      ]),
    ).resolves.toEqual([]);
  });

  test("replays task tool results as static sub-agent details", async () => {
    await expect(
      collectHistory([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "task-1",
              name: "task",
              arguments: { agent: "explore", description: "Inspect files" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "task-1",
          toolName: "task",
          content: [{ type: "text", text: "done\ntranscript: /tmp/omp-task/Explore.jsonl" }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "task-1",
          name: "task",
          status: "running",
          detail: {
            type: "sub_agent",
            subAgentType: "explore",
            description: "Inspect files",
            log: "",
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "task-1",
          name: "task",
          status: "completed",
          detail: {
            type: "sub_agent",
            subAgentType: "explore",
            description: "Inspect files",
            childSessionId: "/tmp/omp-task/Explore.jsonl",
            log: "done\ntranscript: /tmp/omp-task/Explore.jsonl",
          },
          error: null,
        },
      },
    ]);
  });
});
