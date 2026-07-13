import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import type {
  PaseoToolCatalog,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../../tools/types.js";
import {
  clearOmpHostToolState,
  handleOmpHostToolRuntimeEvent,
  serializeOmpHostTools,
} from "./host-tools.js";

function createCatalog(tools: PaseoToolDefinition[]): PaseoToolCatalog {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: toolMap,
    getTool: (name) => toolMap.get(name),
    executeTool: async (name, input, context) => {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new Error(`Missing tool ${name}`);
      }
      return await tool.handler(input, context);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRouterHarness(
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
) {
  const frames: Array<object & { type: string }> = [];
  const runtimeSession = {
    sendRawFrame: (frame: object & { type: string }) => frames.push(frame),
  } as unknown as PiRuntimeSession;
  const catalog = createCatalog([
    {
      name: "test_tool",
      description: "Test tool",
      inputSchema: {},
      handler,
    },
  ]);
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
  } as never;
  const dispatch = (event: object & { type: string }) =>
    handleOmpHostToolRuntimeEvent(event as never, { runtimeSession, paseoTools: catalog, logger });
  const call = (id = "call-1") =>
    dispatch({
      type: "host_tool_call",
      id,
      toolCallId: `model-${id}`,
      toolName: "test_tool",
      arguments: {},
    });
  const cancel = (targetId = "call-1", id = `cancel-${targetId}`) =>
    dispatch({ type: "host_tool_cancel", id, targetId });
  return { frames, runtimeSession, call, cancel };
}

async function waitForAsyncCall(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("OMP host tools", () => {
  test("serializes Paseo catalog tools to OMP set_host_tools definitions with MCP JSON Schema", () => {
    const catalog = createCatalog([
      {
        name: "create_agent",
        title: "Create agent",
        description: "Create a Paseo agent.",
        inputSchema: {
          initialPrompt: z.string().describe("Prompt for the new agent."),
          notifyOnFinish: z.boolean().optional(),
        },
        handler: async () => ({ content: [] }),
      },
    ]);

    expect(serializeOmpHostTools(catalog)).toEqual([
      {
        name: "create_agent",
        label: "Create agent",
        description: "Create a Paseo agent.",
        parameters: expect.objectContaining({
          type: "object",
          properties: {
            initialPrompt: expect.objectContaining({
              type: "string",
              description: "Prompt for the new agent.",
            }),
            notifyOnFinish: expect.objectContaining({
              type: "boolean",
              default: false,
              description:
                "OMP host tools do not inject completion prompts into the active caller. Use wait_for_agent.",
            }),
          },
          required: ["initialPrompt"],
        }),
      },
    ]);
  });

  test("suppresses caller notifications that would interrupt the active OMP turn", async () => {
    let received: unknown;
    const catalog = createCatalog([
      {
        name: "send_agent_prompt",
        description: "Prompt an agent.",
        inputSchema: {},
        handler: async (input) => {
          received = input;
          return { content: [] };
        },
      },
    ]);
    const runtimeSession = {
      sendRawFrame: vi.fn(),
    } as unknown as PiRuntimeSession;

    expect(
      handleOmpHostToolRuntimeEvent(
        {
          type: "host_tool_call",
          id: "call-notify",
          toolCallId: "model-call-notify",
          toolName: "send_agent_prompt",
          arguments: { agentId: "child", prompt: "work", notifyOnFinish: true },
        } as never,
        { runtimeSession, paseoTools: catalog, logger: { debug: vi.fn() } as never },
      ),
    ).toBe(true);
    await waitForAsyncCall();

    expect(received).toEqual({
      agentId: "child",
      prompt: "work",
      notifyOnFinish: false,
    });
  });

  test("cancellation self-resolves upstream and suppresses a late successful handler result", async () => {
    const pending = deferred<PaseoToolResult>();
    let signal: AbortSignal | undefined;
    const harness = createRouterHarness(async (_input, context) => {
      signal = context.signal;
      return await pending.promise;
    });

    expect(harness.call()).toBe(true);
    expect(harness.cancel()).toBe(true);
    expect(signal?.aborted).toBe(true);
    pending.resolve({ content: [{ type: "text", text: "late success" }] });
    await waitForAsyncCall();

    expect(harness.frames).toEqual([]);
  });

  test("suppresses a handler rejection after cancellation without logging a router failure", async () => {
    const pending = deferred<PaseoToolResult>();
    const harness = createRouterHarness(async () => await pending.promise);

    harness.call();
    harness.cancel();
    pending.reject(new Error("late failure"));
    await waitForAsyncCall();

    expect(harness.frames).toEqual([]);
  });

  test("treats duplicate cancellation as an idempotent no-op", async () => {
    const pending = deferred<PaseoToolResult>();
    let abortCount = 0;
    const countAbort = () => {
      abortCount += 1;
    };
    const harness = createRouterHarness(async (_input, context) => {
      context.signal?.addEventListener("abort", countAbort);
      return await pending.promise;
    });

    harness.call();
    harness.cancel("call-1", "cancel-1");
    harness.cancel("call-1", "cancel-2");
    pending.resolve({ content: [] });
    await waitForAsyncCall();

    expect(abortCount).toBe(1);
    expect(harness.frames).toEqual([]);
  });

  test("removes canceled calls immediately without letting their completion delete a reused ID", async () => {
    const first = deferred<PaseoToolResult>();
    const second = deferred<PaseoToolResult>();
    let invocation = 0;
    const harness = createRouterHarness(async () => {
      invocation++;
      return await (invocation === 1 ? first.promise : second.promise);
    });

    harness.call("shared-id");
    harness.cancel("shared-id");
    harness.call("shared-id");
    first.resolve({ content: [{ type: "text", text: "stale" }] });
    await waitForAsyncCall();
    second.resolve({ content: [{ type: "text", text: "current" }] });
    await waitForAsyncCall();

    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({
      type: "host_tool_result",
      id: "shared-id",
      result: { content: [{ type: "text", text: "current" }] },
    });
  });

  test("clears pending router state and allows a fresh router for the runtime session", async () => {
    const pending = deferred<PaseoToolResult>();
    let invocation = 0;
    const harness = createRouterHarness(async () => {
      invocation++;
      return invocation === 1 ? await pending.promise : { content: [] };
    });

    harness.call("before-clear");
    clearOmpHostToolState(harness.runtimeSession);
    pending.resolve({ content: [{ type: "text", text: "stale" }] });
    harness.call("after-clear");
    await waitForAsyncCall();

    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({ type: "host_tool_result", id: "after-clear" });
  });

  test("emits one truthful error terminal when an active handler rejects", async () => {
    const harness = createRouterHarness(async () => {
      throw new Error("handler failed");
    });

    harness.call();
    await waitForAsyncCall();
    harness.cancel();

    expect(harness.frames).toEqual([
      expect.objectContaining({
        type: "host_tool_result",
        id: "call-1",
        isError: true,
        result: expect.objectContaining({
          isError: true,
          content: [{ type: "text", text: "handler failed" }],
        }),
      }),
    ]);
  });

  test("emits updates and one terminal result only while a call remains active", async () => {
    let sendLateUpdate: (() => void) | undefined;
    const harness = createRouterHarness(async (_input, context) => {
      context.sendUpdate?.({ content: [{ type: "text", text: "working" }] });
      sendLateUpdate = () =>
        context.sendUpdate?.({ content: [{ type: "text", text: "too late" }] });
      return { content: [{ type: "text", text: "done" }] };
    });

    harness.call();
    await waitForAsyncCall();
    sendLateUpdate?.();
    harness.cancel();

    expect(harness.frames.map((frame) => frame.type)).toEqual([
      "host_tool_update",
      "host_tool_result",
    ]);
    expect(harness.frames.filter((frame) => frame.type === "host_tool_result")).toHaveLength(1);
  });
});
