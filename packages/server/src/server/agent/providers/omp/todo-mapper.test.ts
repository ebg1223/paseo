import { describe, expect, test } from "vitest";

import todoFrames from "./__fixtures__/todo_tool_reminder_state.json" with { type: "json" };
import { parseToolResult } from "@getpaseo/provider-sdk/pi-rpc";
import { mapOmpTodoReminderEvent, mapOmpTodoState, mapOmpTodoToolResult } from "./todo-mapper.js";

describe("OMP todo mapper", () => {
  test("maps todo tool results and collapses OMP statuses to completed booleans", () => {
    const firstTodoToolEnd = fixtureRecord(0);
    const secondTodoToolEnd = fixtureRecord(1);

    expect(mapOmpTodoToolResult(parseToolResult(firstTodoToolEnd.result))).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", completed: false },
        { text: "beta task", completed: false },
        { text: "gamma task", completed: false },
      ],
    });
    expect(mapOmpTodoToolResult(parseToolResult(secondTodoToolEnd.result))).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", completed: true },
        { text: "beta task", completed: false },
        { text: "gamma task", completed: false },
      ],
    });
  });

  test("maps todo reminder events", () => {
    expect(mapOmpTodoReminderEvent(fixtureRecord(2))).toEqual({
      type: "todo",
      items: [
        { text: "beta task", completed: false },
        { text: "gamma task", completed: false },
      ],
    });
  });

  test("hydrates current todos from get_state.todoPhases", () => {
    const stateResponse = fixtureRecord(3);
    expect(mapOmpTodoState(readState(stateResponse))).toEqual([
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

  test("drops malformed todo frames without throwing", () => {
    expect(mapOmpTodoReminderEvent({ type: "todo_reminder", todos: [{ content: 1 }] })).toBeNull();
    expect(
      mapOmpTodoToolResult({ details: { phases: [{ name: "Bad", tasks: [{}] }] } }),
    ).toBeNull();
  });
});

function fixtureRecord(index: number): Record<string, unknown> {
  const value = (todoFrames as readonly unknown[])[index];
  if (!isRecord(value)) {
    throw new Error(`Missing todo fixture record ${index}`);
  }
  return value;
}

function readState(response: Record<string, unknown>) {
  if (!isRecord(response.data)) {
    throw new Error("Fixture response is missing data");
  }
  return {
    model: null,
    thinkingLevel: "medium" as const,
    isStreaming: false,
    isCompacting: false,
    sessionId: "session",
    messageCount: 0,
    pendingMessageCount: 0,
    todoPhases: response.data.todoPhases,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
