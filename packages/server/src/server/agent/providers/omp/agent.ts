import type { Logger } from "pino";

import type {
  AgentTimelineItem,
  AgentPersistenceHandle,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  PiRpcAgentClient as SharedPiRpcAgentClient,
  type PiDialect,
  type PiRpcAgentClientOptions,
} from "../pi-shared/agent.js";
import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import {
  mapOmpAvailableCommandsUpdate,
  mapOmpRuntimeSlashCommands,
  OMP_HANDLED_BUILTIN_SLASH_COMMANDS,
} from "./commands.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { mapOmpTodoReminderEvent, mapOmpTodoState, mapOmpTodoToolResult } from "./todo-mapper.js";
import { filterOmpImportableSessionFiles } from "./session-import-filter.js";
import { asOmpRuntimeSession } from "./runtime.js";
import type {
  OmpRuntimeEvent,
  OmpSubagentLifecyclePayload,
  OmpSubagentStatus,
} from "./rpc-types.js";
import { OmpSubagentIndex, isTerminalOmpSubagentStatus } from "./subagent-index.js";
import { mapOmpUsage } from "./usage-mapper.js";
import { OmpVirtualChildSession } from "./virtual-child-session.js";

const OMP_PROVIDER = "omp";
const OMP_SESSION_DIR = "~/.omp/agent/sessions";
// Fixture-backed Wave 1 parity targets OMP 16.3.9; runtime logic uses capability probing.
export const MIN_SUPPORTED_OMP_VERSION = "16.3.9";

export interface OmpRpcAgentClientOptions extends Omit<PiRpcAgentClientOptions, "dialect"> {}

export class OmpRpcAgentClient extends SharedPiRpcAgentClient {
  constructor(options: OmpRpcAgentClientOptions) {
    const subagentIndex = new OmpSubagentIndex();
    const subagentSessionFilesById = new Map<string, string>();
    super({
      ...options,
      runtimeSettings: mergeRuntimeSettings(
        {
          command: {
            mode: "replace",
            argv: ["omp"],
          },
        },
        options.runtimeSettings,
      ),
      dialect: createOmpDialect(subagentIndex, subagentSessionFilesById, options.logger),
    });
  }
}

function createOmpDialect(
  subagentIndex: OmpSubagentIndex,
  subagentSessionFilesById: Map<string, string>,
  logger: Logger,
): PiDialect {
  const lastTodoItemsBySession = new WeakMap<
    PiRuntimeSession,
    Extract<AgentTimelineItem, { type: "todo" }>
  >();
  return {
    providerId: OMP_PROVIDER,
    label: "OMP",
    defaultCommand: ["omp"],
    commandsRpcName: "get_available_commands",
    defaultSessionDir: OMP_SESSION_DIR,
    ...OMP_HISTORY_MAPPER_HOOKS,
    handledBuiltinSlashCommands: OMP_HANDLED_BUILTIN_SLASH_COMMANDS,
    mapSlashCommands: mapOmpRuntimeSlashCommands,
    mapHydratedTimelineItems: mapOmpTodoState,
    mapUsage: mapOmpUsage,
    filterImportableSessionFiles: filterOmpImportableSessionFiles,
    supportsHandoffCommand: true,
    onSessionStart: (runtimeSession, sessionLogger) => {
      void asOmpRuntimeSession(runtimeSession)
        .setSubagentSubscription("progress")
        .catch((error: unknown) => {
          sessionLogger.debug({ err: error }, "OMP subagent subscription unavailable");
        });
    },
    onSessionClose: (runtimeSession) => {
      subagentIndex.clearParent(runtimeSession);
    },
    handleExtraRuntimeEvent: (event, context) => {
      if (event.type === "subagent_lifecycle") {
        handleSubagentLifecycle(
          event as OmpRuntimeEvent,
          context.runtimeSession,
          context.emit,
          subagentIndex,
          subagentSessionFilesById,
        );
        return true;
      }
      if (event.type === "subagent_progress") {
        handleSubagentProgress(
          event as OmpRuntimeEvent,
          context.runtimeSession,
          subagentIndex,
          subagentSessionFilesById,
        );
        return true;
      }
      if (event.type === "todo_reminder") {
        const item = mapOmpTodoReminderEvent(event);
        if (item && shouldEmitOmpTodoItem(item, context.runtimeSession, lastTodoItemsBySession)) {
          context.emit({
            type: "timeline",
            provider: OMP_PROVIDER,
            item,
          });
        } else {
          context.logger.debug({ event }, "Dropped malformed OMP todo reminder event");
        }
        return true;
      }
      if (event.type === "available_commands_update") {
        const commands = mapOmpAvailableCommandsUpdate(event);
        if (commands) {
          context.setCommandCache(commands);
        } else {
          context.logger.debug({ event }, "Dropped malformed OMP command update event");
        }
        return true;
      }
      return false;
    },
    onToolExecutionEnd: ({
      event,
      result,
      runtimeSession,
      provider,
      turnId,
      emit,
      logger: sessionLogger,
    }) => {
      if (event.toolName !== "todo") {
        return;
      }
      const item = mapOmpTodoToolResult(result);
      if (item && shouldEmitOmpTodoItem(item, runtimeSession, lastTodoItemsBySession)) {
        emit({
          type: "timeline",
          provider,
          turnId,
          item,
        });
      } else {
        sessionLogger.debug({ event }, "Dropped malformed OMP todo tool result");
      }
    },
    importSession: async ({ client, input, context }) => {
      const liveSubagent = subagentIndex.get(input.providerHandleId);
      if (!liveSubagent || isTerminalOmpSubagentStatus(liveSubagent.status)) {
        return null;
      }
      const storedConfig: AgentSessionConfig = {
        ...context.storedConfig,
        provider: OMP_PROVIDER,
        cwd: input.cwd,
      };
      const config: AgentSessionConfig = {
        ...context.config,
        provider: OMP_PROVIDER,
        cwd: input.cwd,
      };
      const persistence: AgentPersistenceHandle = {
        provider: OMP_PROVIDER,
        sessionId: input.providerHandleId,
        nativeHandle: input.providerHandleId,
        metadata: {
          ...storedConfig,
          provider: OMP_PROVIDER,
          cwd: input.cwd,
        },
      };
      const initialMessages = await asOmpRuntimeSession(
        liveSubagent.parentRuntime,
      ).getSubagentMessages({
        sessionFile: input.providerHandleId,
        fromByte: 0,
      });
      const session = new OmpVirtualChildSession({
        provider: OMP_PROVIDER,
        sessionFile: input.providerHandleId,
        index: subagentIndex,
        parentRuntime: liveSubagent.parentRuntime,
        initialMessages,
        persistence,
        config,
        capabilities: client.capabilities,
        resumeSession: client.resumeSession.bind(client),
        launchContext: context.launchContext,
        logger,
      });
      return {
        session,
        config: storedConfig,
        persistence,
        timeline: session.getInitialTimeline(),
      };
    },
  };
}

function handleSubagentLifecycle(
  event: OmpRuntimeEvent,
  runtimeSession: PiRuntimeSession,
  emit: (event: AgentStreamEvent) => void,
  subagentIndex: OmpSubagentIndex,
  subagentSessionFilesById: Map<string, string>,
): void {
  if (event.type !== "subagent_lifecycle") {
    return;
  }
  const payload = event.payload;
  const sessionFile = resolveSubagentSessionFile(
    payload.id,
    payload.sessionFile,
    subagentSessionFilesById,
  );
  if (!sessionFile) {
    return;
  }

  const status = mapOmpSubagentLifecycleStatus(payload.status);
  if (isTerminalOmpSubagentStatus(status)) {
    subagentIndex.terminal(sessionFile, status);
  } else {
    subagentIndex.upsert({
      sessionFile,
      subagentId: payload.id,
      status,
      parentRuntime: runtimeSession,
      ...(payload.description ? { title: payload.description } : {}),
    });
  }
  emit({
    type: "child_session",
    provider: OMP_PROVIDER,
    childSessionId: sessionFile,
    status,
    ...(payload.description ? { title: payload.description } : {}),
  });
}

function handleSubagentProgress(
  event: OmpRuntimeEvent,
  runtimeSession: PiRuntimeSession,
  subagentIndex: OmpSubagentIndex,
  subagentSessionFilesById: Map<string, string>,
): void {
  if (event.type !== "subagent_progress") {
    return;
  }
  const payload = event.payload;
  const sessionFile = resolveSubagentSessionFile(
    payload.progress.id,
    payload.sessionFile,
    subagentSessionFilesById,
  );
  if (!sessionFile) {
    return;
  }
  subagentIndex.updateProgress({
    sessionFile,
    subagentId: payload.progress.id,
    status: payload.progress.status,
    parentRuntime: runtimeSession,
    ...(payload.progress.description ? { title: payload.progress.description } : {}),
  });
}

function resolveSubagentSessionFile(
  subagentId: string,
  sessionFile: string | undefined,
  subagentSessionFilesById: Map<string, string>,
): string | null {
  if (sessionFile) {
    subagentSessionFilesById.set(subagentId, sessionFile);
    return sessionFile;
  }
  return subagentSessionFilesById.get(subagentId) ?? null;
}

function mapOmpSubagentLifecycleStatus(
  status: OmpSubagentLifecyclePayload["status"],
): Exclude<OmpSubagentStatus, "pending"> {
  return status === "started" ? "running" : status;
}

function shouldEmitOmpTodoItem(
  item: AgentTimelineItem,
  runtimeSession: PiRuntimeSession,
  lastTodoItemsBySession: WeakMap<PiRuntimeSession, Extract<AgentTimelineItem, { type: "todo" }>>,
): boolean {
  if (item.type !== "todo") {
    return true;
  }
  const previous = lastTodoItemsBySession.get(runtimeSession);
  if (previous && areTodoItemsEqual(previous, item)) {
    return false;
  }
  lastTodoItemsBySession.set(runtimeSession, item);
  return true;
}

function areTodoItemsEqual(
  left: Extract<AgentTimelineItem, { type: "todo" }>,
  right: Extract<AgentTimelineItem, { type: "todo" }>,
): boolean {
  if (left.items.length !== right.items.length) {
    return false;
  }
  return left.items.every((leftItem, index) => {
    const rightItem = right.items[index];
    return rightItem?.text === leftItem.text && rightItem.completed === leftItem.completed;
  });
}

function mergeRuntimeSettings(
  base: ProviderRuntimeSettings | undefined,
  override: ProviderRuntimeSettings | undefined,
): ProviderRuntimeSettings | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    command: override?.command ?? base?.command,
    env:
      base?.env || override?.env
        ? {
            ...base?.env,
            ...override?.env,
          }
        : undefined,
    disallowedTools:
      base?.disallowedTools || override?.disallowedTools
        ? [...(base?.disallowedTools ?? []), ...(override?.disallowedTools ?? [])]
        : undefined,
  };
}
