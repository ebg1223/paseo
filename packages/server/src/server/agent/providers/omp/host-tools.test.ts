import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { PaseoToolCatalog, PaseoToolDefinition } from "../../tools/types.js";
import { serializeOmpHostTools } from "./host-tools.js";

function createCatalog(tools: PaseoToolDefinition[]): PaseoToolCatalog {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: toolMap,
    getTool: (name) => toolMap.get(name),
    executeTool: async (name, input, context) => {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new Error(`Missing tool ${name}`);
      }
      return await tool.handler(input, context);
    },
  };
}

describe("OMP host tools", () => {
  test("serializes Paseo catalog tools to OMP set_host_tools definitions with MCP JSON Schema", () => {
    const catalog = createCatalog([
      {
        name: "create_agent",
        title: "Create agent",
        description: "Create a Paseo agent.",
        inputSchema: {
          initialPrompt: z.string().describe("Prompt for the new agent."),
          notifyOnFinish: z.boolean().optional(),
        },
        handler: async () => ({ content: [] }),
      },
    ]);

    expect(serializeOmpHostTools(catalog)).toEqual([
      {
        name: "create_agent",
        label: "Create agent",
        description: "Create a Paseo agent.",
        parameters: expect.objectContaining({
          type: "object",
          properties: {
            initialPrompt: expect.objectContaining({
              type: "string",
              description: "Prompt for the new agent.",
            }),
            notifyOnFinish: expect.objectContaining({
              type: "boolean",
            }),
          },
          required: ["initialPrompt"],
        }),
      },
    ]);
  });
});
