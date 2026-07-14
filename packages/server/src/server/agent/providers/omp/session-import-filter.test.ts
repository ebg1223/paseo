import { describe, expect, test } from "vitest";

import { filterOmpImportableSessionFiles } from "./session-import-filter.js";

describe("OMP session import filter", () => {
  test("keeps both parent and nested task session JSONLs importable", () => {
    const root = "/home/me/.omp/agent/sessions/workspace";
    const parent = `${root}/parent.jsonl`;
    const child = `${root}/parent/Explore.jsonl`;

    expect(
      filterOmpImportableSessionFiles({ filePaths: [parent, child], sessionsDir: root }),
    ).toEqual([parent, child]);
  });
});
