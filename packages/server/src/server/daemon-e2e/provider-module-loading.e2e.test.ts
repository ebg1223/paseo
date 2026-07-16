import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { createPaseoDaemon } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

const fixturePath = fileURLToPath(
  new URL("../agent/__fixtures__/valid-module.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

describe("provider module loading", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("boots with loaded and broken configured provider modules", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-provider-modules-"));
    const pluginFixturePath = path.join(paseoHome, "valid-module.mjs");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-provider-modules-static-"));
    temporaryDirectories.push(paseoHome, staticDir);
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      pluginFixturePath,
      (await readFile(fixturePath, "utf8")).replace('id: "valid"', 'id: "fixture-plugin"'),
    );
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        agents: {
          providers: {
            "fixture-plugin": { module: pluginFixturePath, label: "Fixture" },
            "broken-plugin": { module: "/nonexistent.mjs", label: "Broken" },
          },
        },
      }),
    );

    const config = loadConfig(paseoHome, { env: {} });
    expect(config.providerOverrides).toMatchObject({
      "fixture-plugin": { module: pluginFixturePath },
      "broken-plugin": { module: "/nonexistent.mjs" },
    });
    config.listen = "127.0.0.1:0";
    config.staticDir = staticDir;
    config.agentClients = createTestAgentClients();
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));

    try {
      await daemon.start();
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Expected daemon TCP listener");
      }
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${listenTarget.port}/ws`,
        appVersion: "999.0.0",
      });
      await client.connect();
      const snapshot = await client.getProvidersSnapshot();
      await client.close();
      expect(snapshot.entries.find((entry) => entry.provider === "fixture-plugin")).toBeDefined();
      expect(snapshot.entries.find((entry) => entry.provider === "broken-plugin")).toMatchObject({
        provider: "broken-plugin",
        status: "error",
        enabled: false,
        label: "broken-plugin",
        error: expect.stringContaining('Failed to load provider module "/nonexistent.mjs"'),
      });
    } finally {
      await daemon.stop();
    }
  });
});
