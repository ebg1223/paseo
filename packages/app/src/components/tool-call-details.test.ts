import { vi } from "vitest";

vi.mock("react-native", () => ({
  View: () => null,
  Text: () => null,
  Pressable: () => null,
  ScrollView: () => null,
  Platform: { OS: "web" },
}));
vi.mock("react-native-gesture-handler", () => ({ ScrollView: () => null }));
vi.mock("react-native-unistyles", () => ({
  withUnistyles: (component: unknown) => component,
  StyleSheet: { create: () => ({}) },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => ({}) }));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: vi.fn() }));

import { describe, expect, it } from "vitest";

import {
  resolveSubAgentChildren,
  resolveSubAgentNavigationTargets,
  resolveSubAgentRenderRows,
} from "./tool-call-details";

describe("sub-agent navigation targets", () => {
  it("preserves ordered children with repeated labels as distinct imported agents", () => {
    const children = [
      { sessionId: "/tmp/one.jsonl", label: "task — Inspect", status: "running" as const },
      { sessionId: "/tmp/two.jsonl", label: "task — Inspect", status: "completed" as const },
    ];
    const targets = resolveSubAgentNavigationTargets(children, [
      {
        serverId: "server-a",
        id: "agent-two",
        workspaceId: "workspace-a",
        persistence: { nativeHandle: "/tmp/two.jsonl" },
      },
      {
        serverId: "server-a",
        id: "agent-one",
        workspaceId: "workspace-a",
        persistence: { nativeHandle: "/tmp/one.jsonl" },
      },
    ]);

    expect(targets.map((target) => [target.child.label, target.agentId])).toEqual([
      ["task — Inspect", "agent-one"],
      ["task — Inspect", "agent-two"],
    ]);
  });

  it("keeps mixed imported and pending children as one ordered row per declaration", () => {
    const children = [
      { sessionId: "/tmp/imported.jsonl", label: "task — Imported", status: "running" as const },
      { sessionId: "/tmp/pending.jsonl", label: "task — Pending", status: "pending" as const },
    ];
    const rows = resolveSubAgentRenderRows(children, [
      {
        serverId: "server-a",
        id: "active-agent",
        persistence: { nativeHandle: "/tmp/imported.jsonl" },
      },
    ]);

    expect(rows).toEqual([
      {
        child: children[0],
        target: { serverId: "server-a", agentId: "active-agent" },
      },
      { child: children[1], target: null },
    ]);
  });

  it("keeps every pending child visible when none have imported", () => {
    const children = [
      { sessionId: "/tmp/one.jsonl", label: "task — One", status: "pending" as const },
      { sessionId: "/tmp/two.jsonl", label: "task — Two", status: "running" as const },
    ];

    expect(resolveSubAgentRenderRows(children, [])).toEqual([
      { child: children[0], target: null },
      { child: children[1], target: null },
    ]);
  });

  it("resolves children from the combined active and detail agent collections", () => {
    const children = [
      { sessionId: "/tmp/active.jsonl", label: "active", status: "running" as const },
      { sessionId: "/tmp/detail.jsonl", label: "detail", status: "completed" as const },
    ];
    const activeAgents = [
      {
        serverId: "server-a",
        id: "active-agent",
        persistence: { nativeHandle: "/tmp/active.jsonl" },
      },
    ];
    const agentDetails = [
      {
        serverId: "server-a",
        id: "detail-agent",
        persistence: { nativeHandle: "/tmp/detail.jsonl" },
      },
    ];

    expect(
      resolveSubAgentRenderRows(children, [...activeAgents, ...agentDetails]).map(
        (row) => row.target?.agentId,
      ),
    ).toEqual(["active-agent", "detail-agent"]);
  });

  it("uses the legacy first-child session fallback only when children are absent", () => {
    expect(resolveSubAgentChildren(undefined, "/tmp/legacy.jsonl")).toEqual([
      {
        sessionId: "/tmp/legacy.jsonl",
        label: "session /tmp/legacy.jsonl",
        status: "running",
      },
    ]);
    const children = [
      { sessionId: "/tmp/new.jsonl", label: "task — New", status: "pending" as const },
    ];
    expect(resolveSubAgentChildren(children, "/tmp/legacy.jsonl")).toBe(children);
  });
});
