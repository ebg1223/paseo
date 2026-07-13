import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { OMP_MODES } from "@getpaseo/protocol/provider-manifest";

import type {
  AgentTimelineItem,
  ToolCallDetail,
  AgentPersistenceHandle,
  AgentSessionConfig,
  AgentStreamEvent,
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
import { OmpReleasedSession } from "./released-session.js";
import { asOmpRuntimeSession } from "./runtime.js";
import { mapOmpRuntimeEventToTimelineItem } from "./event-mapper.js";
import {
  clearOmpHostToolState,
  handleOmpHostToolRuntimeEvent,
  setOmpHostTools,
} from "./host-tools.js";
import type {
  OmpRuntimeEvent,
  OmpSubagentLifecyclePayload,
  OmpSubagentStatus,
} from "./rpc-types.js";
import { OmpSubagentIndex, isTerminalOmpSubagentStatus } from "./subagent-index.js";
import { mapOmpToolDetail } from "./tool-call-mapper.js";
import { mapOmpUsage } from "./usage-mapper.js";
import {
  OmpVirtualChildSession,
  classifyReleasedOmpChild,
  discoverReleasedOmpHistoricalChildren,
} from "./virtual-child-session.js";
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
export const OMP_PASEO_MCP_SYSTEM_PROMPT =
  "OMP task tool = fast in-process helpers inside this OMP session. Paseo create_agent, send_agent_prompt, and wait_for_agent are host tools for independent, user-visible Paseo agents that can run separately from this session.";
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
    const subagentIndex = new OmpSubagentIndex();
    const subagentSessionFilesByRuntime = new WeakMap<PiRuntimeSession, Map<string, string>>();
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
      dialect: createOmpDialect(
        subagentIndex,
        subagentSessionFilesByRuntime,
        options.logger,
        options.subagentCardScheduler,
        modelRoleParams,
      ),
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
  subagentIndex: OmpSubagentIndex,
  subagentSessionFilesByRuntime: WeakMap<PiRuntimeSession, Map<string, string>>,
  logger: Logger,
  subagentCardScheduler: OmpSubagentCardScheduler | undefined,
  modelRoleParams: OmpModelRoleParams,
): PiDialect {
  const lastTodoItemsBySession = new WeakMap<
    PiRuntimeSession,
    Extract<AgentTimelineItem, { type: "todo" }>
  >();
  const subagentCardTrackers = new WeakMap<PiRuntimeSession, OmpSubagentCardTracker>();
  const historicalSubagentSessionFiles = new Set<string>();
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
  const releaseChildren = async (runtimeSession: PiRuntimeSession): Promise<void> => {
    await subagentIndex.releaseParent(runtimeSession);
  };
  return {
    providerId: OMP_PROVIDER,
    label: "OMP",
    defaultCommand: ["omp"],
    commandsRpcName: "get_available_commands",
    protocolMode: "rpc-ui",
    supportsMcpServers: true,
    supportsNativePaseoTools: true,
    appendSystemPrompt: OMP_PASEO_MCP_SYSTEM_PROMPT,
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
      const result = await asOmpRuntimeSession(runtimeSession).branch(target);
      return { restoredPrompt: result.text };
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
      void asOmpRuntimeSession(runtimeSession)
        .setSubagentSubscription("progress")
        .catch((error: unknown) => {
          sessionLogger.debug({ err: error }, "OMP subagent subscription unavailable");
        });
    },
    configureNativePaseoTools: async ({ runtimeSession, catalog }) => {
      await setOmpHostTools(runtimeSession, catalog);
    },
    notifyTitleChanged: async ({ runtimeSession, title }) => {
      await asOmpRuntimeSession(runtimeSession).setSessionName(title);
    },
    beforeSessionClose: releaseChildren,
    onSessionProcessExit: releaseChildren,
    onSessionClose: (runtimeSession) => {
      clearOmpHostToolState(runtimeSession);
      clearSubagentCardTracker(runtimeSession);
    },
    onSessionInterrupt: (runtimeSession) => {
      clearOmpHostToolState(runtimeSession);
      clearSubagentCardTracker(runtimeSession);
    },
    handleExtraRuntimeEvent: (event, context) => {
      if (handleOmpHostToolRuntimeEvent(event, context)) {
        return true;
      }
      if (event.type === "subagent_lifecycle") {
        const ompEvent = event as Extract<OmpRuntimeEvent, { type: "subagent_lifecycle" }>;
        const payload = ompEvent.payload;
        if (shouldTrackSubagentCard(payload.parentToolCallId, context.hasActiveToolCall)) {
          subagentCardTrackerFor(context.runtimeSession).handleLifecycle(
            payload,
            context.emitActiveToolCall,
          );
        }
        handleSubagentLifecycle(
          ompEvent,
          context.runtimeSession,
          context.emit,
          subagentIndex,
          subagentSessionFilesByRuntime,
          historicalSubagentSessionFiles,
          context.cwd,
        );
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
        handleSubagentProgress(
          ompEvent,
          context.runtimeSession,
          subagentIndex,
          subagentSessionFilesByRuntime,
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
      const liveSubagent = subagentIndex.get(input.providerHandleId);
      if (!liveSubagent) {
        const timeline = await readOmpImportedTimeline(input.providerHandleId);
        const isHistorical = historicalSubagentSessionFiles.has(input.providerHandleId);
        const classification = isHistorical
          ? {
              resumable: false,
              reason: "historical child transcripts are read-only",
            }
          : await classifyReleasedOmpChild(input.providerHandleId, input.cwd);
        if (
          !classification.resumable &&
          !isHistorical &&
          classification.reason !== "session uses an isolated workspace" &&
          classification.reason !== "session is isolated or non-resumable"
        ) {
          throw new Error(`OMP history import rejected: ${classification.reason}`);
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
          metadata: { ...storedConfig, provider: OMP_PROVIDER, cwd: input.cwd },
        };
        if (classification.resumable) {
          const session = await client.resumeSession(persistence, config, context.launchContext);
          return {
            session,
            config: storedConfig,
            persistence,
            timeline,
            ownership: { owner: "paseo", resumable: true },
          };
        }
        const session = new OmpReleasedSession(
          OMP_PROVIDER,
          input.providerHandleId,
          config,
          client.capabilities,
        );
        return {
          session,
          config: storedConfig,
          persistence,
          timeline,
          ownership: {
            owner: "none",
            resumable: false,
            reason: classification.reason,
          },
        };
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
        metadata: { ...storedConfig, provider: OMP_PROVIDER, cwd: input.cwd },
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

function handleSubagentLifecycle(
  event: OmpRuntimeEvent,
  runtimeSession: PiRuntimeSession,
  emit: (event: AgentStreamEvent) => void,
  subagentIndex: OmpSubagentIndex,
  subagentSessionFilesByRuntime: WeakMap<PiRuntimeSession, Map<string, string>>,
  historicalSubagentSessionFiles: Set<string>,
  parentCwd: string,
): void {
  if (event.type !== "subagent_lifecycle") {
    return;
  }
  const payload = event.payload;
  const sessionFile = resolveSubagentSessionFile(
    runtimeSession,
    payload.id,
    payload.index,
    payload.parentToolCallId,
    payload.sessionFile,
    subagentSessionFilesByRuntime,
  );
  if (!sessionFile) {
    return;
  }

  const status = mapOmpSubagentLifecycleStatus(payload.status);
  if (isTerminalOmpSubagentStatus(status)) {
    subagentIndex.terminal(runtimeSession, sessionFile, status);
  } else {
    subagentIndex.upsert({
      sessionFile,
      subagentId: payload.id,
      status,
      parentRuntime: runtimeSession,
      title: resolveOmpSubagentTitle(sessionFile, payload.id),
      classifyRelease: async () => await classifyReleasedOmpChild(sessionFile, parentCwd),
      emitOwnership: async (entry) => {
        if (!entry.releaseClassification) {
          return;
        }
        const classification = entry.releaseClassification;
        emit({
          type: "child_session",
          provider: OMP_PROVIDER,
          childSessionId: sessionFile,
          status: entry.status === "pending" ? "running" : entry.status,
          ownership: classification.resumable
            ? { owner: "paseo", resumable: true }
            : { owner: "none", resumable: false, reason: classification.reason },
          ...(entry.title ? { title: entry.title } : {}),
        });
        for (const child of await discoverReleasedOmpHistoricalChildren(sessionFile, parentCwd)) {
          historicalSubagentSessionFiles.add(child.sessionFile);
          subagentIndex.recordHistorical(child.sessionFile);
          emit({
            type: "child_session",
            provider: OMP_PROVIDER,
            childSessionId: child.sessionFile,
            parentChildSessionId: child.parentSessionFile,
            nativeChildId: child.nativeChildId,
            status: "completed",
            ownership: {
              owner: "none",
              resumable: false,
              reason: "historical child transcripts are read-only",
            },
            title: resolveOmpSubagentTitle(child.sessionFile, child.nativeChildId),
          });
        }
      },
    });
  }
  emit({
    type: "child_session",
    provider: OMP_PROVIDER,
    childSessionId: sessionFile,
    status,
    nativeChildId: payload.id,
    parentToolCallId: payload.parentToolCallId,
    childIndex: payload.index,
    ownership: { owner: "provider" },
    title: resolveOmpSubagentTitle(sessionFile, payload.id),
  });
}

function handleSubagentProgress(
  event: OmpRuntimeEvent,
  runtimeSession: PiRuntimeSession,
  subagentIndex: OmpSubagentIndex,
  subagentSessionFilesByRuntime: WeakMap<PiRuntimeSession, Map<string, string>>,
): void {
  if (event.type !== "subagent_progress") {
    return;
  }
  const payload = event.payload;
  const sessionFile = resolveSubagentSessionFile(
    runtimeSession,
    payload.progress.id,
    payload.index,
    payload.parentToolCallId,
    payload.sessionFile,
    subagentSessionFilesByRuntime,
  );
  if (!sessionFile) {
    return;
  }
  const model = normalizeOmpResolvedModelId(payload.progress.resolvedModel);
  subagentIndex.updateProgress({
    sessionFile,
    subagentId: payload.progress.id,
    status: payload.progress.status,
    parentRuntime: runtimeSession,
    title: resolveOmpSubagentTitle(sessionFile, payload.progress.id),
    ...(model ? { model } : {}),
  });
}

const OMP_RESOLVED_MODEL_THINKING_SUFFIXES = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "auto",
  "max",
]);

function normalizeOmpResolvedModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const suffixStart = trimmed.lastIndexOf(":");
  if (suffixStart <= 0) {
    return trimmed;
  }
  const suffix = trimmed.slice(suffixStart + 1).toLowerCase();
  if (!OMP_RESOLVED_MODEL_THINKING_SUFFIXES.has(suffix)) {
    return trimmed;
  }
  const modelId = trimmed.slice(0, suffixStart).trim();
  return modelId.length > 0 ? modelId : undefined;
}

function resolveOmpSubagentTitle(sessionFile: string, fallback: string): string {
  const fileName = basename(sessionFile);
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return stem.trim() || fallback;
}

function resolveSubagentSessionFile(
  runtimeSession: PiRuntimeSession,
  subagentId: string,
  index: number,
  parentToolCallId: string | undefined,
  sessionFile: string | undefined,
  subagentSessionFilesByRuntime: WeakMap<PiRuntimeSession, Map<string, string>>,
): string | null {
  const identity = `${parentToolCallId ?? ""}\u0000${index}\u0000${subagentId}`;
  const fallbackIdentity = `\u0000${index}\u0000${subagentId}`;
  const sessionFilesById = subagentSessionFilesByRuntime.get(runtimeSession) ?? new Map();
  if (sessionFile) {
    sessionFilesById.set(identity, sessionFile);
    const previousFallback = sessionFilesById.get(fallbackIdentity);
    sessionFilesById.set(
      fallbackIdentity,
      previousFallback === undefined || previousFallback === sessionFile ? sessionFile : "",
    );
    subagentSessionFilesByRuntime.set(runtimeSession, sessionFilesById);
    return sessionFile;
  }
  return sessionFilesById.get(identity) || sessionFilesById.get(fallbackIdentity) || null;
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
