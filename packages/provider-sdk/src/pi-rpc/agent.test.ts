import { describe, expect, it } from "vitest";
import type { AgentCapabilityFlags, AgentStreamEvent } from "../agent-sdk-types.js";
import type { Logger } from "pino";
import { PiRpcAgentSession, type PiDialect } from "./agent.js";
import { FakePi, type FakePiSession } from "./test-utils/fake-pi.js";

const provider = "pi" as PiDialect["providerId"];

async function createSession(
  options: { live?: boolean; onTurnFinished?: PiDialect["onTurnFinished"] } = {},
) {
  const runtime = new FakePi();
  const runtimeSession = (await runtime.startSession({ cwd: "/tmp" })) as FakePiSession;
  const dialect: PiDialect = {
    providerId: provider,
    label: "Test Pi",
    defaultCommand: ["pi"],
    commandsRpcName: "get_commands",
    usePaseoExtension: false,
    onTurnFinished: options.onTurnFinished,
  };
  const session = new PiRpcAgentSession({
    runtimeSession,
    config: { provider, cwd: "/tmp" },
    initialState: await runtimeSession.getState(),
    capabilities: {} as AgentCapabilityFlags,
    dialect,
    logger: {} as Logger,
    live: options.live,
  });
  return { runtimeSession, session };
}

function collect(session: PiRpcAgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

describe("PiRpcAgentSession lifecycle", () => {
  it("terminalizes in-flight tools before canceling an interrupted turn", async () => {
    const order: string[] = [];
    const { runtimeSession, session } = await createSession({
      onTurnFinished: ({ reason }) => order.push(`finished:${reason}`),
    });
    const events = collect(session);
    session.subscribe((event) => order.push(event.type));
    const { turnId } = await session.startTurn([{ type: "text", text: "hello" }]);
    runtimeSession.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: {},
    });

    await session.interrupt();

    const terminalTool = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "canceled",
    );
    expect(terminalTool).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "turn_canceled", turnId });
    expect(order.indexOf("finished:canceled")).toBeLessThan(order.indexOf("turn_canceled"));
    await expect(session.startTurn([{ type: "text", text: "next" }])).resolves.toBeDefined();
  });

  it("terminalizes in-flight tools before failing a turn on process exit", async () => {
    const order: string[] = [];
    const { runtimeSession, session } = await createSession({
      onTurnFinished: ({ reason }) => order.push(`finished:${reason}`),
    });
    const events = collect(session);
    session.subscribe((event) => order.push(event.type));
    const { turnId } = await session.startTurn([{ type: "text", text: "hello" }]);
    runtimeSession.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: {},
    });
    runtimeSession.emit({ type: "process_exit", error: "exited" });

    const terminalToolIndex = events.findIndex(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "canceled",
    );
    const failedIndex = events.findIndex((event) => event.type === "turn_failed");
    expect(terminalToolIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThan(terminalToolIndex);
    expect(events[failedIndex]).toMatchObject({ type: "turn_failed", turnId, error: "exited" });
    expect(order.indexOf("finished:failed")).toBeLessThan(order.indexOf("turn_failed"));
    await expect(session.startTurn([{ type: "text", text: "next" }])).resolves.toBeDefined();
  });

  it("suppresses replayed agent messages until a new turn starts", async () => {
    const { runtimeSession, session } = await createSession({ live: false });
    const events = collect(session);
    runtimeSession.emit({ type: "message_end", message: { role: "user", content: "replayed" } });
    runtimeSession.emit({
      type: "message_end",
      message: { role: "assistant", content: "replayed" },
    });
    expect(events).toEqual([]);

    await session.startTurn([{ type: "text", text: "live" }]);
    runtimeSession.emit({ type: "message_end", message: { role: "user", content: "live" } });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "user_message", text: "live" }),
      }),
    );
  });

  it("does not re-emit native user messages that were already seen", async () => {
    const { runtimeSession, session } = await createSession();
    const events = collect(session);
    const message = { role: "user" as const, content: "hello", id: "entry-1" };
    runtimeSession.emit({ type: "message_end", message });
    runtimeSession.emit({ type: "message_end", message });

    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toHaveLength(1);
  });
});
