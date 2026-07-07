# D1 Extraction Inventory

Branch: `feat/pi-native-subagents`.
Scope: read-only inventory for splitting the current Pi/omp alias into shared transport/mapping core plus thin `providers/pi/` and `providers/omp/` adapters.

Primary design reference: `docs/plans/omp-integration/README.md` D1 says `omp` gets a dedicated adapter, NDJSON/spawn/id-correlation plumbing is extracted into a shared core, and the `pi` provider behavior must not change. `docs/plans/omp-integration/RUNBOOK-child-agents.md` says the current branch has already implemented omp child-session machinery inside `providers/pi/`.

## 1. File Map

Classification counts by file:

| bucket           | files |
| ---------------- | ----: |
| shared-transport |     0 |
| shared-mapping   |     0 |
| pi-only          |     3 |
| omp-only         |     4 |
| mixed            |    11 |

`shared-transport` and `shared-mapping` are zero as whole-file buckets because every candidate file currently carries Pi names, Pi constants, or omp additions. Several symbols are extraction candidates.

| file                         | lines | exports                                                                                                                                                                  | classification | notes                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.test.ts`              |  1380 | none                                                                                                                                                                     | mixed          | Pi session/client regression tests plus omp additions: poll coalescing at lines 467-527, omp system notice at 547-590, Pi extension/rewind/MCP assertions at 642-754 and 1223-1346.                                                                                        |
| `agent.ts`                   |  2241 | `PiProviderParamsSchema`, `transformPiModels`, `PiRpcAgentSession`, `PiRpcAgentClient`                                                                                   | mixed          | Large adapter class: Pi launch/extension bridge, shared event mapping, and omp child-session hooks are interleaved. Deep map below.                                                                                                                                        |
| `cli-runtime.test.ts`        |   324 | none                                                                                                                                                                     | mixed          | Pins shared NDJSON transport and Pi launch behavior; also tests command-name override (`get_available_commands`) and subagent RPC wrappers at lines 222-289.                                                                                                               |
| `cli-runtime.ts`             |   348 | `PiCliRuntimeOptions`, `PiCliRuntime`                                                                                                                                    | mixed          | Shared transport candidate: spawn, JSONL framing, request ids, response correlation, exit handling. Dialect leakage: `commandsRpcType` option at lines 53-68 and 211, plus omp-only subagent RPC wrappers at 191-208.                                                      |
| `history-mapper.test.ts`     |   310 | none                                                                                                                                                                     | mixed          | Shared Pi-lineage replay tests plus omp-only poll coalescing and system notices at lines 130-259.                                                                                                                                                                          |
| `history-mapper.ts`          |   216 | `PiCapturedUserMessageEntry`, `getUserMessageText`, `PiHistoryMapper`, `streamPiHistory`                                                                                 | mixed          | Shared mapping candidate for Pi-lineage `PiAgentMessage` to timeline. Omp-only import of `mapOmpSystemNoticeToToolCall` at line 2 and custom-message absorption at lines 179-191. Poll call id coalescing is pulled via `resolveEmittedToolCallId` at lines 9 and 104/132. |
| `omp-system-notice.test.ts`  |   109 | none                                                                                                                                                                     | omp-only       | Tests `<system-notice>` and `<task-result>` mapping.                                                                                                                                                                                                                       |
| `omp-system-notice.ts`       |   128 | `isOmpSystemNotice`, `mapOmpSystemNoticeToToolCall`                                                                                                                      | omp-only       | Parses omp harness notices and maps them to synthetic `task_notification` tool calls.                                                                                                                                                                                      |
| `rewind.ts`                  |    14 | `PiRewindNavigator`, `revertPiConversation`                                                                                                                              | pi-only        | Thin wrapper around Pi extension-based tree navigation. Omp D3 says native `branch` replaces this.                                                                                                                                                                         |
| `rpc-types.ts`               |   249 | all Pi RPC/message/session/subagent types                                                                                                                                | mixed          | Stock Pi message/session/event/command types plus omp-only subagent commands/frames at lines 115-158, 178-184, and 238-239. `PiCommandsRpcType` at line 113 is the alias seam.                                                                                             |
| `runtime.ts`                 |   137 | `PiRuntimeLaunch`, `PiStartSessionInput`, `PiRuntimeSession`, `PiSubagentMessagesSelector`, `PiRuntime`, `buildPiLaunch`                                                 | mixed          | Launch construction is Pi-specific (`--thinking`, `--extension`) but spawn-independent runtime interfaces include omp-only subagent methods at lines 50-52. `buildPiLaunch` appends `--extension` at lines 115-117, Pi-only.                                               |
| `session-descriptor.test.ts` |   172 | none                                                                                                                                                                     | pi-only        | Pins Pi JSONL import config extraction from session files. No omp layout coverage.                                                                                                                                                                                         |
| `session-descriptor.ts`      |   447 | `PiImportSessionConfig`, `listPiImportableSessions`, `readPiImportSessionConfig`                                                                                         | pi-only        | Pi import discovery: `.pi`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `session_info`, `model_change`, `thinking_level_change`. The current registry passes `~/.omp/agent/sessions`, but the parser remains Pi-shaped.                                          |
| `subagent-index.ts`          |   106 | `PiTerminalSubagentStatus`, `PiLiveSubagentEntry`, `PiSubagentIndexEvent`, `PiSubagentIndex`, `isTerminalPiSubagentStatus`                                               | omp-only       | Live subagent registry for omp lifecycle/progress, despite `Pi` names. Stock Pi lacks these frames.                                                                                                                                                                        |
| `subagents.test.ts`          |   512 | none                                                                                                                                                                     | omp-only       | Tests lifecycle/progress `child_session`, live import, virtual session transcript fetch/promotion. This is current omp child-agent behavior.                                                                                                                               |
| `test-utils/fake-pi.ts`      |   295 | `FakePi`, `FakePiSession`                                                                                                                                                | mixed          | Shared test fake for Pi runtime. Includes Pi extension marker simulation at lines 270-293 and omp subagent queues/RPCs at lines 56-58 and 188-204.                                                                                                                         |
| `tool-call-mapper.test.ts`   |    95 | none                                                                                                                                                                     | mixed          | Shared tool mapping tests plus omp-only `subagent` poll coalescing at lines 78-92.                                                                                                                                                                                         |
| `tool-call-mapper.ts`        |   500 | `PiToolResult`, `PiTrackedToolCall`, `parseToolResult`, `extractTextFromToolResult`, `parseToolArgs`, `resolveEmittedToolCallId`, `resolveToolCallName`, `mapToolDetail` | mixed          | Shared tool parsing/detail mapping. Omp-only poll coalescing lives in `readPollTargets` lines 141-160 and `resolveEmittedToolCallId` lines 309-318.                                                                                                                        |
| `virtual-child-session.ts`   |   450 | `PiVirtualChildSession`                                                                                                                                                  | omp-only       | Virtual session for live omp child session files; reads through parent RPC, buffers early events, promotes to real session after terminal lifecycle.                                                                                                                       |

Per-symbol extraction candidates:

| symbol                                                                                                                                                   | file                                                                                      | bucket                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `PiCliRuntimeSession` internals: `pending`, `stdoutBuffer`, `stderrBuffer`, `request`, `writeJsonLine`, `handleStdoutChunk`, `handleResponse`, `failAll` | `cli-runtime.ts` lines 96-348                                                             | shared-transport                                               |
| `buildPiLaunch`                                                                                                                                          | `runtime.ts` lines 74-130                                                                 | pi-only with a possible shared launch-input shape              |
| `PiRuntimeSession.prompt/getState/getMessages/...` common command wrappers                                                                               | `cli-runtime.ts` lines 121-189 and 209-217                                                | shared-transport wrapper pattern, dialect-specific command set |
| `setSubagentSubscription/getSubagents/getSubagentMessages`                                                                                               | `cli-runtime.ts` lines 191-208                                                            | omp-only                                                       |
| `getUserMessageText`, `PiHistoryMapper.mapMessages` for user/assistant/tool/bash                                                                         | `history-mapper.ts` lines 28-176                                                          | shared-mapping                                                 |
| `toCustomMessageTimelineItem` with system-notice absorption                                                                                              | `history-mapper.ts` lines 179-191                                                         | omp-only branch inside shared-mapping                          |
| `parseToolResult`, `extractTextFromToolResult`, `parseToolArgs`, `resolveToolCallName`, `mapToolDetail`                                                  | `tool-call-mapper.ts` lines 261-500                                                       | shared-mapping                                                 |
| `resolveEmittedToolCallId` poll coalescing                                                                                                               | `tool-call-mapper.ts` lines 309-318                                                       | omp-only                                                       |
| `createPiPaseoExtensionFile`, marker parser/capture methods                                                                                              | `agent.ts` lines 496-583 and 1435-1537                                                    | pi-only                                                        |
| `handleSubagentLifecycle`, `handleSubagentProgress`, `PiSubagentIndex`, `PiVirtualChildSession`                                                          | `agent.ts` lines 1618-1682 and 2109-2157, `subagent-index.ts`, `virtual-child-session.ts` | omp-only                                                       |

## 2. `agent.ts` Deep Map

Top-level imports and constants:

| lines   | block                                          | bucket                 | state/notes                                                                                                                                                                                           |
| ------- | ---------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-87    | Imports                                        | mixed                  | Imports shared SDK helpers, Pi runtime/history/tool modules, and omp-only `mapOmpSystemNoticeToToolCall`, `PiSubagentIndex`, `PiVirtualChildSession`.                                                 |
| 89-107  | Provider constants and params schema           | mixed                  | `PI_PROVIDER`, Pi binary/env, extension command/marker constants are Pi-only. `PiProviderParamsSchema.sessionDir` is used for both Pi and current omp alias; `extensionTimeoutMs` is Pi-only.         |
| 109-153 | Slash commands, capabilities, thinking options | pi-only/shared-adapter | Pi provider surface. Omp phase docs expect modes and native capabilities to diverge.                                                                                                                  |
| 155-259 | Local interfaces/types                         | mixed                  | `commandsRpcType` in `PiRpcAgentClientOptions` is current omp alias seam; `PiRpcAgentSessionOptions.subagentIndex` is omp-only; extension result/dialog types are Pi extension UI and marker capture. |

Helpers before the session class:

| lines   | block                                                                             | bucket             | state/notes                                                                                                                                                                                                                    |
| ------- | --------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 261-283 | Model label normalization and `transformPiModels`                                 | shared-ish mapping | Also imported by ACP tests. It maps Pi/OpenRouter style model labels, not transport.                                                                                                                                           |
| 285-404 | Thinking, autocompact, usage, prompt conversion, model refs, persistence metadata | mixed              | Mostly shared Pi-lineage adapter helpers; `parseAutoCompactMode` and `toAgentUsage` can be shared if omp state/stats shapes remain compatible.                                                                                 |
| 421-491 | MCP config file helpers                                                           | pi-only            | Detects/injects `pi-mcp-adapter` through Pi extension command list. Omp Phase 1 says `--mcp-config` should be native/unconditional.                                                                                            |
| 496-583 | `createPiPaseoExtensionFile` generated `.mjs`                                     | pi-only            | Injected via `--extension`; emits `PASEO_ENTRY_CAPTURE` and `PASEO_COMMAND_RESULT`; registers `paseo_capture_entries` and `paseo_tree`. D3 explicitly kills this for omp.                                                      |
| 586-619 | cleanup, MCP command detection/capability, abort-error helper                     | pi-only/mixed      | MCP detection is Pi extension specific. Abort helper may be shared.                                                                                                                                                            |
| 621-979 | Error formatting, marker payload parsing, permission UI mapping                   | mixed              | Error/message helpers shared; `parseExtensionMarkerPayload` and captured entries are Pi-only. `extension_ui_request` permission mapping may be shared for Pi/omp RPC UI, but omp Phase 2 expects different request vocabulary. |
| 981-993 | `createRuntime`, lifecycle status mapper                                          | mixed              | `commandsRpcType` threads current omp alias into Pi runtime. `mapPiSubagentLifecycleStatus` is omp-only despite Pi naming.                                                                                                     |

`PiRpcAgentSession` fields and constructor:

| lines     | block              | bucket | private state                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 996-1019  | Field declarations | mixed  | Shared/session: `subscribers`, `activeToolCalls`, `activeTurnId`, `lastKnownThinkingOptionId`, `state`, `closed`. Pi-only: `pendingExtensionUiRequests`, `activeAskUserDialog`, `pendingCombinedAskUserResponse`, `capturedUserEntries`, `capturedUserEntriesById`, `seenUserEntryIds`, `pendingUserMessages`, `pendingExtensionResults`, `extensionTimeoutMs`. Omp-only: `subagentSessionFilesById`, `subagentIndex`. Out-of-band compaction fields are Pi feature plumbing. |
| 1020-1040 | Constructor        | mixed  | Wires runtime events (shared); calls `runtimeSession.setSubagentSubscription("progress")` best-effort (omp-only) at lines 1037-1039. Depends on `runtimeSession`, `subagentIndex`, `logger`.                                                                                                                                                                                                                                                                                  |
| 1042-1047 | Readonly fields    | mixed  | `runtimeSession`, `config`, `logger`, `cleanup` shared; `subagentIndex` omp-only; `extensionTimeoutMs` Pi-only.                                                                                                                                                                                                                                                                                                                                                               |

`PiRpcAgentSession` public methods:

| lines     | method/block                | bucket                            | dependencies                                                                                                                                                                                             |
| --------- | --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1049-1051 | `id`                        | shared session plumbing           | `state.sessionId`.                                                                                                                                                                                       |
| 1053-1063 | `run`                       | shared session plumbing           | `runProviderTurn`, `startTurn`, `subscribe`, timeline assistant reduction.                                                                                                                               |
| 1065-1095 | `startTurn`                 | shared transport/session plumbing | `activeTurnId`, `runtimeSession.prompt`, abort/error mapping, `emit`.                                                                                                                                    |
| 1097-1102 | `subscribe`                 | shared session plumbing           | `subscribers`.                                                                                                                                                                                           |
| 1104-1111 | `streamHistory`             | mixed                             | Pi-only `requestEntryCapture` before shared `streamPiHistory`; depends on captured entry state. Omp should not use extension capture.                                                                    |
| 1113-1125 | `getRuntimeInfo`            | shared mapping/session            | `refreshState`, `modelToId`, thinking state.                                                                                                                                                             |
| 1127-1138 | mode methods                | pi-only current behavior          | Always no modes / throws. Omp should diverge.                                                                                                                                                            |
| 1140-1168 | permission methods          | mixed                             | Extension UI permission bridge; may be shared only if omp RPC UI shape matches. Depends on `pendingExtensionUiRequests`, `pendingCombinedAskUserResponse`, `runtimeSession.respondToExtensionUiRequest`. |
| 1170-1180 | `describePersistence`       | shared-ish                        | Uses provider `"pi"` and `state.sessionFile`; compatible with current alias but wrong for future first-class `omp` provider unless provider id is injected.                                              |
| 1183-1185 | `interrupt`                 | shared transport/session          | `runtimeSession.abort`.                                                                                                                                                                                  |
| 1187-1206 | `revertConversation`        | pi-only                           | Extension capture + `revertPiConversation` + `paseo_tree`; depends on captured entries and `currentLeafOverrideId`.                                                                                      |
| 1208-1214 | `runPiTreeExtensionCommand` | pi-only                           | Sends slash command to injected extension and waits for marker result.                                                                                                                                   |
| 1216-1228 | `close`                     | mixed                             | Shared close/cleanup plus omp-only `subagentIndex.clearParent`; Pi-only reject extension results.                                                                                                        |
| 1230-1245 | `listCommands`              | mixed                             | Shared command mapping; command RPC name is in runtime config.                                                                                                                                           |
| 1247-1273 | `tryHandleOutOfBand`        | shared/Pi feature                 | `/compact` and `/autocompact` built-ins; not transport.                                                                                                                                                  |
| 1275-1301 | model/thinking setters      | shared Pi-lineage                 | `runtimeSession.setModel`, `setThinkingLevel`; provider/model id semantics may differ for omp.                                                                                                           |

`PiRpcAgentSession` private methods:

| lines     | method/block                                           | bucket                                  | dependencies                                                                                                                                           |
| --------- | ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1303-1323 | `emit`, `currentTurnIdForEvent`, slash parser          | shared session plumbing                 | `subscribers`, `activeTurnId`.                                                                                                                         |
| 1330-1433 | compact/autocompact command execution                  | shared feature mapping                  | `runtimeSession.compact`, `setAutoCompaction`, compaction state fields.                                                                                |
| 1435-1537 | entry capture and extension-result marker handling     | pi-only                                 | `pendingExtensionResults`, `capturedUserEntries*`, `seenUserEntryIds`, `pendingUserMessages`; parses `PASEO_ENTRY_CAPTURE` and `PASEO_COMMAND_RESULT`. |
| 1547-1607 | `extension_ui_request` handling and ask_user follow-up | mixed                                   | Pi RPC UI bridge plus marker swallowing. Depends on permission maps and active ask-user state.                                                         |
| 1609-1627 | `handleRuntimeEvent` dispatcher                        | mixed                                   | Shared dispatch plus omp-only `subagent_lifecycle`/`subagent_progress`, Pi/possibly shared `extension_ui_request`, process exit.                       |
| 1629-1682 | subagent lifecycle/progress/session-file resolution    | omp-only                                | `subagentIndex`, `subagentSessionFilesById`, `runtimeSession`; emits internal `child_session`.                                                         |
| 1685-1698 | process exit handling                                  | mixed                                   | Shared process failure; omp-only clears parent subagents; Pi-only rejects extension results.                                                           |
| 1701-1786 | session event mapping                                  | shared-mapping with Pi feature branches | Maps agent/turn/message/tool/compaction/agent_end. Depends on active tool calls, active ask-user, compaction helpers.                                  |
| 1788-1817 | compaction timeline                                    | shared feature mapping                  | Uses out-of-band compaction state.                                                                                                                     |
| 1819-1848 | assistant message updates                              | shared-mapping                          | Text and thinking deltas.                                                                                                                              |
| 1851-1889 | message end handling                                   | mixed                                   | Omp-only custom-message notice absorption at 1853-1874; Pi-only user-message entry capture at 1880-1889.                                               |
| 1898-1922 | tool-call event emission                               | mixed                                   | Shared tool mapping plus omp-only `resolveEmittedToolCallId` call at 1907.                                                                             |
| 1924-1962 | turn completion and state/usage refresh                | shared session/mapping                  | `latestPiErrorMessage`, `refreshState`, `getSessionStats`.                                                                                             |

`PiRpcAgentClient`:

| lines     | method/block                       | bucket                     | dependencies                                                                                                                                                               |
| --------- | ---------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1965-1982 | fields/constructor                 | mixed                      | Shared client fields plus omp-only `subagentIndex`; current alias enters through `commandsRpcType`.                                                                        |
| 1984-2037 | `createSession`                    | pi-only/mixed              | Always creates and injects Pi extension file (`--extension`), prepares Pi MCP adapter, builds `PiRpcAgentSession` with subagent index. Omp D3 says no extension injection. |
| 2039-2080 | `resumeSession`                    | pi-only/mixed              | Same extension injection and Pi provider metadata.                                                                                                                         |
| 2082-2094 | `fetchCatalog`                     | shared-ish                 | Short-lived runtime, `getAvailableModels`, `transformPiModels`; provider id remains Pi.                                                                                    |
| 2096-2098 | `listFeatures`                     | pi-only current behavior   | Empty.                                                                                                                                                                     |
| 2100-2107 | `listImportableSessions`           | pi-only current scanner    | Uses `listPiImportableSessions` and `providerParams.sessionDir`.                                                                                                           |
| 2109-2157 | `importSession` live-subagent path | omp-only                   | Uses `subagentIndex`, `getSubagentMessages`, and `PiVirtualChildSession`.                                                                                                  |
| 2159-2166 | `importSession` normal path        | pi-only/shared import flow | Reads Pi import config and resumes.                                                                                                                                        |
| 2168-2202 | availability/diagnostic            | pi-only                    | Pi binary/auth path `~/.pi/agent/auth.json`; current omp alias gets misleading Pi diagnostic if used directly.                                                             |
| 2204-2233 | MCP adapter prep/probe             | pi-only                    | Starts a Pi session to look for `pi-mcp-adapter`; omp should not inherit this.                                                                                             |
| 2235-2240 | launch resolution                  | pi-only                    | Uses `PI_BINARY_COMMAND`. Current omp alias bypasses through runtime settings.                                                                                             |

Splitting implication: inheritance is risky because private fields are not grouped by concern. A composition split is cleaner: shared RPC process core, shared event/tool mapper object with per-dialect hooks, and two adapter classes that own provider id, launch flags, persistence, rewind, and child-session policy.

## 3. External Consumers

Code outside `providers/pi/` imports these exact symbols:

| consumer                                                                        | import                                                   | use                                                                                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/server/src/server/agent/provider-registry.ts:38`                      | `PiRpcAgentClient` from `./providers/pi/agent.js`        | Registers both `pi` and current `omp` factories.                                                             |
| `packages/server/src/server/agent/provider-registry.test.ts:211`                | mocked `PiRpcAgentClient` module                         | Asserts the `omp` factory is backed by the Pi adapter with `argv: ["omp"]`, params, and `commandsRpcType`.   |
| `packages/server/src/server/daemon-e2e/real-provider-test-config.ts:12`         | `PiRpcAgentClient` from `../agent/providers/pi/agent.js` | Creates real `pi` e2e client and checks `pi` binary availability. `realProviders` excludes `omp` at line 15. |
| `packages/server/src/server/agent/providers/acp-agent.test.ts:45`               | `transformPiModels` from `./pi/agent.js`                 | Reuses model-label normalization in ACP model transformer tests.                                             |
| `packages/server/src/server/agent/providers/provider-windows-launch.test.ts:10` | `PiCliRuntime` from `./pi/cli-runtime.js`                | Windows launch parity fixture for Pi runtime command invocation.                                             |

Full current `pi` and `omp` registry factories (`provider-registry.ts:140-162`):

```ts
  pi: (logger, runtimeSettings, options) =>
    new PiRpcAgentClient({
      logger,
      runtimeSettings,
      providerParams: options?.providerParams,
    }),
  omp: (logger, runtimeSettings, options) =>
    new PiRpcAgentClient({
      logger,
      runtimeSettings: mergeRuntimeSettings(
        {
          command: {
            mode: "replace",
            argv: ["omp"],
          },
        },
        runtimeSettings,
      ),
      providerParams: options?.providerParams ?? {
        sessionDir: "~/.omp/agent/sessions",
      },
      commandsRpcType: "get_available_commands",
    }),
```

Registry tests pin this alias at `provider-registry.test.ts:511-529` and override behavior at `provider-registry.test.ts:563-586`.

## 4. RPC Dialect Delta

From `rpc-types.ts`:

Stock Pi / shared Pi-lineage shapes:

- Thinking levels: `PiThinkingLevel` at line 1.
- Image/text/thinking/tool-call content and `PiAgentMessage` roles: lines 3-60. Note `role: "custom"` at lines 34-37 is currently used for both Pi extension command output and omp system notices.
- Model/state/stats/commands: lines 63-113.
- Core commands: `prompt`, `compact`, `set_auto_compaction`, `abort`, `get_state`, `get_messages`, `get_available_models`, `set_model`, `set_thinking_level`, `get_session_stats`, and `PiCommandsRpcType` at lines 166-177.
- Core session events: `agent_start`, `turn_start`, `message_*`, `tool_execution_*`, `compaction_*`, `agent_end` at lines 197-234.
- `extension_ui_request` and `process_exit` frames at lines 241-248.

Current omp-only additions living in Pi types:

- `PiSubagentSubscriptionLevel`, `PiSubagentStatus`, `PiSubagentSnapshot`, `PiSubagentLifecyclePayload`, `PiSubagentProgressPayload`, `PiSubagentMessagesResult`: lines 115-164.
- Commands `set_subagent_subscription`, `get_subagents`, `get_subagent_messages`: lines 178-184.
- Frames `subagent_lifecycle`, `subagent_progress`: lines 238-239.

Missing from current types compared with the design docs:

- No `subagent_event` frame despite README/opening context naming it.
- No `steer`, `follow_up`, `abort_and_prompt`, `switch_session`, `branch`, `get_branch_messages`, `set_session_name`, `new_session`, `set_todos`, host tools/URIs, or `rpc-ui` approval card command/frame coverage.
- No native omp `available_commands_update`, `prompt_result`, `session_info_update`, or title/mode/todo shapes.

From `cli-runtime.ts`:

- Default command is `pi` from `PI_COMMAND`/`PI_ACP_PI_COMMAND`, line 31.
- Default commands RPC is `get_commands`, line 34.
- `commandsRpcType` is a constructor option, stored at lines 57 and 63-68, passed to each session at lines 88-93, and used only in `getCommands()` at line 211.
- Omp alias sets `commandsRpcType: "get_available_commands"` in `provider-registry.ts:161`.
- Subagent command wrappers are unconditional on the runtime session interface at lines 191-208. For stock Pi, the constructor best-effort subscription in `agent.ts:1037-1039` logs debug on failure.

Other provider identity / params branches today:

- Registry makes `omp` a `PiRpcAgentClient` with `runtimeSettings.command.argv = ["omp"]`, default `providerParams.sessionDir = "~/.omp/agent/sessions"`, and `commandsRpcType = "get_available_commands"` (`provider-registry.ts:146-162`).
- `PiProviderParamsSchema` accepts only `sessionDir` and `extensionTimeoutMs` (`agent.ts:103-107`). `sessionDir` is used by both Pi and current omp alias; `extensionTimeoutMs` only matters for Pi extension markers.
- `PiRpcAgentClient.provider` is always `PI_PROVIDER` (`"pi"`) at `agent.ts:1966`. The registry wrapper appears to rewrite provider identity for custom/derived providers elsewhere, but the direct class and persistence descriptions are Pi-literal.

## 5. Test Inventory

Provider-local tests:

| file                                      | pins     | notes                                                                                                                                                                                                                 |
| ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/pi/agent.test.ts`              | mixed    | Pi regression gate for launch env, extension UI bridge, run/stream mapping, resume/import, model/thinking, compact/autocompact, rewind, MCP extension. Also pins omp poll coalescing and system notices.              |
| `providers/pi/cli-runtime.test.ts`        | mixed    | Pi regression gate for JSONL transport, request/response, launch flags, timeouts, exit handling, Windows-sensitive spawn shape indirectly. Omp-specific tests for `get_available_commands` and subagent RPC wrappers. |
| `providers/pi/history-mapper.test.ts`     | mixed    | Shared mapping regression; includes omp poll coalescing and omp system-notice custom messages.                                                                                                                        |
| `providers/pi/omp-system-notice.test.ts`  | omp-only | Omp notice parser and synthetic tool-call mapping.                                                                                                                                                                    |
| `providers/pi/session-descriptor.test.ts` | pi-only  | Pi session import config extraction.                                                                                                                                                                                  |
| `providers/pi/subagents.test.ts`          | omp-only | Current omp child-session lifecycle/progress/import/virtual session behavior.                                                                                                                                         |
| `providers/pi/tool-call-mapper.test.ts`   | mixed    | Shared tool detail mapping; omp-only stable `omp-poll:*` ids.                                                                                                                                                         |

External tests with direct `providers/pi` imports:

| file                                                | pins                 | notes                                                                                           |
| --------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `provider-registry.test.ts`                         | mixed                | Pins `omp` as Pi adapter alias; must change when `OmpRpcAgentClient` exists.                    |
| `daemon-e2e/real-provider-test-config.ts` consumers | pi-only              | Real provider e2e config includes `pi` only and constructs `PiRpcAgentClient`.                  |
| `providers/provider-windows-launch.test.ts`         | pi transport/launch  | Imports `PiCliRuntime`; should move to shared transport or Pi launch test depending extraction. |
| `providers/acp-agent.test.ts`                       | shared model mapping | Imports `transformPiModels`. If moved, preserve export or update ACP test.                      |

Other tests exercising Pi/omp semantics without importing `providers/pi`:

- `agent/agent-manager-child-session.test.ts:262-388`: pins the internal `child_session` manager seam used by current omp subagent import. This is a regression gate for the current child-session behavior, not stock Pi.
- `daemon-e2e/pi.real.e2e.test.ts`: real Pi regression gate for compact/autocompact, bash/read/write/edit tool calls, reasoning, persistence/resume, history, models, runtime info, and feature listing.
- `daemon-e2e/pi-rewind.real.e2e.test.ts`: real Pi regression gate for extension-bridge rewind.
- `daemon-e2e/user-message-contract.real.e2e.test.ts:51-54`: includes Pi in user-message contract real e2e.
- `agent/provider-snapshot-manager.test.ts`, `agent/provider-launch-config.test.ts`, `persisted-config.ts` tests/reference lists include both `pi` and `omp`; not adapter behavior, but registry/provider identity can break them.
- `agent/agent-manager.test.ts:6317-6331`: has an `omp` persisted-agent listing case with `derivedFromProviderId: "pi"`.

Recommended Pi regression gate for the refactor:

- Unit: `packages/server/src/server/agent/providers/pi/cli-runtime.test.ts`, `agent.test.ts`, `history-mapper.test.ts`, `tool-call-mapper.test.ts`, `session-descriptor.test.ts`.
- Launch/import external: `packages/server/src/server/agent/providers/provider-windows-launch.test.ts` on Windows CI, `provider-registry.test.ts` after expected registry changes.
- Real e2e via CI, not local: `packages/server/src/server/daemon-e2e/pi.real.e2e.test.ts`, `pi-rewind.real.e2e.test.ts`, `user-message-contract.real.e2e.test.ts`.
- Omp extraction gate after split: current `subagents.test.ts`, `omp-system-notice.test.ts`, omp-specific cases from `history-mapper.test.ts`, `tool-call-mapper.test.ts`, `cli-runtime.test.ts`, plus `agent-manager-child-session.test.ts`.

No tests were run during this inventory.

## 6. Risks And Plan Contradictions

Extraction risks:

1. Private state in `PiRpcAgentSession` is tightly coupled across concerns. `handleMessageEnd` needs both omp notice absorption and Pi user-entry capture; `handleRuntimeEvent` mixes shared session events with omp frames; `close` and process exit mix runtime cleanup, subagent cleanup, and extension-result rejection. A subclass split would need access to many private fields or duplicate event mapping.
2. `PiRuntimeSession` already includes omp-only subagent methods. If a shared core exports this interface as-is, the Pi adapter keeps depending on omp RPCs. The core should expose generic request/fire-and-forget/event primitives, with per-dialect wrapper interfaces above it.
3. Provider id is hard-coded as `"pi"` in session/client/persistence/timeline events. The current registry test expects `registry.omp.createClient(logger).provider` to be `"omp"` while the raw `PiRpcAgentClient` class says `"pi"` (`agent.ts:1966`); the registry wrapping path needs careful verification during split.
4. The injected extension bridge is created unconditionally for `createSession`, `resumeSession`, and normal imports (`agent.ts:1989`, `2043`). Any shared session code that calls `streamHistory` or `revertConversation` cannot be reused by omp without pulling the bridge back in.
5. Shared mapping is contaminated by omp-specific call-id and notice behavior. Moving `history-mapper.ts` wholesale would preserve omp behavior but change the meaning of "Pi shared mapper"; moving it without hooks would regress current branch tests.
6. Session discovery is Pi-shaped but currently used for the omp alias by overriding only `sessionDir`. The phase doc says omp has per-cwd encoded dirs, `PI_CONFIG_DIR`, and XDG cases; this code does not implement them.
7. `commandsRpcType` solves only one dialect delta. The design docs list many commands/frames missing from the current runtime and type union, so a config flag is not a sufficient seam.
8. `subagent_lifecycle` terminal frames may omit `sessionFile`; current code resolves through `subagentSessionFilesById` (`agent.ts:1674-1682`). Moving lifecycle handling must preserve this memory.
9. `PiVirtualChildSession` advances byte cursors and buffers early events. Its correctness depends on `PiSubagentIndex` event timing and `AgentManager` import timing; moving it to `providers/omp/` should keep this pair together.
10. Circular dependency hazard: a shared mapper importing `omp-system-notice` or `subagent-index` would invert the intended adapter dependency. The shared core should not import either provider adapter.

Plan/doc contradictions or stale statements:

- `README.md` says `providers/pi/rpc-types.ts` has zero references to omp primitives. Current code has subagent subscription/status/snapshot/lifecycle/progress/message types and commands in `rpc-types.ts:115-184` and frames at `238-239`.
- `README.md` says everything beyond stock Pi is silently dropped. Current code consumes `subagent_lifecycle`, `subagent_progress`, `get_subagent_messages`, system notices, and poll coalescing.
- `01-adapter-foundation.md` says Phase 1 should create a separate `providers/omp/` and copy/diverge from `providers/pi/agent.ts`. Current runbook says child agents are already implemented inside the Pi provider on this branch.
- `03-child-agents.md` proposes a reporter/lock-label daemon seam and app gating. `RUNBOOK-child-agents.md` supersedes it: zero app changes and zero wire changes, using internal `child_session` stream events plus import-session path.
- `01-adapter-foundation.md` says the shared core should wait for `{"type":"ready"}`. Current `PiCliRuntimeSession` does not have an explicit ready gate; it starts listening immediately and request calls can be issued after construction.
- `01-adapter-foundation.md` says omp session import should handle `PI_CONFIG_DIR` and XDG redirection. Current `session-descriptor.ts` handles `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, settings `sessionDir`, and direct `sessionDir` override only.
- `open-questions.md` has pending answers for subagent session-file import filtering and RPC-mode task/todo defaults. Current branch already imports live subagent session files and does not filter terminal historical subagent files from `listPiImportableSessions`.

## Commands Run

Read-only/search commands plus one directory creation and this report write:

- `sed -n '1,240p' docs/plans/omp-integration/README.md`
- `find packages/server/src/server/agent/providers/pi -type f | sort`
- `ls -la docs/plans/omp-integration && find docs/plans/omp-integration -maxdepth 2 -type f | sort`
- `find docs -maxdepth 1 -type f -printf '%f\n' | sort`
- `sed -n '1,260p' docs/plans/omp-integration/01-adapter-foundation.md`
- `sed -n '1,260p' docs/plans/omp-integration/RUNBOOK-child-agents.md`
- `wc -l packages/server/src/server/agent/providers/pi/* packages/server/src/server/agent/providers/pi/test-utils/*`
- `rg -n "^export |export \\{|export type|export interface|export class|export function|export const|export enum" packages/server/src/server/agent/providers/pi`
- `rg -n "providers/pi/" packages/server packages/protocol packages/app packages/cli packages/desktop packages/relay docs -g'!*node_modules*'`
- `sed -n '1,260p' packages/server/src/server/agent/provider-registry.ts`
- `rg -n "class PiRpcAgentSession|class PiRpcAgentClient|private |protected |public |async |^[[:space:]]{2}(constructor|[a-zA-Z0-9_]+\\()" packages/server/src/server/agent/providers/pi/agent.ts`
- `sed -n` ranges for `agent.ts`, `cli-runtime.ts`, `rpc-types.ts`, `runtime.ts`, `history-mapper.ts`, `tool-call-mapper.ts`, `session-descriptor.ts`, `subagent-index.ts`, `virtual-child-session.ts`, `omp-system-notice.ts`, `fake-pi.ts`, selected tests, and external consumers.
- `find packages/server/src/server -type f \\( -name '*test.ts' -o -name '*spec.ts' \\) | sort | rg 'pi|omp|provider-registry|daemon-e2e|agent-manager-child'`
- `rg -n "\\b(pi|omp|PiRpc|subagent|child_session|get_subagent|PASEO_ENTRY_CAPTURE|PASEO_COMMAND_RESULT|commandsRpcType)\\b" packages/server/src/server -g'*.test.ts' -g'*.ts'`
- `rg -n "from ['\\\"](\\.\\.?/)+pi/|from ['\\\"].*providers/pi/|import\\(['\\\"].*providers/pi/" packages/server/src/server -g'*.ts'`
- `rg -n "providers/pi/|\\.\\/pi\\/|\\.\\.\\/agent\\/providers\\/pi\\/|\\.\\.\\/providers\\/pi\\/" packages/server/src/server -g'*.ts'`
- `sed -n '1,240p' docs/plans/omp-integration/03-child-agents.md`
- `sed -n '1,220p' docs/plans/omp-integration/open-questions.md`
- `rg -n "subagent_lifecycle|subagent_progress|get_subagent|set_subagent|child_session|mapOmpSystemNotice|resolveEmittedToolCallId|PASEO_ENTRY_CAPTURE|PASEO_COMMAND_RESULT|createPiPaseoExtensionFile|commandsRpcType|providerParams|sessionDir" packages/server/src/server/agent/providers/pi packages/server/src/server/agent/provider-registry.ts`
- `mkdir -p docs/plans/omp-integration/recon`
