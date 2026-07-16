import { describe, expect, test } from "vitest";

import { buildProviderCommand } from "@/utils/provider-command-templates";

describe("buildProviderCommand", () => {
  test("builds OpenCode resume commands from native session ids", () => {
    expect(
      buildProviderCommand({
        provider: "opencode",
        id: "resume",
        sessionId: "ses_abc123",
      }),
    ).toBe("opencode --session ses_abc123");
  });

  test("prefers snapshot command templates over static provider templates", () => {
    expect(
      buildProviderCommand({
        provider: "opencode",
        id: "resume",
        sessionId: "ses_abc123",
        templates: { resume: "custom resume {sessionId}" },
      }),
    ).toBe("custom resume ses_abc123");
  });

  test("falls back to static provider templates when the snapshot omits them", () => {
    expect(
      buildProviderCommand({
        provider: "opencode",
        id: "resume",
        sessionId: "ses_abc123",
      }),
    ).toBe("opencode --session ses_abc123");
  });

  test("falls back to the static OMP template against older daemons", () => {
    expect(
      buildProviderCommand({
        provider: "omp",
        id: "resume",
        sessionId: "ses_abc123",
      }),
    ).toBe("omp --session ses_abc123");
  });
});
