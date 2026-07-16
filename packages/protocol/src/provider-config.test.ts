import { describe, expect, it } from "vitest";
import { ProviderOverridesSchema } from "./provider-config.js";

describe("provider override schema", () => {
  it("rejects a provider that declares both extends and module", () => {
    const result = ProviderOverridesSchema.safeParse({
      custom: {
        extends: "claude",
        module: "@example/custom-provider",
        label: "Custom",
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["custom", "module"],
          message: 'Provider "custom" cannot declare both extends and module.',
        }),
      );
    }
  });

  it("rejects module configuration for a built-in provider", () => {
    const result = ProviderOverridesSchema.safeParse({
      claude: { module: "@example/custom-provider" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["claude", "module"],
          message: 'Built-in provider "claude" cannot declare module.',
        }),
      );
    }
  });

  it("accepts an unknown provider that declares a module", () => {
    expect(
      ProviderOverridesSchema.safeParse({
        custom: {
          module: "@example/custom-provider",
          label: "Custom",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown provider that declares neither extends nor module", () => {
    const result = ProviderOverridesSchema.safeParse({
      custom: { label: "Custom" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["custom", "extends"],
          message: 'Custom provider "custom" must declare extends or module.',
        }),
      );
    }
  });
});
