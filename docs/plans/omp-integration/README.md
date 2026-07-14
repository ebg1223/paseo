# Oh My Pi (omp) — first-class integration plan

Turn the `omp` provider from a thin Pi-adapter alias into a first-class integration where omp's
primitives — subagents above all — line up natively with Paseo's agent model.

Source reference: `~/oh-my-pi` (fork of pi-mono by Can Boluk, v16.3.9 at time of writing,
`github.com/can1357/oh-my-pi`). **All changes in this plan are scoped to the paseo repo.**

## Where we are today

`omp` is registered in `packages/server/src/server/agent/provider-registry.ts` (factory `omp`) as
the shared `PiRpcAgentClient` with three tweaks: `argv: ["omp"]`, `providerParams.sessionDir:
"~/.omp/agent/sessions"`, and `commandsRpcType: "get_available_commands"`. Disabled by default
(`packages/protocol/src/provider-manifest.ts`). Everything omp's RPC protocol does beyond stock
Pi's dialect is silently dropped: `subagent_lifecycle`/`subagent_progress`/`subagent_event`
frames, `set_subagent_subscription`, `get_subagent_messages`, `set_todos`, host tools/URIs,
native `branch`/`get_branch_messages`, `handoff`, `rpc-ui` approval cards. Paseo's
`providers/pi/rpc-types.ts` has zero references to any of them (verified).

## Why omp maps well onto Paseo

omp keeps Pi's transport (NDJSON over stdio, `omp --mode rpc`, `id`-correlated
request/response, event stream forwarding `AgentSessionEvent`s) but extends it with exactly the
primitives Paseo already renders for its best-integrated providers:

- **Subagents**: the built-in `task` tool spawns real child `AgentSession`s, each with its own
  JSONL session file, streamed over three RPC channels with per-child lifecycle, progress
  (current tool, tokens, cost), and full nested event streams. See
  `oh-my-pi/packages/coding-agent/src/task/` and `modes/rpc/rpc-subagents.ts`.
- **Approvals**: `--mode rpc-ui` promotes tool approval cards/dialogs into
  `extension_ui_request` frames; `--approval-mode always-ask|write|yolo` sets coarse policy.
- **Todos, plan mode, native branch/rewind, session naming, MCP client built in.**

Authoritative upstream surfaces to code against (read, do not vendor):
`oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts` (commands/responses/frames),
`oh-my-pi/packages/agent/src/types.ts` (`AgentEvent`),
`oh-my-pi/packages/coding-agent/src/session/agent-session.ts` (extended session events),
`oh-my-pi/docs/rpc.md` (prose spec), `oh-my-pi/python/omp-rpc/` (a complete typed reference
client — the best blueprint for our adapter).

## Design decisions

### D1 — Dedicated adapter, shared transport core

`omp` gets its own adapter (`providers/omp/`) instead of more flags on `PiRpcAgentClient`. The
protocols have already diverged (command names, frames, settings semantics), and
`docs/providers.md` records why we prefer explicit adapter settings over probing/fallback (both
runtimes return unknown-command errors without the request `id`, turning mismatches into
timeouts). The NDJSON/spawn/id-correlation plumbing is extracted into a shared core both
adapters use. The `pi` provider's behavior does not change.

### D2 — Subagents ship in two layers

- **v1 (adapter-only):** omp `task` calls render as the existing inline
  `ToolCallDetail{type:"sub_agent"}` cards — the same treatment Claude Task sidechains get.
  Full parity, zero core risk.
- **v2 ("child agents", one small core seam):** omp subagents become **real agent records**.
  Key insight: every omp subagent already has its own JSONL session file, which is exactly what
  our import/resume machinery consumes, and `AgentManager` already supports records with no
  live runtime (every idle agent after daemon restart is one). So a subagent row is a normal
  omp agent whose timeline is _relayed_ from the parent's RPC stream while the task is live and
  which is **locked** (not promptable) until omp releases the file. After completion it is a
  plain resumable omp agent. The subagents track, cascade archive, detach, and workspace
  activity all work off the existing `paseo.parent-agent-id` label — **no wire protocol
  changes**.

**Rejected: mirror agents with permanent stub sessions.** A degraded look-alike variant of
"agent" that can never be prompted/resumed poisons every code path that enumerates agents
(`send_agent_prompt`, `paseo ls`, wait/notify, detach) — the bags-of-booleans anti-pattern from
`docs/coding-standards.md`.

**Deferred, not rejected: a generic protocol-level "provider child session" primitive.** The
honest generalization (would also fix Claude sidechain rendering). Bigger lift: new protocol
surface + client state. The v2 core seam is deliberately provider-agnostic so this remains a
future refactor, not a rewrite.

**Rejected: overriding omp's `task` tool to route through Paseo `create_agent`.** Makes
Paseo-omp behave differently from terminal omp and discards the features users choose omp for
(worktree isolation, typed yields, recursion allowlists). Paseo orchestration stays available
_alongside_ the native task tool via MCP/host tools.

### D3 — Kill the injected-extension bridge for omp

The Pi adapter injects a generated `.mjs` extension (`--extension`) to smuggle message IDs and
the conversation tree back through `notify` markers (`PASEO_ENTRY_CAPTURE` /
`PASEO_COMMAND_RESULT`) — documented as the most fragile part of the Pi integration. omp
exposes all of it natively: `branch {entryId}`, `get_branch_messages`, `switch_session`,
session entries with stable `id`/`parentId`. The omp adapter uses the native RPCs and injects
no extension.

### D4 — Feature gating by capability probe, not version parse

omp moves fast (v16.x). The adapter pins a minimum supported version (documented in the
adapter), and gates optional behavior by probing (e.g. presence of fields in `get_state`,
command availability) rather than parsing version strings. Daemon→client feature exposure
follows the repo feature contract: flags in `server_info.features.*` with `COMPAT()` comments
where shims exist.

## Phases

| Phase                           | Doc                                                  | Scope                                                                                         | Core changes?                                                 |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1 — Adapter foundation          | [01-adapter-foundation.md](01-adapter-foundation.md) | `OmpRpcAgentClient`, shared RPC core, native rewind, modes, session import hardening          | None                                                          |
| 2 — v1 parity                   | [02-v1-parity.md](02-v1-parity.md)                   | Inline subagent cards, todos, rpc-ui approvals, plan mode, tool mapper, thinking, titles, MCP | None                                                          |
| 3 — Child agents (v2 subagents) | [03-child-agents.md](03-child-agents.md)             | Provider-registered child agents: `AgentManager` seam + relay + lock; adapter consumption     | One small provider-agnostic daemon seam + app composer gating |
| 4 — Host tools                  | [04-host-tools.md](04-host-tools.md)                 | `set_host_tools` → `supportsNativePaseoTools`                                                 | None                                                          |
| 5 — Long tail & rollout         | [05-long-tail.md](05-long-tail.md)                   | Usage fetcher, notices/goals, e2e, icon, docs, enable-by-default                              | None                                                          |

Open verification items and risks: [open-questions.md](open-questions.md).

Phases 1 and 2 land together or in quick succession (Phase 2 is why Phase 1 exists). Phase 3
is the flagship and depends on 1–2. Phases 4 and 5 are independent of 3.

## Success criteria

- An omp agent pane is at feature parity with a Claude agent pane: mode chips, todos, real tool
  approvals, plan flow, diff rendering, rewind, titles, usage.
- omp `task` subagents appear live in the subagents track, open into full streaming timelines,
  and remain resumable conversations after completion (Phase 3).
- The `pi` provider is byte-for-byte unaffected (its e2e suite is the regression gate for the
  transport extraction).
- No wire-protocol schema changes anywhere in Phases 1–3; all additions are optional per the
  protocol contract.
