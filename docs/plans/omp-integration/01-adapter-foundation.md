# Phase 1 — Adapter foundation

Goal: a dedicated `OmpRpcAgentClient` that speaks omp's RPC dialect natively, shares transport
plumbing with the Pi adapter, and drops the injected-extension hack. No core daemon changes.

## 1. Extract the shared RPC transport core

**New:** `packages/server/src/server/agent/providers/pi-rpc-core/` (name TBD; it is the shared
lineage transport, not a public concept).

Move from `providers/pi/cli-runtime.ts` the parts that are protocol-family, not dialect:

- Process spawn (`spawnProcess`, stdio pipes), tree-kill shutdown (`terminateWithTreeKill`),
  managed-process bookkeeping.
- NDJSON framing: stdin write, stdout line-split/parse, stderr capture.
- Request/response correlation: incrementing `req_N` ids, per-request timeout (default 30s,
  catalog 120s), matching on `id` **never on emission order** (omp docs explicitly do not
  guarantee ordering across concurrent commands).
- The `ready` handshake: omp writes `{"type":"ready"}` before processing; Pi's runtime has the
  equivalent startup gate. Core waits for ready before resolving launch.
- Fire-and-forget sends (used by `extension_ui_response`).

What stays per-adapter: the command/response/frame type unions, launch flag construction, event
handling, capability flags, session descriptors, mappers.

**Regression gate:** the `pi` provider must be behaviorally unchanged. Its unit tests
(`cli-runtime.test.ts`, `agent.test.ts`, `session-descriptor.test.ts`, etc.) and e2e config keep
passing without modification. Do the extraction as a pure refactor PR before any omp work.

## 2. Create the omp adapter

**New:** `packages/server/src/server/agent/providers/omp/`

```
omp/
  agent.ts              # OmpRpcAgentClient / OmpRpcAgentSession
  rpc-types.ts          # omp command/response/frame unions (Zod)
  launch.ts             # argv construction
  tool-call-mapper.ts   # Phase 2
  history-mapper.ts     # session JSONL → timeline (extends Pi lineage entries)
  session-descriptor.ts # import discovery for ~/.omp layout
  subagents.ts          # Phase 2 (inline) / Phase 3 (child agents)
```

Start `agent.ts` as a copy-and-diverge of `providers/pi/agent.ts` sitting on the shared core.
Do not try to share the session class between pi and omp — the dialects diverge everywhere it
matters and a parameterized union of both is the complexity we are escaping.

### rpc-types.ts — the dialect

Mirror (with Zod, parse-don't-trust) the subset of
`oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts` we consume. Phase 1 needs:

- Commands: `prompt` (with `images`, `streamingBehavior`), `steer`, `follow_up`, `abort`,
  `abort_and_prompt`, `get_state`, `get_messages`, `get_available_models`, `set_model`,
  `set_thinking_level`, `get_session_stats`, `get_available_commands`, `compact`,
  `set_auto_compaction`, `switch_session`, `branch`, `get_branch_messages`,
  `set_session_name`, `new_session`.
- Responses: `{id?, type:"response", command, success, data?|error}`. **`prompt` is acked
  immediately, not on turn completion** — `data.agentInvoked` semantics plus the late
  `prompt_result` frame for local-only prompts (slash commands). Turn completion continues to
  come from the event stream (`agent_end`), same as Pi.
- `get_state` → `RpcSessionState`: `model`, `thinkingLevel`, `isStreaming`, `isCompacting`,
  `sessionFile`, `sessionId`, `sessionName`, `autoCompactionEnabled`, `todoPhases`,
  `contextUsage {tokens, contextWindow, percent}`. Parse leniently (`passthrough` + optional):
  omp adds fields between minor versions.
- Events: the `AgentEvent` family is Pi-lineage (`agent_start/end`, `turn_start/end`,
  `message_start/update/end`, `tool_execution_start/update/end`) — reuse the Pi mapping
  wholesale. omp-extended session events arrive in the same stream and are handled
  incrementally per phase; **unknown event types must be logged-and-dropped, never fatal.**
- Frames handled in Phase 1: `available_commands_update`, `extension_ui_request` (bridged as
  in Pi), `extension_error` (→ provider notice/log). Subagent frames land in Phase 2/3.

### launch.ts

`omp --mode rpc` plus: `--model <provider/id>`, `--thinking-level <level>`,
`--session <file>` / `--continue` for resume, `--append-system-prompt`,
`--approval-mode <mode>` (see §4), `--mcp-config <path>` (Phase 2 makes this unconditional).
No `--extension` injection (D3). Honor `ProviderRuntimeSettings.command` replace-mode override
like every provider.

Notes from upstream `docs/rpc.md` to encode as comments/tests:

- RPC mode rejects `@file` args; disables auto title generation; **resets `todo.*`, `task.*`,
  `memory.*`, `advisor.*`, `async.*`, `bash.autoBackground.*` settings to defaults**. Verify
  defaults keep the `task` and `todo` tools enabled (open-questions #1); if a setting must be
  restored, pass it explicitly at launch.
- Closing stdin exits the process cleanly — use as the graceful-shutdown path before tree-kill.

## 3. Native rewind (replaces the extension bridge)

Pi's rewind works via the injected `paseo_tree` extension command. omp adapter instead:

- `describePersistence()` → `nativeHandle` = `sessionFile` from `get_state` (unchanged shape,
  so persisted handles stay compatible with sessions created by the alias provider today).
- Stable message ids: session entries carry `id`/`parentId` natively. Hydration
  (`history-mapper.ts`) reads them from `get_messages` / `get_branch_messages` / the JSONL
  file; no `PASEO_ENTRY_CAPTURE` marker round-trip.
- `revertConversation({messageId})` → RPC `branch {entryId}`; omp moves the session-tree leaf
  and the next prompt forms a new branch. Capability: `supportsRewindConversation: true`.
  Files-rewind stays unsupported (as Pi today).

## 4. Modes from `--approval-mode`

omp's global approval policy becomes Paseo modes — the first time a Pi-family provider has
mode chips:

| Mode id                | omp flag                     | Manifest visuals           |
| ---------------------- | ---------------------------- | -------------------------- |
| `always-ask` (default) | `--approval-mode always-ask` | `ShieldCheck` / `safe`     |
| `write`                | `--approval-mode write`      | `ShieldAlert` / `moderate` |
| `yolo`                 | `--approval-mode yolo`       | `ShieldOff` / `dangerous`  |

Approval mode is a launch flag, so `setMode` mid-session either (a) applies on next turn via a
settings command if omp exposes one (open-questions #2), or (b) returns an
`AgentProviderNotice` ("applies after restart") — resolve during implementation, prefer (a).
Plan mode is Phase 2.

Manifest: update the `omp` entry in `packages/protocol/src/provider-manifest.ts` with the mode
definitions and `defaultModeId: "always-ask"`. Registry: point the `omp` factory at
`OmpRpcAgentClient`, deleting the `PiRpcAgentClient` alias config. `commandsRpcType` dies with
the alias (the omp adapter always uses `get_available_commands` and handles
`available_commands_update` pushes).

## 5. Session import / discovery hardening

`session-descriptor.ts` for omp must handle the real layout, not just the aliased dir:

- Base: `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl` (per-cwd encoded subdirs — mirror omp's
  `computeDefaultSessionDir`).
- Overrides, in order: `params.sessionDir` (config), `PI_CONFIG_DIR` (omp kept Pi's env
  namespace), XDG redirection (`$XDG_DATA_HOME/omp/sessions` after `omp config init-xdg`).
- JSONL header (`{type:"session", id, title?, timestamp, cwd, parentSession?}`) plus
  omp-added entry types (`session_init`, `mode_change`, `ttsr_injection`, `custom_message`,
  `branch_summary`, …): the parser must skip unknown entry types without failing a session.
- Subagent session files: decide marker/filter so task-spawned child sessions don't flood the
  import picker (open-questions #3). Until resolved, filter by presence in a parent's task
  metadata is not available — ship with whatever header/dir signal upstream provides, or leave
  them listed and revisit in Phase 3 (which claims them as child agents anyway).

## 6. Availability, diagnostics, version pinning

- `isAvailable()`: binary resolution for `omp` (existing `checkProviderLaunchAvailable`).
- `getDiagnostic()`: report resolved binary path, `omp --version`, and whether the version
  meets `MIN_SUPPORTED_OMP_VERSION` (a constant in the adapter with a comment pointing at this
  plan). Also note the npm-install caveat: installer/brew binaries embed Bun; npm-installed
  omp requires Bun on the machine — surface a clear diagnostic string, do not try to fix it.
- Capability probing over version parsing for optional features (D4).

## Deliverables / PR slicing

1. **PR-1:** transport core extraction (pure refactor, pi tests green).
2. **PR-2:** `OmpRpcAgentClient` MVP — launch, prompt/steer/abort, event mapping, models,
   thinking, stats, resume, native rewind, modes, diagnostics. Registry + manifest switch.
3. **PR-3:** session import hardening + history mapper.

Each PR: `npm run typecheck`, `npm run lint`, targeted vitest files only, e2e via CI.
E2E: repoint `omp` in `packages/server/src/server/daemon-e2e/agent-configs.ts`
(`full: "yolo"`, `ask: "always-ask"`).
