import { describe, expect, test } from "vitest";

import {
  mapToolDetail,
  parseToolArgs,
  parseToolResult,
  resolveEmittedToolCallId,
  resolveToolCallName,
} from "./tool-call-mapper.js";

describe("Pi tool call mapper", () => {
  test("maps bash args and result to shell detail", () => {
    const toolCall = parseToolArgs("bash", { command: "echo hello" });
    const result = parseToolResult({ output: "hello\n", exitCode: 0 });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "shell",
      command: "echo hello",
      output: "hello\n",
      exitCode: 0,
    });
  });

  test("maps legacy edit args to edit detail with diff", () => {
    const toolCall = parseToolArgs("edit", {
      path: "app.ts",
      old_string: "before",
      new_string: "after",
    });
    const result = parseToolResult({ details: { diff: "-before\n+after" } });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "edit",
      filePath: "app.ts",
      oldString: "before",
      newString: "after",
      unifiedDiff: "-before\n+after",
    });
  });

  test("preserves unknown tool input and parsed output", () => {
    const toolCall = parseToolArgs("custom_tool", { value: 42 });
    const result = parseToolResult({ text: "custom result" });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "unknown",
      input: { value: 42 },
      output: { text: "custom result" },
    });
  });

  test("normalizes Pi MCP proxy calls from requested tool args while running", () => {
    const toolCall = parseToolArgs("mcp", {
      tool: "paseo_list_models",
      args: '{"provider":"pi"}',
    });

    expect(resolveToolCallName(toolCall, null)).toBe("paseo.list_models");
  });

  test("normalizes Pi MCP proxy calls from result details when completed", () => {
    const toolCall = parseToolArgs("mcp", {
      tool: "paseo_list_models",
      args: '{"provider":"pi"}',
    });
    const result = parseToolResult({
      content: [{ type: "text", text: "(empty result)" }],
      details: {
        mode: "call",
        server: "paseo",
        tool: "list_models",
      },
    });

    expect(resolveToolCallName(toolCall, result)).toBe("paseo.list_models");
  });

  test("uses stable synthetic ids only for subagent poll calls", () => {
    expect(
      resolveEmittedToolCallId("poll-1", parseToolArgs("subagent", { poll: ["job-b", "job-a"] })),
    ).toBe("omp-poll:job-a,job-b");
    expect(
      resolveEmittedToolCallId("poll-2", parseToolArgs("subagent", { poll: ["job-a", "job-b"] })),
    ).toBe("omp-poll:job-a,job-b");
    expect(resolveEmittedToolCallId("poll-3", parseToolArgs("subagent", { poll: ["job-a"] }))).toBe(
      "omp-poll:job-a",
    );
    expect(
      resolveEmittedToolCallId("spawn-1", parseToolArgs("subagent", { spawn: [{ prompt: "go" }] })),
    ).toBe("spawn-1");
    expect(resolveEmittedToolCallId("bash-1", parseToolArgs("bash", { command: "echo hi" }))).toBe(
      "bash-1",
    );
  });
});
