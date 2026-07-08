import pino from "pino";
import { describe, expect, test } from "vitest";

import { createPaseoToolCatalog } from "../../tools/paseo-tools.js";
import toolExecutionFrames from "./__fixtures__/tool_execution_bash_read_edit_write.json" with { type: "json" };
import { parseToolArgs, parseToolResult } from "../pi-shared/tool-call-mapper.js";
import { PASEO_HOST_TOOL_NAMES, mapOmpToolDetail } from "./tool-call-mapper.js";

type CatalogOptions = Parameters<typeof createPaseoToolCatalog>[0];

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

  test("maps native Paseo host tools to visible details instead of unknown", () => {
    expect(
      mapOmpToolDetail(
        parseToolArgs("create_agent", {
          provider: "codex",
          initialPrompt: "Inspect the regression",
        }),
        parseToolResult({
          content: [{ type: "text", text: "created" }],
          details: { agentId: "agent-child-1", type: "codex" },
        }),
      ),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "codex",
      description: "Inspect the regression",
      childSessionId: "agent-child-1",
      log: "created",
    });

    expect(
      mapOmpToolDetail(
        parseToolArgs("send_agent_prompt", {
          agentId: "agent-child-1",
          prompt: "Continue",
        }),
        parseToolResult({ content: [{ type: "text", text: "queued" }] }),
      ),
    ).toEqual({
      type: "plain_text",
      label: "Paseo send agent prompt",
      text: "agentId=agent-child-1\nContinue\n\nqueued",
      icon: "bot",
    });
  });

  test("covers every tool exposed by the real Paseo catalog", () => {
    const catalog = createPaseoToolCatalog({
      agentManager: {} as CatalogOptions["agentManager"],
      agentStorage: {} as CatalogOptions["agentStorage"],
      terminalManager: {} as CatalogOptions["terminalManager"],
      providerSnapshotManager: {} as CatalogOptions["providerSnapshotManager"],
      callerAgentId: "agent-omp-host-tools",
      browserToolsEnabled: true,
      browserToolsBroker: {
        async execute() {
          return { ok: true, result: null };
        },
      } as NonNullable<CatalogOptions["browserToolsBroker"]>,
      enableVoiceTools: true,
      logger: pino({ level: "silent" }),
    } satisfies CatalogOptions);

    const missing = [...catalog.tools.keys()]
      .filter((toolName) => !PASEO_HOST_TOOL_NAMES.has(toolName))
      .sort();

    expect(missing).toEqual([]);
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
