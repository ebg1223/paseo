import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { OMP_MODES } from "@getpaseo/protocol/provider-manifest";

import type {
  AgentTimelineItem,
  ToolCallDetail,
  AgentPersistenceHandle,
  AgentSessionConfig,
  ImportedTimelineEntry,
} from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
} from "../../provider-launch-config.js";
import {
  PiProviderParamsSchema,
  PiRpcAgentClient as SharedPiRpcAgentClient,
  type PiDialect,
  type PiToolDetailContext,
  type PiRpcAgentClientOptions,
} from "../pi-shared/agent.js";
import { OmpSubagentCardTracker, type OmpSubagentCardScheduler } from "./subagent-card-tracker.js";
import type { PiRuntimeSession } from "../pi-shared/runtime.js";
import {
  mapOmpAvailableCommandsUpdate,
  mapOmpRuntimeSlashCommands,
  OMP_HANDLED_BUILTIN_SLASH_COMMANDS,
} from "./commands.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { streamOmpHistory } from "./history.js";
import { mapOmpTodoReminderEvent, mapOmpTodoState, mapOmpTodoToolResult } from "./todo-mapper.js";
import { filterOmpImportableSessionFiles } from "./session-import-filter.js";
import { asOmpRuntimeSession } from "./runtime.js";
import { mapOmpRuntimeEventToTimelineItem } from "./event-mapper.js";
import type { OmpRuntimeEvent } from "./rpc-types.js";
import { OmpSubagentIndex } from "./subagent-index.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { mapOmpUsage } from "./usage-mapper.js";
import {
  buildOmpRpcUiPermissionResponse,
  mapOmpRpcUiPermissionRequest,
} from "./rpc-ui-permission-mapper.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "../diagnostic-utils.js";

const OMP_PROVIDER = "omp";
const OMP_SESSION_DIR = "~/.omp/agent/sessions";
// Fixture-backed Wave 1 parity targets OMP 16.3.9; runtime logic uses capability probing.
export const MIN_SUPPORTED_OMP_VERSION = "16.3.9";
const DEFAULT_OMP_MODE_ID = "full";
export { OMP_MODES };

const OmpProviderParamsSchema = PiProviderParamsSchema.extend({
  smolModel: z.string().min(1).optional(),
  slowModel: z.string().min(1).optional(),
  planModel: z.string().min(1).optional(),
}).strict();

type OmpProviderParams = z.infer<typeof OmpProviderParamsSchema>;
type SharedPiProviderParams = z.infer<typeof PiProviderParamsSchema>;

export interface OmpModelRoleParams {
  smolModel?: string;
  slowModel?: string;
  planModel?: string;
}

export function resolveOmpLaunchMode(
  modeId: string | undefined,
  modelRoleParams: OmpModelRoleParams = {},
): {
  modeId: string;
  extraArgs: string[];
} {
  const normalizedModeId = modeId ?? DEFAULT_OMP_MODE_ID;
  const modelRoleArgs = resolveOmpModelRoleArgs(modelRoleParams);
  switch (normalizedModeId) {
    case "full":
      return { modeId: "full", extraArgs: ["--approval-mode", "yolo", ...modelRoleArgs] };
    case "ask":
      return {
        modeId: "ask",
        extraArgs: ["--approval-mode", "always-ask", ...modelRoleArgs],
      };
    default:
      throw new Error(`Unsupported OMP mode '${normalizedModeId}'`);
  }
}

function resolveOmpModelRoleArgs(modelRoleParams: OmpModelRoleParams): string[] {
  const args: string[] = [];
  if (modelRoleParams.smolModel) {
    args.push("--smol", modelRoleParams.smolModel);
  }
  if (modelRoleParams.slowModel) {
    args.push("--slow", modelRoleParams.slowModel);
  }
  if (modelRoleParams.planModel) {
    args.push("--plan", modelRoleParams.planModel);
  }
  return args;
}

export interface OmpRpcAgentClientOptions extends Omit<PiRpcAgentClientOptions, "dialect"> {
  subagentCardScheduler?: OmpSubagentCardScheduler;
}

export interface OmpDiagnosticPaths {
  profile: string;
  configRoot: string;
  agentDir: string;
  agentDb: string;
  xdgDataRoot: string;
  xdgStateRoot: string;
  xdgCacheRoot: string;
}

export function resolveOmpDiagnosticPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): OmpDiagnosticPaths {
  const rawProfile = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const normalizedProfile = rawProfile?.trim();
  const profile =
    normalizedProfile && normalizedProfile !== "default" ? normalizedProfile : "default";
  const baseConfigRoot = join(home, env.PI_CONFIG_DIR || ".omp");
  const configRoot =
    profile === "default" ? baseConfigRoot : join(baseConfigRoot, "profiles", profile);
  const defaultAgentDir = join(configRoot, "agent");
  const agentDir =
    profile === "default" && env.PI_CODING_AGENT_DIR
      ? resolve(env.PI_CODING_AGENT_DIR)
      : defaultAgentDir;
  const xdgSupported = platform === "linux" || platform === "darwin";
  const resolveXdgRoot = (variable: "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME") => {
    const base = env[variable];
    if (!xdgSupported || agentDir !== defaultAgentDir || !base) {
      return undefined;
    }
    const appRoot = join(base, "omp");
    const candidate = profile === "default" ? appRoot : join(appRoot, "profiles", profile);
    return existsSync(candidate) ? candidate : undefined;
  };
  const xdgDataRoot = resolveXdgRoot("XDG_DATA_HOME") ?? configRoot;
  const xdgStateRoot = resolveXdgRoot("XDG_STATE_HOME") ?? configRoot;
  const xdgCacheRoot = resolveXdgRoot("XDG_CACHE_HOME") ?? configRoot;

  return {
    profile,
    configRoot,
    agentDir,
    agentDb: join(xdgDataRoot === configRoot ? agentDir : xdgDataRoot, "agent.db"),
    xdgDataRoot,
    xdgStateRoot,
    xdgCacheRoot,
  };
}

export function formatOmpVersionSupport(versionOutput: string): string {
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) {
    return `unknown (minimum ${MIN_SUPPORTED_OMP_VERSION})`;
  }
  const installed = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = MIN_SUPPORTED_OMP_VERSION.split(".").map(Number);
  const supported =
    installed[0]! > minimum[0]! ||
    (installed[0] === minimum[0] &&
      (installed[1]! > minimum[1]! ||
        (installed[1] === minimum[1]! && installed[2]! >= minimum[2]!)));
  return `${match[1]}.${match[2]}.${match[3]} (${supported ? "supported" : "unsupported"}; minimum ${MIN_SUPPORTED_OMP_VERSION})`;
}

export class OmpRpcAgentClient extends SharedPiRpcAgentClient {
  private readonly ompRuntimeSettings?: ProviderRuntimeSettings;
  private readonly diagnosticLogger: Logger;

  constructor(options: OmpRpcAgentClientOptions) {
    const { sharedProviderParams, modelRoleParams } = resolveOmpProviderParams(
      options.providerParams,
    );
    const runtimeSettings = mergeRuntimeSettings(
      {
        command: {
          mode: "replace",
          argv: ["omp"],
        },
      },
      options.runtimeSettings,
    );
    super({
      ...options,
      providerParams: sharedProviderParams,
      runtimeSettings,
      dialect: createOmpDialect(options.subagentCardScheduler, modelRoleParams),
    });
    this.ompRuntimeSettings = runtimeSettings;
    this.diagnosticLogger = options.logger;
  }

  override async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.ompRuntimeSettings?.command,
        defaultBinary: "omp",
      });
      const availability = await checkProviderLaunchAvailable(launch);
      const binaryRows = await buildBinaryDiagnosticRows(launch, availability, {
        versionCommand: {
          command: availability.resolvedPath ?? launch.command,
          args: [...launch.args, "--version"],
          env: this.ompRuntimeSettings?.env,
        },
      });
      const version = binaryRows.find((row) => row.label === "Version")?.value ?? "unknown";
      const env = { ...process.env, ...this.ompRuntimeSettings?.env };
      const paths = resolveOmpDiagnosticPaths(env);
      const bunVersion =
        (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "unavailable";

      return {
        diagnostic: formatProviderDiagnostic("Oh My Pi (OMP)", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["omp", launch.command],
            pathValue: env.PATH ?? env.Path,
          })),
          ...binaryRows,
          { label: "Version support", value: formatOmpVersionSupport(version) },
          { label: "Active profile", value: paths.profile },
          { label: "Config root", value: paths.configRoot },
          { label: "Agent directory", value: paths.agentDir },
          {
            label: "Agent database",
            value: `${paths.agentDb} (${existsSync(paths.agentDb) ? "found" : "not found"})`,
          },
          { label: "XDG data root", value: paths.xdgDataRoot },
          { label: "XDG state root", value: paths.xdgStateRoot },
          { label: "XDG cache root", value: paths.xdgCacheRoot },
          {
            label: "Bun runtime",
            value: `${bunVersion}; npm-installed OMP requires Bun >= 1.3.14`,
          },
        ]),
      };
    } catch (error) {
      this.diagnosticLogger.debug({ err: error }, "OMP diagnostic lookup failed");
      return {
        diagnostic: formatProviderDiagnosticError("Oh My Pi (OMP)", error),
      };
    }
  }
}

function resolveOmpProviderParams(providerParams: unknown): {
  sharedProviderParams: SharedPiProviderParams;
  modelRoleParams: OmpModelRoleParams;
} {
  const parsedParams = OmpProviderParamsSchema.parse(providerParams ?? {});
  return {
    sharedProviderParams: {
      sessionDir: parsedParams.sessionDir ?? OMP_SESSION_DIR,
      extensionTimeoutMs: parsedParams.extensionTimeoutMs,
    },
    modelRoleParams: readOmpModelRoleParams(parsedParams),
  };
}

function readOmpModelRoleParams(params: OmpProviderParams): OmpModelRoleParams {
  return {
    ...(params.smolModel ? { smolModel: params.smolModel } : {}),
    ...(params.slowModel ? { slowModel: params.slowModel } : {}),
    ...(params.planModel ? { planModel: params.planModel } : {}),
  };
}

function createOmpDialect(
  subagentCardScheduler: OmpSubagentCardScheduler | undefined,
  modelRoleParams: OmpModelRoleParams,
): PiDialect {
  const subagentIndex = new OmpSubagentIndex();
  const lastTodoItemsBySession = new WeakMap<
    PiRuntimeSession,
    Extract<AgentTimelineItem, { type: "todo" }>
  >();
  const subagentCardTrackers = new WeakMap<PiRuntimeSession, OmpSubagentCardTracker>();
  const subagentCardTrackerFor = (runtimeSession: PiRuntimeSession): OmpSubagentCardTracker => {
    const existing = subagentCardTrackers.get(runtimeSession);
    if (existing) {
      return existing;
    }
    const tracker = new OmpSubagentCardTracker({ scheduler: subagentCardScheduler });
    subagentCardTrackers.set(runtimeSession, tracker);
    return tracker;
  };
  const clearSubagentCardTracker = (runtimeSession: PiRuntimeSession): void => {
    subagentCardTrackers.get(runtimeSession)?.clear();
    subagentCardTrackers.delete(runtimeSession);
  };
  return {
    providerId: OMP_PROVIDER,
    label: "OMP",
    defaultCommand: ["omp"],
    commandsRpcName: "get_available_commands",
    protocolMode: "rpc-ui",
    supportsMcpServers: false,
    modes: OMP_MODES,
    defaultModeId: DEFAULT_OMP_MODE_ID,
    resolveLaunchMode: (modeId) => resolveOmpLaunchMode(modeId, modelRoleParams),
    setModeNotice: () => ({
      type: "info",
      message:
        "OMP approval mode is set when the agent launches. Start a new OMP session to use a different mode.",
    }),
    defaultSessionDir: OMP_SESSION_DIR,
    usePaseoExtension: false,
    streamHistory: ({ state, provider, runtimeSession }) =>
      streamOmpHistory({ sessionFile: state.sessionFile, provider, runtimeSession }),
    resolveUserMessageId: async ({ runtimeSession, text }) => {
      const messages = await asOmpRuntimeSession(runtimeSession).getBranchMessages();
      return messages.toReversed().find((message) => message.text === text)?.entryId;
    },
    rewindConversation: async ({ runtimeSession, messageId }) => {
      const target = messageId.trim();
      if (!target) {
        throw new Error("OMP rewind requires a user message id");
      }
      await asOmpRuntimeSession(runtimeSession).branch(target);
    },
    ...OMP_HISTORY_MAPPER_HOOKS,
    handledBuiltinSlashCommands: OMP_HANDLED_BUILTIN_SLASH_COMMANDS,
    mapSlashCommands: mapOmpRuntimeSlashCommands,
    promptResultIsAuthoritative: true,
    sendOutOfBandPrompt: (runtimeSession, kind, message) => {
      const ompSession = asOmpRuntimeSession(runtimeSession);
      if (kind === "steer") {
        ompSession.steer(message);
      } else {
        ompSession.followUp(message);
      }
    },
    mapExtensionUiSideEffect: (event) => {
      if (event.method !== "open_url" || typeof event.url !== "string") {
        return null;
      }
      const lines = [`[Open URL](${event.url})`, `URL: ${event.url}`];
      if (typeof event.launchUrl === "string") {
        lines.push(`Launch URL: ${event.launchUrl}`);
      }
      if (typeof event.instructions === "string") {
        lines.push("", event.instructions);
      }
      return { type: "assistant_message", text: lines.join("\n") };
    },
    mapExtensionUiRequestToPermission: (event) =>
      mapOmpRpcUiPermissionRequest(event, { provider: OMP_PROVIDER }),
    buildExtensionUiResponse: buildOmpRpcUiPermissionResponse,
    mapHydratedTimelineItems: mapOmpTodoState,
    mapToolDetail: (toolCall, result, context) =>
      mapOmpToolDetail(toolCall, result, {
        toolCallId: context.toolCallId,
        mapSubagentDetail: (baseDetail) =>
          mapLiveOmpSubagentDetail(baseDetail, context, subagentCardTrackers),
      }),
    mapUsage: mapOmpUsage,
    filterImportableSessionFiles: filterOmpImportableSessionFiles,
    supportsHandoffCommand: true,
    onSessionStart: (runtimeSession, sessionLogger) => {
      const ompSession = asOmpRuntimeSession(runtimeSession);
      void ompSession.setSubagentSubscription("events").catch((eventsError: unknown) => {
        sessionLogger.debug(
          { err: eventsError },
          "OMP subagent event subscription unavailable; falling back to progress",
        );
        void ompSession.setSubagentSubscription("progress").catch((progressError: unknown) => {
          sessionLogger.debug(
            { err: progressError },
            "OMP subagent progress subscription unavailable",
          );
        });
      });
    },
    onSessionClose: (runtimeSession) => {
      subagentIndex.clear(runtimeSession);
      clearSubagentCardTracker(runtimeSession);
    },
    onSessionInterrupt: (runtimeSession) => {
      clearSubagentCardTracker(runtimeSession);
    },
    handleExtraRuntimeEvent: (event, context) => {
      if (event.type === "subagent_lifecycle") {
        const ompEvent = event as Extract<OmpRuntimeEvent, { type: "subagent_lifecycle" }>;
        const payload = ompEvent.payload;
        if (shouldTrackSubagentCard(payload.parentToolCallId, context.hasActiveToolCall)) {
          subagentCardTrackerFor(context.runtimeSession).handleLifecycle(
            payload,
            context.emitActiveToolCall,
          );
        }
        for (const mapped of subagentIndex.handleLifecycle(context.runtimeSession, payload)) {
          context.emit(mapped);
        }
        return true;
      }
      if (event.type === "subagent_progress") {
        const ompEvent = event as Extract<OmpRuntimeEvent, { type: "subagent_progress" }>;
        const payload = ompEvent.payload;
        if (shouldTrackSubagentCard(payload.parentToolCallId, context.hasActiveToolCall)) {
          subagentCardTrackerFor(context.runtimeSession).handleProgress(
            payload,
            context.emitActiveToolCall,
          );
        }
        for (const mapped of subagentIndex.handleProgress(context.runtimeSession, payload)) {
          context.emit(mapped);
        }
        return true;
      }
      if (event.type === "subagent_event") {
        const ompEvent = event as Extract<OmpRuntimeEvent, { type: "subagent_event" }>;
        for (const mapped of subagentIndex.handleEvent(context.runtimeSession, ompEvent.payload)) {
          context.emit(mapped);
        }
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
      const mappedEvent = mapOmpRuntimeEventToTimelineItem(event);
      if (mappedEvent.handled) {
        if (mappedEvent.item) {
          context.emit({
            type: "timeline",
            provider: OMP_PROVIDER,
            item: mappedEvent.item,
          });
        } else {
          context.logger.debug(
            { event, reason: mappedEvent.logReason },
            "Dropped unsupported OMP runtime event",
          );
        }
        return true;
      }
      return false;
    },
    handleUnknownRuntimeEvent: (event, { logger: sessionLogger }) => {
      sessionLogger.debug({ event }, "Dropped unknown OMP runtime event");
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
      if (event.toolName === "task") {
        subagentCardTrackers.get(runtimeSession)?.delete(event.toolCallId);
      }
      if (event.toolName !== "todo") {
        return;
      }
      const item = mapOmpTodoToolResult(result);
      if (item && shouldEmitOmpTodoItem(item, runtimeSession, lastTodoItemsBySession)) {
        emit({ type: "timeline", provider, turnId, item });
      } else {
        sessionLogger.debug({ event }, "Dropped malformed OMP todo tool result");
      }
    },
    importSession: async ({ client, input, context }) => {
      const timeline = await readOmpImportedTimeline(input.providerHandleId);
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
        metadata: { ...storedConfig, provider: OMP_PROVIDER, cwd: input.cwd },
      };
      const session = await client.resumeSession(persistence, config, context.launchContext);
      return {
        session,
        config: storedConfig,
        persistence,
        timeline,
      };
    },
  };
}

function mapLiveOmpSubagentDetail(
  baseDetail: ToolCallDetail,
  context: PiToolDetailContext,
  trackers: WeakMap<PiRuntimeSession, OmpSubagentCardTracker>,
): ToolCallDetail {
  if (!context.runtimeSession) {
    return baseDetail;
  }
  return (
    trackers.get(context.runtimeSession)?.detailFor(context.toolCallId, baseDetail) ?? baseDetail
  );
}

function shouldTrackSubagentCard(
  parentToolCallId: string | undefined,
  hasActiveToolCall: (toolCallId: string) => boolean,
): parentToolCallId is string {
  return typeof parentToolCallId === "string" && hasActiveToolCall(parentToolCallId);
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

async function readOmpImportedTimeline(sessionFile: string): Promise<ImportedTimelineEntry[]> {
  const timeline: ImportedTimelineEntry[] = [];
  for await (const event of streamOmpHistory({ sessionFile, provider: OMP_PROVIDER })) {
    if (event.type !== "timeline") {
      continue;
    }
    timeline.push({
      item: event.item,
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    });
  }
  return timeline;
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
