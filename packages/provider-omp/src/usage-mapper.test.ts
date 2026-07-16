import { describe, expect, test } from "vitest";

import stateFrames from "./__fixtures__/get_state_context_usage.json" with { type: "json" };
import statsFrames from "./__fixtures__/get_session_stats.json" with { type: "json" };
import type { PiSessionState, PiSessionStats } from "@getpaseo/provider-sdk/pi-rpc";
import { mapOmpUsage } from "./usage-mapper.js";

describe("OMP usage mapper", () => {
  test("merges get_state contextUsage into stats-derived AgentUsage", () => {
    const usage = mapOmpUsage({
      stats: readStatsFixture(),
      state: readStateFixture(),
      baseUsage: {
        inputTokens: 28237,
        cachedInputTokens: 269824,
        outputTokens: 548,
        totalCostUsd: 0.29253700000000005,
      },
    });

    expect(usage).toEqual({
      inputTokens: 28237,
      cachedInputTokens: 269824,
      outputTokens: 548,
      totalCostUsd: 0.29253700000000005,
      contextWindowMaxTokens: 272000,
      contextWindowUsedTokens: 23656,
    });
  });
});

function readStatsFixture(): PiSessionStats {
  const response = fixtureRecord(statsFrames, 0);
  if (!isRecord(response.data)) {
    throw new Error("Stats fixture is missing data");
  }
  const tokens = isRecord(response.data.tokens) ? response.data.tokens : {};
  return {
    tokens: {
      input: numberValue(tokens.input),
      output: numberValue(tokens.output),
      cacheRead: numberValue(tokens.cacheRead),
      cacheWrite: numberValue(tokens.cacheWrite),
      total: numberValue(tokens.total),
    },
    cost: numberValue(response.data.cost),
  };
}

function readStateFixture(): PiSessionState {
  const response = fixtureRecord(stateFrames, 2);
  if (!isRecord(response.data)) {
    throw new Error("State fixture is missing data");
  }
  const contextUsage = isRecord(response.data.contextUsage) ? response.data.contextUsage : {};
  return {
    model: null,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    sessionId: "session",
    messageCount: 0,
    pendingMessageCount: 0,
    contextUsage: {
      tokens: numberValue(contextUsage.tokens),
      contextWindow: numberValue(contextUsage.contextWindow),
      percent: numberValue(contextUsage.percent),
    },
  };
}

function fixtureRecord(values: unknown, index: number): Record<string, unknown> {
  if (!Array.isArray(values) || !isRecord(values[index])) {
    throw new Error(`Missing fixture record ${index}`);
  }
  return values[index];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
