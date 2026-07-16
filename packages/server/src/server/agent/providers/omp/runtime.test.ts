import { describe, expect, test } from "vitest";
import pino from "pino";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import { FakePi } from "@getpaseo/provider-sdk/pi-rpc";
import { OmpRpcAgentClient } from "./agent.js";
import { asOmpRuntimeSession } from "./runtime.js";

describe("OMP runtime wrapper", () => {
  test("branches natively and returns the restored prompt", async () => {
    const pi = new FakePi(["omp"]);
    const session = await pi.startSession({ cwd: "/tmp/paseo-omp-runtime-test" });
    session.branchResponse = { text: "restore me" };

    await expect(asOmpRuntimeSession(session).branch("entry-1")).resolves.toEqual({
      text: "restore me",
    });
    expect(session.branchRequests).toEqual(["entry-1"]);
  });
  test("rejects a cancelled native branch without changing the active target", async () => {
    const pi = new FakePi(["omp"]);
    const session = await pi.startSession({ cwd: "/tmp/paseo-omp-runtime-test" });
    session.branchResponse = { cancelled: true };
    const runtime = asOmpRuntimeSession(session);

    await expect(runtime.branch("entry-cancelled")).rejects.toThrow("OMP branch was cancelled");
    expect(runtime.activeBranchEntryId).toBeUndefined();
  });
  test("falls back to progress when the event subscription is unavailable", async () => {
    const pi = new FakePi(["omp"]);
    pi.queueSessionSetup((session) => {
      const subscribe = session.setSubagentSubscription.bind(session);
      session.setSubagentSubscription = async (level) => {
        if (level === "events") {
          session.subagentSubscriptionRequests.push(level);
          throw new Error("events unsupported");
        }
        await subscribe(level);
      };
    });
    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: pi,
    });

    const session = await client.createSession({
      provider: "omp",
      cwd: "/tmp/paseo-omp-runtime-test",
    });
    await waitForImmediate();

    expect(pi.latestSession().subagentSubscriptionRequests).toEqual(["events", "progress"]);
    await expect(session.getRuntimeInfo()).resolves.toBeDefined();
  });
});
