import { describe, expect, test } from "vitest";

import frames from "./__fixtures__/subagent_lifecycle_progress.json" with { type: "json" };
import { OmpSubagentCardTracker, type OmpSubagentCardScheduler } from "./subagent-card-tracker.js";
import type { OmpSubagentLifecyclePayload, OmpSubagentProgressPayload } from "./rpc-types.js";

class ManualScheduler implements OmpSubagentCardScheduler {
  private currentMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { dueMs: number; callback: () => void }>();

  now(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { dueMs: this.currentMs + delayMs, callback });
    return { token: id };
  }

  clearTimeout(timer: { token: unknown }): void {
    if (typeof timer.token === "number") {
      this.timers.delete(timer.token);
    }
  }

  advance(ms: number): void {
    this.currentMs += ms;
    const dueTimers = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueMs <= this.currentMs)
      .sort((left, right) => left[1].dueMs - right[1].dueMs);
    for (const [id, timer] of dueTimers) {
      if (this.timers.delete(id)) {
        timer.callback();
      }
    }
  }
}

describe("OmpSubagentCardTracker", () => {
  test("folds real OMP lifecycle and progress frames into one throttled sub-agent detail", () => {
    const scheduler = new ManualScheduler();
    const emitted: string[] = [];
    const tracker = new OmpSubagentCardTracker({
      scheduler,
      emitToolCall: (toolCallId) => {
        emitted.push(toolCallId);
        return true;
      },
    });
    const parentToolCallId = firstLifecycle().parentToolCallId;
    if (!parentToolCallId) {
      throw new Error("Fixture lifecycle is missing parentToolCallId");
    }

    tracker.handleLifecycle(firstLifecycle());
    for (const payload of progressFrames()) {
      tracker.handleProgress(payload);
    }

    expect(emitted).toEqual([parentToolCallId]);
    const detailBeforeTrailing = tracker.detailFor(parentToolCallId, {
      type: "sub_agent",
      subAgentType: "task",
      description: "Task arg description wins",
      log: "",
    });
    expect(detailBeforeTrailing).toEqual({
      type: "sub_agent",
      subAgentType: "task",
      description: "Task arg description wins",
      childSessionId: "/tmp/omp-task-152709ccd8364628/EchoSubagent.jsonl",
      children: [
        {
          sessionId: "/tmp/omp-task-152709ccd8364628/EchoSubagent.jsonl",
          label: "task — Run echo in subagent",
          status: "completed",
        },
      ],
      log: [
        "EchoSubagent started",
        "[bash] echo subagent-hi",
        "[yield]",
        "EchoSubagent completed",
      ].join("\n"),
    });

    scheduler.advance(500);

    expect(emitted).toEqual([parentToolCallId, parentToolCallId]);
  });

  test("aggregates batch progress streams into one index-prefixed log", () => {
    const scheduler = new ManualScheduler();
    const emitted: string[] = [];
    const tracker = new OmpSubagentCardTracker({
      scheduler,
      emitToolCall: (toolCallId) => {
        emitted.push(toolCallId);
        return true;
      },
    });

    tracker.handleLifecycle({
      id: "Explore",
      agent: "task",
      description: "Inspect files",
      status: "started",
      sessionFile: "/tmp/one.jsonl",
      parentToolCallId: "task.batch-1",
      index: 0,
    });
    scheduler.advance(600);
    tracker.handleProgress({
      index: 5,
      agent: "task",
      task: "Run tests",
      parentToolCallId: "task.batch-1",
      progress: {
        id: "Test",
        status: "running",
        description: "Run tests",
        recentTools: [{ tool: "bash", args: "npm test", endMs: 10 }],
      },
      sessionFile: "/tmp/two.jsonl",
    });

    expect(emitted).toEqual(["task.batch-1", "task.batch-1"]);
    expect(
      tracker.detailFor("task.batch-1", {
        type: "sub_agent",
        subAgentType: "batch",
        actions: [],
        log: "",
      }),
    ).toEqual({
      type: "sub_agent",
      subAgentType: "batch",
      description: "Inspect files",
      childSessionId: "/tmp/one.jsonl",
      children: [
        {
          sessionId: "/tmp/one.jsonl",
          label: "task — Inspect files",
          status: "running",
        },
        {
          sessionId: "/tmp/two.jsonl",
          label: "task — Run tests",
          status: "running",
        },
      ],
      log: "[1/6] Explore started\n[6/6] [bash] npm test",
      actions: [],
    });
  });

  test("keeps dirty trailing state available for final detail and cancels it on cleanup", () => {
    const scheduler = new ManualScheduler();
    const emitted: string[] = [];
    const tracker = new OmpSubagentCardTracker({
      scheduler,
      emitToolCall: (toolCallId) => {
        emitted.push(toolCallId);
        return true;
      },
    });

    tracker.handleLifecycle({
      id: "Explore",
      agent: "task",
      description: "Inspect files",
      status: "started",
      parentToolCallId: "task-1",
      index: 0,
    });
    scheduler.advance(100);
    tracker.handleProgress({
      index: 0,
      agent: "task",
      task: "Inspect files",
      parentToolCallId: "task-1",
      progress: {
        id: "Explore",
        status: "running",
        recentOutput: ["found target file"],
      },
    });

    expect(emitted).toEqual(["task-1"]);
    expect(
      tracker.detailFor("task-1", {
        type: "sub_agent",
        log: "",
      }).log,
    ).toBe("Explore started\nfound target file");

    tracker.delete("task-1");
    scheduler.advance(500);

    expect(emitted).toEqual(["task-1"]);
    expect(
      tracker.detailFor("task-1", {
        type: "sub_agent",
        log: "static",
      }).log,
    ).toBe("static");
  });
});

function firstLifecycle(): OmpSubagentLifecyclePayload {
  const frame = (frames as readonly unknown[]).find(
    (candidate) => isRecord(candidate) && candidate.type === "subagent_lifecycle",
  );
  if (!isRecord(frame) || !isRecord(frame.payload)) {
    throw new Error("Missing lifecycle fixture");
  }
  return frame.payload as unknown as OmpSubagentLifecyclePayload;
}

function progressFrames(): OmpSubagentProgressPayload[] {
  return (frames as readonly unknown[]).flatMap((frame) => {
    if (!isRecord(frame) || frame.type !== "subagent_progress" || !isRecord(frame.payload)) {
      return [];
    }
    return [frame.payload as unknown as OmpSubagentProgressPayload];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
