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
});
