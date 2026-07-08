import { z } from "zod";
import { describe, expect, test } from "vitest";

import { serializePaseoToolInputParameters } from "./mcp-serialization.js";
import type { PaseoToolDefinition } from "./types.js";

describe("MCP tool serialization", () => {
  test("uses the shared MCP SDK converter for representative tool schemas", () => {
    const tool: PaseoToolDefinition = {
      name: "representative_tool",
      description: "Representative schema guard",
      inputSchema: {
        mode: z.union([z.literal("foreground"), z.literal("background")]),
        target: z.union([z.string(), z.number()]),
      },
      async handler() {
        return { content: [] };
      },
    };

    expect(serializePaseoToolInputParameters(tool)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        mode: {
          anyOf: [
            { type: "string", const: "foreground" },
            { type: "string", const: "background" },
          ],
        },
        target: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
      required: ["mode", "target"],
    });
  });
});
