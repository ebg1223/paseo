import { describe, expect, test } from "vitest";
import {
  getParentAgentIdFromLabels,
  getProviderChildOwnershipFromLabels,
  getProviderChildOwnershipLabels,
  isDelegatedAgent,
  PARENT_AGENT_ID_LABEL,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });
  test("round trips every provider child ownership state", () => {
    expect(
      getProviderChildOwnershipFromLabels(getProviderChildOwnershipLabels({ owner: "provider" })),
    ).toEqual({ owner: "provider" });
    expect(
      getProviderChildOwnershipFromLabels(
        getProviderChildOwnershipLabels({ owner: "paseo", resumable: true }),
      ),
    ).toEqual({ owner: "paseo", resumable: true });
    expect(
      getProviderChildOwnershipFromLabels(
        getProviderChildOwnershipLabels({ owner: "none", resumable: false, reason: "Closed" }),
      ),
    ).toEqual({ owner: "none", resumable: false, reason: "Closed" });
  });

  test("keeps missing and malformed ownership labels unrestricted", () => {
    expect(getProviderChildOwnershipFromLabels(undefined)).toBeNull();
    expect(
      getProviderChildOwnershipFromLabels({ "paseo.provider-child-owner": "paseo" }),
    ).toBeNull();
    expect(
      getProviderChildOwnershipFromLabels({
        "paseo.provider-child-owner": "none",
        "paseo.provider-child-resumable": "false",
      }),
    ).toEqual({ owner: "none", resumable: false, reason: "Provider child is read-only" });
  });
});
