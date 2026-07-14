# Phase 2 — v1 parity with Claude and the best-integrated providers

Goal: an omp agent pane feels exactly as complete as a Claude agent pane. Entirely
adapter-scoped (`providers/omp/`). Every row below maps an omp primitive onto a Paseo surface
that already exists in the protocol and app — no new UI concepts.

## 1. Subagents, inline (`sub_agent` tool detail)

The v1 subagent story: omp `task` tool calls render like Claude Task sidechains via the
existing `ToolCallDetail{type:"sub_agent"}` (`agent-sdk-types.ts`; display in
`packages/protocol/src/tool-call-display.ts`, `packages/app/src/components/tool-call-details.tsx`).

Adapter work (`providers/omp/subagents.ts`):

- On session start, send `set_subagent_subscription {level:"progress"}` (v1 needs progress,
  not full nested event streams — those are Phase 3).
- Consume frames (`oh-my-pi/.../rpc-types.ts`):
  - `subagent_lifecycle` → `SubagentLifecyclePayload {id, agent, agentSource, description?,
status: started|completed|failed|aborted, sessionFile?, parentToolCallId?, index,
detached?}`
  - `subagent_progress` → `SubagentProgressPayload {index, agent, task, parentToolCallId?,
assignment?, progress: AgentProgress, ...}` where `AgentProgress` carries status,
    currentTool, recentTools, recentOutput, toolCount, tokens, contextTokens/contextWindow,
    cost, durationMs, resolvedModel.
- Key by `parentToolCallId` to fold into the owning `task` tool call's detail:
  `subAgentType` = agent definition name, `description` = task description, `log` = rolling
  recentOutput/currentTool lines (mirror `ClaudeSidechainTracker`'s rolling-log approach in
  `providers/claude/sidechain-tracker.ts` — read it before writing this), `childSessionId` =
  `sessionFile`.
- **Batch tasks** (`task.batch`): one lifecycle/progress stream per item under a single
  `parentToolCallId`. Render one card per item (index-suffixed) — check what the display layer
  does with multiple `sub_agent` details on one call; if it only supports one, aggregate into
  one card with per-item sections. Do not extend the protocol type in v1.
- Emit re-renders on progress at a throttled cadence (progress frames can be chatty; coalesce
  to ≤ ~2 updates/sec per tool call, same spirit as terminal coalescing invariants).

## 2. Todos

omp: `todo` tool + `todoPhases` in `get_state` + `todo_reminder` / `todo_auto_clear` session
events. Paseo: `AgentTimelineItem{type:"todo", items[]}` — already rendered for Claude.

- Map omp `TodoPhase`/`TodoItem` (statuses `pending|in_progress|completed|abandoned`) onto the
  Paseo todo item shape. Statuses align nearly 1:1; map `abandoned` to whatever the protocol's
  closest status is without widening the enum (protocol contract: no narrowing/new required
  fields; if a new status value is genuinely needed it must be additive-optional and gated).
- Emit a todo timeline item whenever the phases change: on `tool_execution_end` of the `todo`
  tool and on `todo_reminder`/`todo_auto_clear` events; hydrate initial state from
  `get_state.todoPhases` on resume.
- Verify RPC-mode settings reset leaves the todo tool enabled (open-questions #1).

## 3. Real tool approvals (`--mode rpc-ui`)

Today the Pi adapter maps `extension_ui_request` dialogs to **question** permissions only.
For omp, launch with `--mode rpc-ui` so tool approval cards arrive as structured
`extension_ui_request` frames, and upgrade the bridge:

- Tool-approval requests → Paseo **tool** permission requests (`AgentPermissionRequest`) with
  the tool name/args attached so the app renders command/diff context — the Claude-style
  approve/deny experience.
- Keep the existing select/input/editor/confirm dialog bridge (port from Pi's
  `handleExtensionUiRequest`, including the `ask_user` chained select+comment handling
  documented in `docs/providers.md`).
- Responses via `extension_ui_response` (`{value}` / `{confirmed}` / `{cancelled, timedOut?}`),
  fire-and-forget as today.
- Interaction with modes: in `yolo`/`write` modes most approvals never fire; `always-ask` is
  the ask-mode e2e config.
- **Pin down the exact rpc-ui request vocabulary against a live pinned omp before writing the
  mapper** (open-questions #2). The mapping table becomes a unit-tested pure function
  (`rpc-ui-permission-mapper.ts` + fixture JSON captured from a real session).

## 4. Plan mode

omp has a real plan-mode subsystem (plan model role, plan protection, plan handoff). v1 scope:

- Add a `plan` mode to the manifest (`colorTier: "planning"`) that launches with omp's plan
  flag/settings.
- Map plan approval to Paseo's `kind:"plan"` permission if it surfaces as a distinct rpc-ui
  request; otherwise it arrives as a confirm dialog and ships as that (still functional),
  with the upgrade noted in open-questions #2.

## 5. Tool-call mapper coverage

`providers/omp/tool-call-mapper.ts`, starting from Pi's mapper:

| omp tool                                  | Detail type               | Notes                                                                                                               |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| bash                                      | `shell`                   | command/output/exitCode; background bash flag in args if present                                                    |
| read / ls / find / grep                   | `read`/`ls`/`find`/`grep` | Pi mappings carry over; omp's Rust-native variants keep the same tool names at the RPC boundary — verify args shape |
| edit (hashline) / write                   | `edit` / `write`          | unified diff from `result.details.diff` as in Pi; verify hashline result shape                                      |
| todo                                      | (handled in §2)           | suppress the raw card, emit todo timeline item                                                                      |
| task                                      | `sub_agent` (§1)          |                                                                                                                     |
| MCP tools                                 | `mcp`                     | as Pi                                                                                                               |
| lsp / dap / eval kernels / browser-collab | `unknown` fallback        | render name+args JSON; dedicated details are post-v1 if ever                                                        |

Rule: never fail a turn on an unmappable tool; fall back to `unknown`.

## 6. Thinking levels

`set_thinking_level` with omp's ladder `off|minimal|low|medium|high|xhigh`. Pi plumbing exists;
extend the option list and gate per-model on `model.reasoning` from `get_available_models`.

## 7. Usage and context window

- After each turn: `get_session_stats` → `AgentUsage` (as Pi).
- Additionally read `get_state.contextUsage {tokens, contextWindow, percent}` for context-fill
  reporting so the pane's context meter matches omp's own.

## 8. Session titles

RPC mode disables omp's auto-titling. Two options, prefer (a):
(a) enable omp's title emission for RPC if the documented env flag works headlessly
(`PI_RPC_EMIT_TITLE`), consuming `session_info_update` frames → session title updates;
(b) let Paseo's existing title generation run and push it down via `set_session_name` so the
native session file carries the same title (keeps terminal `omp --resume` lists readable).
Doing (b) unconditionally is cheap and correct even alongside (a).

## 9. MCP servers — unconditional

Pi gates `supportsMcpServers` on detecting the `pi-mcp-adapter` extension. omp has a full MCP
client built in. The omp adapter:

- Sets `supportsMcpServers: true` unconditionally; deletes the adapter-detection probe.
- Writes the per-agent MCP config and passes `--mcp-config` (never mutating user/project MCP
  files), including the Paseo `/mcp/agents` injection — with `auth: false` for the local HTTP
  endpoint as documented in `docs/providers.md`.
- Consequence worth stating in release notes: omp agents can call `create_agent` /
  `send_agent_prompt` etc. from day one, i.e. they can orchestrate **real Paseo agents**
  (which populate the subagents track as genuine subagents) in addition to their native task
  tool. The system-prompt context Paseo appends should disambiguate: _task tool = fast
  in-process helpers; Paseo create_agent = independent, user-visible agents._

## 10. Slash commands

`get_available_commands` at session start (already the alias behavior) plus live
`available_commands_update` frame handling → `listCommands` cache invalidation. `/compact` and
`/autocompact` stay out-of-band handled (`tryHandleOutOfBand`) mapped to RPC `compact` /
`set_auto_compaction`; add `handoff` as an out-of-band command mapped to RPC `handoff`.

## Testing

- Unit: rpc-types Zod round-trips against fixture frames captured from a real pinned omp
  session (commit fixtures under `providers/omp/__fixtures__/`).
- Unit: tool-call mapper, rpc-ui permission mapper, todo mapper, subagent card folding —
  pure-function tests.
- E2E (`daemon-e2e/agent-configs.ts`): full=`yolo`, ask=`always-ask`; standard provider e2e
  matrix (prompt, permission, interrupt, resume, import). Runs in CI only when `omp` binary
  is present (`isProviderAvailable`).
- Manual: `paseo run --provider omp`, drive a task-tool fan-out, verify cards/todos/approvals
  on web + iOS.
