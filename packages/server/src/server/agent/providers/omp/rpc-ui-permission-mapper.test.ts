import { describe, expect, test } from "vitest";

import rpcUiFixture from "./__fixtures__/rpc_ui_extension_requests.json" with { type: "json" };
import {
  buildOmpRpcUiPermissionResponse,
  classifyOmpRpcUiPermissionRequest,
} from "./rpc-ui-permission-mapper.js";
import type { PiRuntimeEvent } from "../pi-shared/rpc-types.js";

type ExtensionUiRequestEvent = Extract<PiRuntimeEvent, { type: "extension_ui_request" }>;

const EXPECTED_CLASSIFICATION_BY_ID = new Map<string, "approval" | "passthrough">([
  ["15270a3c7a73a2b4", "passthrough"],
  ["15270a3db1b3a2b9", "passthrough"],
  ["15270a3db1b3a2ba", "passthrough"],
  ["15270a3db1b3a2bb", "passthrough"],
  ["15270a3db1b3a2bc", "passthrough"],
  ["15270a3db1b3a2bd", "passthrough"],
  ["15270a3db1b3a2be", "passthrough"],
  ["15270a3db1f3a2bf", "passthrough"],
  ["15270a3db1f3a2c0", "passthrough"],
  ["15270a3db273a2c1", "passthrough"],
  ["15270a3db273a2c2", "passthrough"],
  ["15270a3db273a2c3", "passthrough"],
  ["15270a3db273a2c4", "passthrough"],
  ["15270a42be33a2c5", "approval"],
  ["15270a441f73a2c6", "passthrough"],
  ["15270a49d8f3a2c7", "approval"],
  ["15270a4b2a33a2c8", "passthrough"],
  ["15270a659f553df7", "passthrough"],
  ["15270a6839953dfc", "approval"],
  ["15270a6e98d53dfd", "passthrough"],
  ["15270b3bc9a4ef5b", "passthrough"],
  ["15270b401324ef60", "passthrough"],
  ["15270b416f64ef61", "passthrough"],
]);

function readFixtureFrames(): ExtensionUiRequestEvent[] {
  if (!Array.isArray(rpcUiFixture)) {
    throw new Error("rpc-ui fixture must be an array");
  }
  return rpcUiFixture.map((frame) => {
    if (!isRecord(frame) || frame.type !== "extension_ui_request" || typeof frame.id !== "string") {
      throw new Error("rpc-ui fixture contains a malformed extension_ui_request frame");
    }
    return frame as ExtensionUiRequestEvent;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("OMP rpc-ui permission mapper", () => {
  test("classifies every captured rpc-ui frame conservatively", () => {
    const frames = readFixtureFrames();
    expect(frames).toHaveLength(EXPECTED_CLASSIFICATION_BY_ID.size);

    const actual = frames.map((frame) => {
      const classification = classifyOmpRpcUiPermissionRequest(frame);
      return [frame.id, classification.kind === "tool" ? "approval" : "passthrough"] as const;
    });

    expect(new Map(actual)).toEqual(EXPECTED_CLASSIFICATION_BY_ID);
  });

  test("maps captured tool approval frames to tool permissions with renderable details", () => {
    const permissions = readFixtureFrames().flatMap((frame) => {
      const classification = classifyOmpRpcUiPermissionRequest(frame);
      return classification.kind === "tool" ? [classification.request] : [];
    });

    expect(permissions).toEqual([
      expect.objectContaining({
        id: "15270a42be33a2c5",
        provider: "omp",
        name: "bash",
        kind: "tool",
        detail: { type: "shell", command: "echo rpc-ui-hi" },
        metadata: expect.objectContaining({
          toolName: "bash",
          toolArgs: { command: "echo rpc-ui-hi" },
          approveValue: "Approve",
          denyValue: "Deny",
        }),
      }),
      expect.objectContaining({
        id: "15270a49d8f3a2c7",
        provider: "omp",
        name: "edit",
        kind: "tool",
        detail: { type: "edit", filePath: "fixture.txt" },
        metadata: expect.objectContaining({
          toolName: "edit",
          toolArgs: { path: "fixture.txt" },
        }),
      }),
      expect.objectContaining({
        id: "15270a6839953dfc",
        provider: "omp",
        name: "write",
        kind: "tool",
        detail: { type: "write", filePath: "created.txt", content: "hello write" },
        metadata: expect.objectContaining({
          toolName: "write",
          toolArgs: { path: "created.txt", content: "hello write" },
        }),
      }),
    ]);
  });

  test("preserves destructive multiline CRLF bash commands exactly", () => {
    const title = "Allow tool: bash\r\nCommand: printf first\r\n\r\n  rm -rf /tmp/example\r\n";
    const classification = classifyOmpRpcUiPermissionRequest({
      type: "extension_ui_request",
      id: "multiline-bash",
      method: "select",
      title,
      options: ["Approve", "Deny"],
    });
    if (classification.kind !== "tool") {
      throw new Error("Expected multiline bash approval");
    }

    expect(classification.request.detail).toEqual({
      type: "shell",
      command: "printf first\r\n\r\n  rm -rf /tmp/example\r\n",
    });
    expect(classification.request.metadata?.toolArgs).toEqual({
      command: "printf first\r\n\r\n  rm -rf /tmp/example\r\n",
    });
  });

  test("keeps approval classification false-positive guards exact", () => {
    const lookalike: ExtensionUiRequestEvent = {
      type: "extension_ui_request",
      id: "not-tool",
      method: "select",
      title: "Allow tool: bash\nCommand: echo hi",
      options: ["Yes", "No"],
    };
    const unknownTool: ExtensionUiRequestEvent = {
      type: "extension_ui_request",
      id: "unknown-tool",
      method: "select",
      title: "Allow tool: custom_tool\nReason: needs approval",
      options: ["Approve", "Deny"],
    };

    expect(classifyOmpRpcUiPermissionRequest(lookalike)).toEqual({ kind: "passthrough" });
    expect(classifyOmpRpcUiPermissionRequest(unknownTool)).toEqual({ kind: "passthrough" });
  });

  test("responds to tool approvals with exact select values", () => {
    const frame = readFixtureFrames().find((candidate) => candidate.id === "15270a42be33a2c5");
    if (!frame) {
      throw new Error("Missing bash approval fixture frame");
    }
    const classification = classifyOmpRpcUiPermissionRequest(frame);
    if (classification.kind !== "tool") {
      throw new Error("Expected bash approval frame to classify as a tool permission");
    }

    expect(buildOmpRpcUiPermissionResponse(classification.request, { behavior: "allow" })).toEqual({
      value: "Approve",
    });
    expect(
      buildOmpRpcUiPermissionResponse(classification.request, {
        behavior: "allow",
        selectedActionId: "allow_always",
      }),
    ).toEqual({ value: "Approve" });
    expect(
      buildOmpRpcUiPermissionResponse(classification.request, {
        behavior: "deny",
        message: "no",
      }),
    ).toEqual({ value: "Deny" });
  });
});
