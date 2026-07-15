import { describe, expect, test } from "vitest";

import { parseToolArgs, parseToolResult } from "../pi-shared/tool-call-mapper.js";
import frames from "./__fixtures__/rpc_compat_17_0_0.json" with { type: "json" };
import { OmpAvailableCommandsUpdateEventSchema } from "./rpc-types.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";

describe("OMP 17 RPC compatibility fixtures", () => {
  test("parses the compact command update and preserves its source field", () => {
    const frame = fixtureFrame("available_commands_update");

    expect(OmpAvailableCommandsUpdateEventSchema.parse(frame).commands).toEqual([
      {
        name: "prewalk",
        description: "Prewalk at the next action",
        source: "builtin",
      },
    ]);
  });

  test("captures the subscribed event shape without assuming tool names are built-ins", () => {
    const frame = fixtureFrame("subagent_event");
    const payload = asRecord(frame.payload);
    const event = asRecord(payload.event);

    expect(payload.id).toBe("compat-child");
    expect(event).toMatchObject({
      type: "tool_execution_start",
      toolCallId: "hub-call",
      toolName: "hub",
      args: { op: "list" },
    });
    expect(mapOmpToolDetail(parseToolArgs(String(event.toolName), event.args), null)).toEqual({
      type: "unknown",
      input: { op: "list" },
      output: null,
    });
  });

  test("parses the arbitrary hub result without requiring a tool-specific result schema", () => {
    const frame = fixtureToolFrame("tool_execution_end", "hub");

    expect(parseToolResult(frame.result)).toEqual({
      content: [{ type: "text", text: "No peers registered" }],
      details: { op: "list", peers: [] },
    });
  });
});

function fixtureFrame(type: string): Record<string, unknown> {
  const frame = (frames as readonly unknown[]).find(
    (candidate) => isRecord(candidate) && candidate.type === type,
  );
  if (!isRecord(frame)) throw new Error(`Missing OMP 17 fixture frame ${type}`);
  return frame;
}

function fixtureToolFrame(type: string, toolName: string): Record<string, unknown> {
  const frame = (frames as readonly unknown[]).find(
    (candidate) =>
      isRecord(candidate) && candidate.type === type && candidate.toolName === toolName,
  );
  if (!isRecord(frame)) throw new Error(`Missing OMP 17 fixture frame ${type}:${toolName}`);
  return frame;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object in OMP 17 fixture");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
