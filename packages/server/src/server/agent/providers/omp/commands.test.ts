import { describe, expect, test } from "vitest";

import commandFrames from "./__fixtures__/available_commands_update.json" with { type: "json" };
import { mapOmpAvailableCommandsUpdate, mapOmpSlashCommands } from "./commands.js";

describe("OMP slash command mapper", () => {
  test("maps available_commands_update frames and preserves OMP input hints", () => {
    const commands = mapOmpAvailableCommandsUpdate((commandFrames as readonly unknown[])[0]);
    const todo = commands?.find((command) => command.name === "todo");
    const fast = commands?.find((command) => command.name === "fast");

    expect(todo).toEqual({
      name: "todo",
      description: "Manage todos",
      argumentHint: "<subcommand>",
      kind: "command",
    });
    expect(fast).toEqual({
      name: "fast",
      description: "Toggle fast mode",
      argumentHint: "[on|off|status]",
      kind: "command",
    });
    expect(commands?.some((command) => command.name === "handoff")).toBe(true);
  });

  test("drops malformed command update frames without throwing", () => {
    expect(
      mapOmpAvailableCommandsUpdate({ type: "available_commands_update", commands: [{}] }),
    ).toBeNull();
  });

  test("adds OMP-only handoff to handled built-ins", () => {
    expect(mapOmpSlashCommands([]).map((command) => command.name)).toEqual([
      "compact",
      "autocompact",
      "handoff",
    ]);
  });
});
