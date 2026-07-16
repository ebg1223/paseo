import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { loadProviderModules } from "./provider-module-loader.js";

const fixturesDirectory = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const temporaryDirectories: string[] = [];

function fixturePath(name: string): string {
  return join(fixturesDirectory, name);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("loadProviderModules", () => {
  test("loads a valid module from an absolute path", async () => {
    const result = await loadProviderModules(
      { valid: { module: fixturePath("valid-module.mjs") } },
      "/unused",
      createTestLogger(),
    );

    expect(result.failures).toEqual([]);
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.definition.id).toBe("valid");
  });

  test("captures a module with an invalid shape", async () => {
    const result = await loadProviderModules(
      { "bad-shape": { module: fixturePath("bad-shape.mjs") } },
      "/unused",
      createTestLogger(),
    );

    expect(result.modules).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain("createClient must be a function");
  });

  test("captures a module that throws an unstringifiable value", async () => {
    const result = await loadProviderModules(
      { hostile: { module: fixturePath("throws-unstringifiable.mjs") } },
      "/unused",
      createTestLogger(),
    );

    expect(result.modules).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain("could not be stringified");
  });

  test("captures a module that throws during import", async () => {
    const result = await loadProviderModules(
      { throws: { module: fixturePath("throws-on-import.mjs") } },
      "/unused",
      createTestLogger(),
    );

    expect(result.modules).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain("fixture import failure");
  });

  test("captures a module with an incompatible SDK major version", async () => {
    const result = await loadProviderModules(
      { "sdk-major-mismatch": { module: fixturePath("sdk-major-mismatch.mjs") } },
      "/unused",
      createTestLogger(),
    );

    expect(result.modules).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain('sdkVersion "99.0.0" is incompatible');
  });

  test("resolves a bare specifier from the paseo providers directory", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-provider-loader-"));
    temporaryDirectories.push(paseoHome);
    const packageDirectory = join(paseoHome, "providers", "node_modules", "test-provider");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(paseoHome, "providers", "package.json"), "{}");
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: "test-provider", type: "module", exports: "./index.mjs" }),
    );
    await copyFile(fixturePath("valid-module.mjs"), join(packageDirectory, "index.mjs"));

    const result = await loadProviderModules(
      { valid: { module: "test-provider" } },
      paseoHome,
      createTestLogger(),
    );

    expect(result.failures).toEqual([]);
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]?.definition.id).toBe("valid");
  });

  test("captures an unresolved bare specifier", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-provider-loader-"));
    temporaryDirectories.push(paseoHome);
    await mkdir(join(paseoHome, "providers"), { recursive: true });
    await writeFile(join(paseoHome, "providers", "package.json"), "{}");

    const result = await loadProviderModules(
      { missing: { module: "missing-provider" } },
      paseoHome,
      createTestLogger(),
    );

    expect(result.modules).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain(
      'Failed to load provider module "missing-provider"',
    );
  });
});
