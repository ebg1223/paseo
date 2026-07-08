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
- [ ] Wave 3 (§3 approvals + §4 modes — riskiest; strongest implementer + opus review).
- [ ] Wave 4 (§9 MCP unconditional + §8 title push-down).
- [ ] E2E config (`daemon-e2e/agent-configs.ts`: full=`yolo`, ask=`always-ask`) + CI.
- [ ] Manual verify on web + iOS per 02-v1-parity.md Testing section.

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
