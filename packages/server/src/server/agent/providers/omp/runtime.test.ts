import { describe, expect, test } from "vitest";

import { FakePi } from "../pi-shared/test-utils/fake-pi.js";
import { asOmpRuntimeSession } from "./runtime.js";

describe("OMP runtime wrapper", () => {
  test("skips set_session_name RPC for whitespace-only titles", async () => {
    const pi = new FakePi(["omp"]);
    const session = await pi.startSession({ cwd: "/tmp/paseo-omp-runtime-test" });

    await asOmpRuntimeSession(session).setSessionName("   \n\t   ");

    expect(session.sessionNameRequests).toEqual([]);
  });
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
});
