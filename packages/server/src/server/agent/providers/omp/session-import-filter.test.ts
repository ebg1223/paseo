import path from "node:path";
import { describe, expect, test } from "vitest";

import pathFrames from "./__fixtures__/subagent_session_file_paths.json" with { type: "json" };
import { filterOmpImportableSessionFiles } from "./session-import-filter.js";

describe("OMP session import filter", () => {
  test("excludes child session files nested under a parent session stem", () => {
    const parentFile = readParentSessionFile();
    const childFile = readChildSessionFile();
    const allFiles = [parentFile, childFile];

    expect(
      filterOmpImportableSessionFiles({
        filePaths: allFiles,
        sessionsDir: path.dirname(parentFile),
      }),
    ).toEqual([parentFile]);
  });
});

function readParentSessionFile(): string {
  const stateBefore = fixtureRecord(0);
  const data = readData(stateBefore);
  if (typeof data.sessionFile !== "string") {
    throw new Error("Path fixture is missing parent sessionFile");
  }
  return data.sessionFile;
}

function readChildSessionFile(): string {
  const lifecycle = fixtureRecord(1);
  const payload = readPayload(lifecycle);
  if (typeof payload.sessionFile !== "string") {
    throw new Error("Path fixture is missing child sessionFile");
  }
  return payload.sessionFile;
}

function fixtureRecord(index: number): Record<string, unknown> {
  const value = (pathFrames as readonly unknown[])[index];
  if (!isRecord(value)) {
    throw new Error(`Missing path fixture record ${index}`);
  }
  return value;
}

function readData(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.data)) {
    throw new Error("Fixture record is missing data");
  }
  return value.data;
}

function readPayload(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.payload)) {
    throw new Error("Fixture record is missing payload");
  }
  return value.payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
