import { describe, expect, test } from "vitest";

import toolExecutionFrames from "./__fixtures__/tool_execution_bash_read_edit_write.json" with { type: "json" };
import { parseToolArgs, parseToolResult } from "@getpaseo/provider-sdk/pi-rpc";
import { mapOmpToolDetail } from "./tool-call-mapper.js";

describe("OMP tool call mapper", () => {
  test("maps bash, read, hashline edit, and write frames from OMP 16.3.9 fixtures", () => {
    const bashStart = fixtureToolEvent("tool_execution_start", "bash");
    const bashEnd = fixtureToolEvent("tool_execution_end", "bash");
    const readStart = fixtureToolEvent("tool_execution_start", "read");
    const readEnd = fixtureToolEvent("tool_execution_end", "read");
    const editStart = fixtureToolEvent("tool_execution_start", "edit");
    const editEnd = fixtureToolEvent("tool_execution_end", "edit");
    const writeStart = fixtureToolEvent("tool_execution_start", "write");

    expect(
      mapOmpToolDetail(parseToolArgs("bash", bashStart.args), parseToolResult(bashEnd.result)),
    ).toEqual({
      type: "shell",
      command: "echo hi",
      output: "hi\n\n\nWall time: 0.02 seconds",
      exitCode: null,
    });
    expect(
      mapOmpToolDetail(parseToolArgs("read", readStart.args), parseToolResult(readEnd.result)),
    ).toEqual({
      type: "read",
      filePath: "fixture.txt",
      content: "alpha\nbeta\n",
      offset: undefined,
      limit: undefined,
    });
    expect(
      mapOmpToolDetail(parseToolArgs("edit", editStart.args), parseToolResult(editEnd.result)),
    ).toEqual({
      type: "edit",
      filePath: "fixture.txt",
      oldString: "alpha\nbeta\n",
      newString: "alpha\ngamma\n",
      unifiedDiff: " 1|alpha\n-2|beta\n+2|gamma",
    });
    expect(mapOmpToolDetail(parseToolArgs("write", writeStart.args), null)).toEqual({
      type: "write",
      filePath: "created.txt",
      content: "hello write",
    });
  });

  test("maps task to sub-agent detail and suppresses todo raw cards", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          agent: "explore",
          description: "Inspect the target files",
        }),
        null,
      ),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Inspect the target files",
      log: "",
    });
    expect(mapOmpToolDetail(parseToolArgs("todo", { op: "view" }), null)).toBeNull();
  });

  test("uses task result text and transcript path as the best static replay detail", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("task", {
          agent: "explore",
          description: "Inspect the target files",
        }),
        parseToolResult({
          content: [
            {
              type: "text",
              text: "done\ntranscript: /tmp/omp-task-static/Explore.jsonl",
            },
          ],
        }),
      ),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Inspect the target files",
      childSessionId: "/tmp/omp-task-static/Explore.jsonl",
      log: "done\ntranscript: /tmp/omp-task-static/Explore.jsonl",
    });
  });

  test("falls back to shared unknown detail for unmapped tools", () => {
    expect(mapOmpToolDetail(parseToolArgs("lsp", { op: "hover" }), null)).toEqual({
      type: "unknown",
      input: { op: "hover" },
      output: null,
    });
  });
});

function fixtureToolEvent(type: string, toolName: string): Record<string, unknown> {
  const event = (toolExecutionFrames as readonly unknown[]).find(
    (candidate) =>
      isRecord(candidate) && candidate.type === type && candidate.toolName === toolName,
  );
  if (!isRecord(event)) {
    throw new Error(`Missing fixture event ${type}:${toolName}`);
  }
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
