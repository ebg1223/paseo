import type { AgentSlashCommand, AgentSlashCommandKind } from "../../agent-sdk-types.js";
import type { PiRpcSlashCommand } from "../pi-shared/rpc-types.js";
import { OmpAvailableCommandsUpdateEventSchema, type OmpAvailableCommand } from "./rpc-types.js";

export const OMP_HANDLED_BUILTIN_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  {
    name: "compact",
    description: "Manually compact the session context",
    argumentHint: "[instructions]",
    kind: "command",
  },
  {
    name: "autocompact",
    description: "Toggle automatic context compaction",
    argumentHint: "[on|off|toggle]",
    kind: "command",
  },
  {
    name: "handoff",
    description: "Hand off from planning to implementation",
    argumentHint: "[instructions]",
    kind: "command",
  },
];

export function mapOmpSlashCommands(commands: readonly OmpAvailableCommand[]): AgentSlashCommand[] {
  const mappedCommands = new Map<string, AgentSlashCommand>(
    OMP_HANDLED_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, { ...command }]),
  );
  for (const command of commands) {
    const knownCommand = mappedCommands.get(command.name);
    mappedCommands.set(command.name, {
      name: command.name,
      description: command.description ?? command.source ?? "command",
      argumentHint: command.input?.hint ?? knownCommand?.argumentHint ?? "",
      kind: mapOmpCommandKind(command.source),
    });
  }
  return [...mappedCommands.values()];
}

export function mapOmpRuntimeSlashCommands(
  commands: readonly PiRpcSlashCommand[],
): AgentSlashCommand[] {
  return mapOmpSlashCommands(
    commands.map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      source: command.source,
    })),
  );
}

export function mapOmpAvailableCommandsUpdate(event: unknown): AgentSlashCommand[] | null {
  const parsed = OmpAvailableCommandsUpdateEventSchema.safeParse(event);
  return parsed.success ? mapOmpSlashCommands(parsed.data.commands) : null;
}

function mapOmpCommandKind(source: string | undefined): AgentSlashCommandKind {
  return source === "skill" ? "skill" : "command";
}
