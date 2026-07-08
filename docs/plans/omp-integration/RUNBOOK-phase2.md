# RUNBOOK — Phase 2: omp v1 parity

Executes [02-v1-parity.md](02-v1-parity.md) on top of the landed D1 extraction
([RUNBOOK-d1-extraction.md](RUNBOOK-d1-extraction.md)) and phase-3 child agents
([RUNBOOK-child-agents.md](RUNBOOK-child-agents.md)). All work is adapter-scoped
(`providers/omp/`) via the `PiDialect` seam unless a workstream note says otherwise.

## Sequencing decisions

- Phase 3 landed before Phase 2, so §1 (inline subagent cards) must be reconciled with the
  existing child-agents track rather than implemented as written — decision pending Wave 0.
- D3 (kill extension bridge for omp) is deliberately deferred; nothing here depends on it,
  but it must land before Phase 5 enable-by-default.
- Open questions #1 (rpc-mode task/todo defaults), #2 (rpc-ui vocabulary), #7 (title
  emission), #8 (version pin) gate implementation and are being answered against the live
  installed omp in Wave 0.

## State

- [x] Wave 0 launched 2026-07-07 (both codex/gpt-5.5):
  - `68ff9a2c` — live omp RPC probe: answers open-questions #1/#2/#7/#8 inline, captures
    real fixture frames under `providers/omp/__fixtures__/`. — IN FLIGHT
  - `299497da` — read-only map of Paseo-side integration points for all 10 workstreams. —
    DONE 2026-07-07. Highlights: §1 inline cards and phase-3 child agents are parallel,
    unconnected surfaces (omp `task` renders as `unknown`; app prints `childSessionId` as
    plain text, no link into the subagents track) — §1 needs a reconciliation ruling, not
    the doc's v1-as-written. Latent bug: `buildExtensionUiQuestionPermission`
    (`pi-shared/agent.ts:889`) stamps `PI_PROVIDER` hardcoded → omp permissions may carry
    `provider:"pi"`; fold fix into §3. Protocol guardrails: todo statuses collapse to
    `completed:boolean` (no enum widening); single `sub_agent` detail per call (no
    `details[]`); a new `mcp` detail type needs compat care. Risk ranking: §3 > §1 > §9.
    Full map in the agent transcript (`299497da`); integration points are file:line dense.
- [x] Live probe (`68ff9a2c`) DONE 2026-07-07: open-questions #1/#2/#7/#8 answered inline
      (+#3 bonus), 10 fixture files under `providers/omp/__fixtures__/` (pinned omp 16.3.9).
      Dialect surprises vs the phase doc: rpc-ui approvals are generic `select` frames, not
      typed cards; approval mode is launch-time only (no mid-session switch); plan approval
      not reachable over RPC; `PI_RPC_EMIT_TITLE` dead (titles = option (b) only);
      `todo_auto_clear` removed upstream.
- [x] Execution spec written (below).
- [x] Wave 1 (data plane: §2 §5 §6 §7 §10 + OQ#3 import filter) — implemented
      2026-07-08 UTC on `feat/pi-native-subagents`. Landed: OMP dialect tool-detail hook
      (`ToolCallDetail | null`) used by live and replay; OMP `task` static `sub_agent`
      detail; raw `todo` card suppression plus todo timeline emission/hydration; OMP
      contextUsage merge into post-turn usage; `available_commands_update` command cache;
      OMP-only `/handoff` RPC; child session import filter; `MIN_SUPPORTED_OMP_VERSION`.
      §6 had no implementation gap; fixture-driven test pins inherited `off..xhigh`
      ladder. Deviations: rolling subagent task logs deferred to Wave 2 per spec; no
      `todo_auto_clear` handling because upstream removed it; command cache is populated
      only from update frames so Pi listCommands remains uncached. Verification passed:
      targeted OMP mapper/session tests, existing Pi `agent.test.ts` and `cli-runtime.test.ts`,
      `npm run typecheck`, `npm run lint`, `npm run format`.
      Review fixes: `/handoff` now sends `customInstructions`, import filtering builds its
      file set once per listing, duplicate consecutive todo cards are suppressed per session,
      and tests cover non-reasoning models plus state-over-stats context usage.
- [x] Wave 2 (§1 inline subagent cards, adapter-only) — implemented
      2026-07-08 UTC on `feat/pi-native-subagents`. Landed: OMP-only
      `OmpSubagentCardTracker` folds `subagent_lifecycle`/`subagent_progress` into the owning
      `task` tool call keyed by `parentToolCallId`, keeps one rolling `sub_agent` detail per
      parent call, aggregates `task.batch` streams with index-prefixed log lines, and throttles
      live running-card re-emits to one every 500 ms with an injectable scheduler for deterministic
      tests. The existing phase-3 `OmpSubagentIndex` and `child_session` emission paths are still
      fed unchanged. Minimal pi-shared seam added: tool-detail hooks receive `toolCallId` plus the
      live runtime session, extra-runtime handlers can test/re-emit active tool calls, and interrupt
      cleanup has a dialect hook. Replay can only render static task args/result content from the
      transcript, so it preserves task type/description and uses result text plus any transcript
      path as `log`/`childSessionId`; it does not reconstruct live progress frames absent from
      history. Verification passed: targeted OMP tracker/mapper/history/agent tests, Pi
      `agent.test.ts`, `npm run typecheck`, `npm run lint`, `npm run format`.
      Review fixes: task-arg agent type stays stable, sparse batch prefixes use max-index totals,
      suppressible active-call re-emits return false, tracked details preserve `actions` omission,
      and orphan lifecycle frames still emit `child_session` events.
- [x] Wave 3 (§3 approvals + §4 modes — riskiest) — implemented 2026-07-08 UTC.
      Landed: OMP launches through the Pi-compatible runtime with `--mode rpc-ui` and
      launch-time approval modes `full`→`--approval-mode yolo` and
      `ask`→`--approval-mode always-ask`; Pi remains on `--mode rpc`. OMP `rpc-ui`
      tool-approval `select` frames are upgraded to Paseo `kind:"tool"` permissions only
      when they exactly match the fixture/source signals (`["Approve","Deny"]`, title
      `Allow tool: bash|edit|write`, and the matching `Command:`/`File:`/`Path:` +
      `Content:` detail). Unrecognized dialogs, including ordinary selects and ask_user
      select+optional-comment chains, still fall through to the shared extension-UI question
      bridge. Tool approval responses send the exact selected OMP values (`Approve`/`Deny`);
      no allow-always value exists in OMP 16.3.9 source/fixtures, so any Paseo allow-always
      action collapses to `Approve`. The shared bridge now stamps extension-UI question
      permissions with the dialect provider instead of hardcoded `pi`.
      Plan-mode verdict: not shipped in the OMP manifest. Upstream `--plan <value>` is a
      planning model-role override, while actual plan mode is interactive `/plan` or ACP
      `session/setMode`; no RPC/rpc-ui launch flag or mid-session RPC command exists for
      headless plan mode in 16.3.9. Verification passed: mapper fixture test, OMP agent test,
      Pi `agent.test.ts`, Pi `cli-runtime.test.ts`, `npm run build:client`,
      `npm run typecheck`, `npm run lint`, `npm run format`.
- [x] Wave 4 (§9 MCP unconditional + §8 title push-down) — implemented
      2026-07-08 UTC.
      Landed: Wave 3 nits fixed by exporting `OMP_MODES` from the protocol manifest
      and importing/re-exporting it in the OMP server adapter, plus a Pi runtime launch
      test proving an explicit custom `--mode X` suppresses the appended `--mode rpc`.
      OMP now advertises `supportsMcpServers:true` from the dialect and skips the
      Pi-only `pi-mcp-adapter` probe while still using the shared per-agent
      `--mcp-config` file writer. The generated config remains `{mcpServers}` and maps
      HTTP/SSE entries, including the injected Paseo `/mcp/agents` endpoint, to
      `auth:false` and `oauth:false`; upstream OMP 16.3.9 accepts this shape via
      `MCPConfigFile.mcpServers` / `MCPServerConfig` and documents `oauth:false` as
      the way to skip OAuth credential injection.
      OMP-only appended system prompt copy:
      `OMP task tool = fast in-process helpers. Paseo create_agent = independent, user-visible agents.`
      Title push-down ships through the new optional server-internal
      `AgentSession.notifyTitleChanged?(title: string): void | Promise<void>` hook.
      `AgentManager` invokes it best-effort after initial title registration and after
      `setTitle`; live `updateAgentMetadata({title})` already routes through `setTitle`.
      Errors are debug-logged and never fail the caller. OMP implements the hook with
      `set_session_name` over the generic RPC request escape hatch; Pi does not implement
      the optional hook. Upstream RPC evidence: command
      `{id?, type:"set_session_name", name:string}` and success response
      `{id?, type:"response", command:"set_session_name", success:true}`; `rpc-mode.ts`
      trims/rejects empty names then calls `session.setSessionName(name, "user")`.
      Verification passed: OMP agent test, AgentManager test, provider wrapper
      test, Pi `agent.test.ts`, Pi `cli-runtime.test.ts`, `npm run build:client`,
      `npm run typecheck`, `npm run lint`, `npm run format`.
      Wave 4 review-fixes applied: title push-down now catches synchronous provider
      throws, and OMP skips whitespace-only `set_session_name` RPCs.
- [x] Waves 1–4 committed (`feat/pi-native-subagents`). omp default mode = `full`
      (yolo), confirmed by maintainer as the intended out-of-box posture (provider is
      disabled-by-default; pre-Wave-3 omp was yolo-or-crash).
- [x] E2E config wired 2026-07-08: omp added to `daemon-e2e/agent-configs.ts`
      (`allProviders`, modes full/ask) and the real-provider harness
      (`real-provider-test-config.ts`: `realProviders`, config `modeId:"full"`, OpenRouter
      env mirroring pi, client `OmpRpcAgentClient`, binary `OMP_COMMAND ?? "omp"`).
      CAVEAT: omp real e2e uses pi's OpenRouter model string (`openrouter/google/
gemini-2.5-flash-lite`) on the assumption omp shares pi's model plumbing — UNVERIFIED
      without a live OPENROUTER_API_KEY + omp binary; tests skip (canRunRealProvider=false)
      until both present. Confirm the model/provider string on first real omp e2e run.
- [ ] CI push (unit/integration full suite; real e2e skips without key).
- [ ] Manual verify on web + iOS per 02-v1-parity.md Testing section. Live-run checklist:
      subagent card populates on a real task run; no full-mode turn hangs on an rpc-ui
      dialog; detached subagents outliving their task produce no orphan cards;
      `set_session_name` renames without disrupting an in-flight turn; `/mcp/agents`
      endpoint reachable by omp's MCP client.

## Execution spec (rulings from Wave 0)

Waves run SEQUENTIALLY (every wave touches `omp/agent.ts` and dialect seams — no parallel
mutating agents). Each wave: implement → targeted tests vs fixtures → typecheck/lint/format
→ independent review → commit.

- **§1** — adapter-only in v1: fold `subagent_progress` into the owning `task` tool call's
  `sub_agent` detail keyed by `parentToolCallId` (mirror `claude/sidechain-tracker.ts`
  rolling log; throttle ≤2 updates/sec/call; `childSessionId` = sessionFile). Batch tasks
  aggregate into ONE card with per-item sections (protocol has single `detail`). App-side
  tap-through from `childSessionId` to the phase-3 subagents track is a noted FOLLOW-UP,
  not v1.
- **§2** — collapse `pending|in_progress|abandoned`→`completed:false`, `completed`→`true`
  (no enum widening). Emit on `todo` tool_execution_end + `todo_reminder`; hydrate from
  `get_state.todoPhases` on resume. `todo_auto_clear` is dead upstream — do not handle.
  Suppress the raw todo tool card.
- **§3** — rpc-ui `select` frames carrying Approve/Deny become Paseo `kind:"tool"`
  permissions via a pure mapper (`rpc-ui-permission-mapper.ts`) unit-tested against
  `__fixtures__/rpc_ui_extension_requests.json`; unrecognized dialogs keep the existing
  question/select bridge. Port ask_user chained select+comment. FIX the hardcoded
  `PI_PROVIDER` stamp in `buildExtensionUiQuestionPermission` (pi-shared/agent.ts:889) —
  provider must come from the dialect.
- **§4** — modes are LAUNCH-TIME ONLY (probe: no mid-session approval-mode command).
  Manifest declares full=`yolo`, ask=`always-ask`, plan (colorTier "planning", omp plan
  flag). `setMode` mid-session returns an `AgentProviderNotice` (relaunch-resume upgrade is
  post-v1 — live child subagent streams make silent relaunch dangerous). Plan approval
  arrives as a generic dialog, ships as that; `kind:"plan"` upgrade deferred.
- **§5** — omp mapper via a new dialect detail seam (hook where `emitToolCallEvent` calls
  `mapToolDetail`, pi-shared/agent.ts:1919): task→`sub_agent`, todo→suppressed (§2),
  hashline edit diff per fixture; lsp/dap/eval/browser → `unknown`, never fail a turn.
- **§6** — inherited ladder already matches (`off..xhigh`, reasoning-gated at
  pi-shared/agent.ts:1038); verify against `get_available_models_reasoning.json`, fix gaps
  only.
- **§7** — after each turn also read `get_state.contextUsage` and merge into `AgentUsage`
  (derive fill from used/max tokens; no new required fields).
- **§8** — option (b) only: push Paseo-generated titles down via `set_session_name` (new
  omp runtime wrapper over the generic request escape hatch). No title consumption.
- **§9** — omp sets `supportsMcpServers: true` unconditionally via the dialect; bypass the
  pi-mcp-adapter probe for omp only (pi keeps it); reuse pi's `--mcp-config` file shape
  (`auth:false`/`oauth:false` for `/mcp/agents` per docs/providers.md). System-prompt copy
  disambiguates task tool vs Paseo create_agent.
- **§10** — consume `available_commands_update` → refresh the listCommands cache (ACP
  precedent: acp-agent.ts:2452); add `/handoff` to `tryHandleOutOfBand` mapped to RPC
  `handoff`.
- **OQ#3** — omp import listing must exclude child-session files (they nest under the
  parent session's stem directory — filter by path nesting in the omp scanner path).
- **Version pin** — `MIN_SUPPORTED_OMP_VERSION = "16.3.9"` documented in the adapter;
  capability probing over version parsing (README D4).

## Verification gates

Same as D1: targeted vitest per touched file, typecheck/lint/format via npm scripts,
full suite via CI push. Fixtures captured from the pinned omp version are the unit-test
substrate (02-v1-parity.md Testing).

## Manual verify checklist

- live omp: confirm subagent card populates during a real task run (fixture lacks
  `tool_execution_start`; invariant verified in source only) and that detached subagents outliving
  their task produce no orphan cards.
