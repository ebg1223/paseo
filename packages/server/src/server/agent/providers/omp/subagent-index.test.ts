import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import { OmpSubagentIndex } from "./subagent-index.js";
import {
  classifyReleasedOmpChild,
  discoverReleasedOmpHistoricalChildren,
} from "./virtual-child-session.js";
const runtime = () => ({}) as PiRuntimeSession;

describe("OMP subagent ownership index", () => {
  test("scopes identical session and child ids to the parent runtime", () => {
    const index = new OmpSubagentIndex();
    const first = runtime();
    const second = runtime();
    index.upsert({
      sessionFile: "/tmp/shared.jsonl",
      subagentId: "Explore",
      status: "running",
      parentRuntime: first,
    });
    index.upsert({
      sessionFile: "/tmp/shared.jsonl",
      subagentId: "Explore",
      status: "running",
      parentRuntime: second,
    });

    expect(index.get("/tmp/shared.jsonl")).toBeNull();
    expect(index.getForParent(first, "/tmp/shared.jsonl")?.parentRuntime).toBe(first);
    expect(index.getForParent(second, "/tmp/shared.jsonl")?.parentRuntime).toBe(second);

    index.terminal(first, "/tmp/shared.jsonl", "completed");
    expect(index.getForParent(first, "/tmp/shared.jsonl")?.status).toBe("completed");
    expect(index.getForParent(second, "/tmp/shared.jsonl")?.status).toBe("running");
  });

  test("keeps same-named children distinct by session identity under one parent", () => {
    const index = new OmpSubagentIndex();
    const parent = runtime();
    index.upsert({
      sessionFile: "/tmp/first.jsonl",
      subagentId: "Repeated",
      status: "running",
      parentRuntime: parent,
    });
    index.upsert({
      sessionFile: "/tmp/second.jsonl",
      subagentId: "Repeated",
      status: "pending",
      parentRuntime: parent,
    });

    expect(index.getForParent(parent, "/tmp/first.jsonl")?.status).toBe("running");
    expect(index.getForParent(parent, "/tmp/second.jsonl")?.status).toBe("pending");
  });

  test("awaits final subscriber hydration and releases a parent idempotently", async () => {
    const index = new OmpSubagentIndex();
    const parent = runtime();
    const ordering: string[] = [];
    index.upsert({
      sessionFile: "/tmp/child.jsonl",
      subagentId: "Child",
      status: "running",
      parentRuntime: parent,
      classifyRelease: async () => {
        ordering.push("classified");
        return { resumable: true, reason: "" };
      },
    });
    index.subscribe(parent, "/tmp/child.jsonl", async (event) => {
      if (event.type === "released") {
        await Promise.resolve();
        ordering.push("hydrated");
      }
    });
    index.terminal(parent, "/tmp/child.jsonl", "completed");

    expect(index.getForParent(parent, "/tmp/child.jsonl")?.ownership).toBe("provider");
    await expect(index.releaseParent(parent)).resolves.toHaveLength(1);
    await expect(index.releaseParent(parent)).resolves.toEqual([]);
    expect(ordering).toEqual(["classified", "hydrated"]);
    expect(index.get("/tmp/child.jsonl")).toBeNull();
    expect(index.getForParent(parent, "/tmp/child.jsonl")).toBeNull();

    index.updateProgress({
      sessionFile: "/tmp/child.jsonl",
      subagentId: "Child",
      status: "running",
      parentRuntime: parent,
    });
    expect(index.getForParent(parent, "/tmp/child.jsonl")).toBeNull();
  });
  test("replays a retained terminal once to a late subscriber", async () => {
    const index = new OmpSubagentIndex();
    const parent = runtime();
    index.upsert({
      sessionFile: "/tmp/late.jsonl",
      subagentId: "Late",
      status: "running",
      parentRuntime: parent,
    });
    index.terminal(parent, "/tmp/late.jsonl", "completed");

    const events: string[] = [];
    index.subscribe(parent, "/tmp/late.jsonl", (event) => events.push(event.type));
    await Promise.resolve();

    expect(events).toEqual(["terminal"]);
  });

  test("keeps the first terminal status and ignores later progress", () => {
    const index = new OmpSubagentIndex();
    const parent = runtime();
    const events: string[] = [];
    index.upsert({
      sessionFile: "/tmp/monotonic.jsonl",
      subagentId: "Monotonic",
      status: "running",
      parentRuntime: parent,
    });
    index.subscribe(parent, "/tmp/monotonic.jsonl", (event) => events.push(event.type));

    index.terminal(parent, "/tmp/monotonic.jsonl", "completed");
    index.terminal(parent, "/tmp/monotonic.jsonl", "failed");
    index.updateProgress({
      sessionFile: "/tmp/monotonic.jsonl",
      subagentId: "Monotonic",
      status: "running",
      parentRuntime: parent,
    });

    expect(index.getForParent(parent, "/tmp/monotonic.jsonl")?.status).toBe("completed");
    expect(events).toEqual(["terminal"]);
  });

  test("shares an in-flight release and emits ownership once", async () => {
    const index = new OmpSubagentIndex();
    const parent = runtime();
    let finishClassification: (() => void) | undefined;
    const classification = new Promise<void>((resolve) => {
      finishClassification = resolve;
    });
    let emissions = 0;
    index.upsert({
      sessionFile: "/tmp/racing-release.jsonl",
      subagentId: "Race",
      status: "completed",
      parentRuntime: parent,
      classifyRelease: async () => {
        await classification;
        return { resumable: true, reason: "" };
      },
      emitOwnership: () => {
        emissions += 1;
      },
    });

    const processExit = index.releaseParent(parent);
    const close = index.releaseParent(parent);
    let closeFinished = false;
    void close.then(() => {
      closeFinished = true;
      return undefined;
    });
    await Promise.resolve();
    expect(closeFinished).toBe(false);

    finishClassification?.();
    const [processExitEntries, closeEntries] = await Promise.all([processExit, close]);
    expect(closeEntries).toBe(processExitEntries);
    expect(emissions).toBe(1);
    await expect(index.releaseParent(parent)).resolves.toEqual([]);
  });
});

describe("released OMP child classification", () => {
  test("requires a valid session contract and existing matching cwd", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-release-"));
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd);
    const valid = path.join(root, "valid.jsonl");
    writeFileSync(
      valid,
      [
        JSON.stringify({ type: "title", title: "Child" }),
        JSON.stringify({ type: "session", id: "child", cwd }),
        JSON.stringify({ type: "session_init" }),
      ].join("\n"),
    );

    await expect(classifyReleasedOmpChild(valid, cwd)).resolves.toEqual({
      resumable: true,
      reason: "",
    });
    await expect(classifyReleasedOmpChild(valid, path.join(root, "other"))).resolves.toMatchObject({
      resumable: false,
    });
    await expect(
      classifyReleasedOmpChild(path.join(root, "missing.jsonl"), cwd),
    ).resolves.toMatchObject({ resumable: false });
  });

  test("rejects malformed and explicitly isolated contracts", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-isolated-"));
    const malformed = path.join(root, "malformed.jsonl");
    writeFileSync(malformed, "not-json\n");
    const isolated = path.join(root, "isolated.jsonl");
    writeFileSync(
      isolated,
      [
        JSON.stringify({ type: "session", id: "child", cwd: root }),
        JSON.stringify({ type: "session_init", isolated: true }),
      ].join("\n"),
    );

    await expect(classifyReleasedOmpChild(malformed, root)).resolves.toMatchObject({
      resumable: false,
    });
    await expect(classifyReleasedOmpChild(isolated, root)).resolves.toMatchObject({
      resumable: false,
    });
  });

  test("preserves the hierarchy of nested released transcripts", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-nested-"));
    const parent = path.join(root, "Parent.jsonl");
    const first = path.join(root, "Parent", "A.jsonl");
    const second = path.join(root, "Parent", "A", "B.jsonl");
    mkdirSync(path.dirname(second), { recursive: true });
    const transcript = (id: string) =>
      [
        JSON.stringify({ type: "session", id, cwd: root }),
        JSON.stringify({ type: "session_init" }),
      ].join("\n");
    writeFileSync(parent, transcript("Parent"));
    writeFileSync(first, transcript("A"));
    writeFileSync(second, transcript("B"));

    await expect(discoverReleasedOmpHistoricalChildren(parent)).resolves.toEqual([
      {
        sessionFile: first,
        parentSessionFile: parent,
        nativeChildId: "A",
        ownership: {
          owner: "none",
          resumable: false,
          reason: "historical child transcripts are read-only",
        },
      },
      {
        sessionFile: second,
        parentSessionFile: first,
        nativeChildId: "B",
        ownership: {
          owner: "none",
          resumable: false,
          reason: "historical child transcripts are read-only",
        },
      },
    ]);
  });
});
