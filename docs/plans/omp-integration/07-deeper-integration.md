# OMP deeper integration

## Context

V1 shipped OMP `task` children as live, read-only `provider_subagent` views: they stream through the parent, recover from parent history, and never create independently promptable Paseo records. This plan sequences the deferred capabilities without weakening D-R2/D-R3: a child may become a normal agent through import, but Paseo must never infer write ownership from a persisted label or a terminal task frame. Any live lock is enforced by the live parent session that actually owns the OMP child; `completed` describes the task invocation, not ownership release.

## "Import as agent" affordance

**Delivers:** A one-tap action on a completed child pane that runs the existing D-R3 session-import flow and opens the resulting normal, promptable OMP agent. The read-only pane remains the historical child view; import creates an explicit identity boundary rather than silently promoting it.

**Surface:** App plus the existing session-import API; provider changes only if the import result needs a stable source handle exposed in the descriptor. No new child protocol or manager ownership state.

**Design:** Show the action only when the child has a `sessionFile`, its lifecycle is terminal, and the ordinary import preflight says the file is importable. The server, not UI labels, remains authoritative. If the parent OMP process still owns the file, reject with a typed “still owned by parent session” result and leave the view read-only; do not bypass that guard. Deduplicate repeated taps by the ordinary import identity rules.

**Preconditions:** D-R3 import is proven with real OMP sessions; import reports live-parent ownership and non-resumable/isolated sessions distinctly.

**Size:** M.

## Agent-record children

**Delivers:** Real Paseo child records with live timelines and, once safely transferable, reply-in-pane and ordinary resume/archive behavior.

**Surface:** Protocol-neutral manager/session seam, OMP provider, persistence, and app composer/status behavior; protocol changes only if a typed live-ownership state cannot fit the existing snapshot contract.

**Design:** Revisit the reporter shape from `03-child-agents.md`, but reject its persisted `paseo.child-session-lock` as authority and reject terminal-frame promotion. The live parent runtime owns a runtime-scoped child registry and blocks prompt/resume/detach while it can write the child JSONL. Ownership transfers only after an OMP release acknowledgement or parent process exit; then a resumable child may be lazily imported/promoted, while isolated children remain read-only. Persisted metadata may describe lineage and last-observed lifecycle, never prove a lock. Restart reconciliation derives safety from whether the owning parent session is live, not from clearing a stale label. Nested identity is keyed by parent runtime plus native child ID/session handle.

**Preconditions:** V1 behavior proven in the wild; dedicated design/security review; authoritative OMP release or a deliberately reduced process-exit-only transfer contract; deterministic live, retained, isolated, nested, and restart tests.

**Size:** XL, likely multiple PRs (manager contract, provider adoption, app UX).

## Paseo tools for OMP

**Delivers:** Dynamic per-session Paseo MCP tools to OMP, including agent orchestration such as `wait_for_agent`, without mutating user-owned `.omp/mcp.json`.

**Surface:** Primarily OMP provider launch/runtime and host-tool bridge; provider capability declaration and shared MCP serialization only if OMP accepts MCP config rather than a native host-tool RPC. No app work.

**Design:** Prefer an upstream `--mcp-config <ephemeral-file>` launch option whose config is scoped to that OMP process. Paseo writes a mode-`0600` temporary config, passes it at launch/resume, and removes it with the session lifecycle; user/project config remains untouched. A native `set_host_tools` RPC is the alternative and should use explicit capability negotiation, request correlation, cancellation, and truthful terminal results. Avoid SDK-internals imports and an exact MCP SDK pin if a public serialization boundary is available.

**Preconditions:** Upstream launch or RPC surface; threat review for secrets, cleanup, precedence, and hostile tool output; cancellation and reconnect tests.

**Size:** L.

## Batch child links

**Delivers:** Every child spawned by one `sub_agent`/batch tool call is linked from its inline card, rather than retaining only one `childSessionId`.

**Surface:** Protocol (`sub_agent.children[]`), provider mapper/history replay, and app card renderer/navigation.

**Design:** Add an optional backward-compatible array of stable child references while retaining the legacy singular field during the protocol compatibility window. Each reference carries enough identity to resolve within `(serverId, provider, nativeHandle)`; never resolve globally by a display ID. Render status from observed lifecycle/provider-subagent state and use unknown when absent—never fabricate `running` for legacy OpenCode cards. Multiple links must remain distinct despite duplicate names.

**Preconditions:** Fix and test both known regressions: truthful legacy status and server/provider-scoped lookup.

**Size:** M.

## Rewind prompt restore

**Delivers:** After native OMP branch/rewind, the composer restores the rewound user prompt directly instead of relying on the app fallback in `variables.rewoundText`.

**Surface:** OMP provider rewind result, manager/session plumbing, protocol `AgentRewindResult.restoredPrompt`, and app composer state.

**Design:** OMP branches by the native history entry ID, refreshes and persists the replacement session handle, and returns the exact selected user text as optional `restoredPrompt`. Thread that value unchanged through server and protocol; the app prefers it and retains the existing fallback for older servers/providers. Do not infer text from optimistic client IDs or unrelated timeline entries.

**Preconditions:** Native-ID rewind and handle replacement are reliable across reload.

**Size:** S–M.

## Title sync

**Delivers:** OMP-native title changes update the Paseo agent title without waiting for another snapshot/reload.

**Surface:** Provider session context/registry wrapper and OMP event mapping; existing agent snapshot/app rendering should consume the normal title update.

**Design:** Add a provider-neutral `notifyTitleChanged(title)` callback bound to the current agent/session generation. The manager validates the session is still current, persists once, and publishes the standard snapshot update. OMP invokes it only for authoritative native title events; stale runtime callbacks and blank titles are ignored. This is notification, not a second title store.

**Preconditions:** Confirm a stable authoritative OMP title event and define precedence versus explicit Paseo user renames.

**Size:** S.

## `pi-shared/` follow-through

**Delivers:** Further consolidation of Pi/OMP transport and event-mapping code where both dialects genuinely share behavior, reducing drift without widening OMP-specific policy into Pi.

**Surface:** Provider-only: `pi-shared`, Pi, and OMP adapters and their focused fixtures/e2e gates.

**Design:** Extract only behavior already proven equivalent—RPC framing/correlation, process lifecycle, or parameterized event mapping. Keep dialect capabilities and OMP child/tool policy at adapter edges. Each move should read as move-then-parameterize and preserve allocations/copy behavior; do not turn `pi-shared` into a generic server abstraction or bundle Pi-visible feature changes.

**Preconditions:** Pi e2e green before and after every slice; matching Pi/OMP fixture contracts; an identified duplicate with the same lifecycle semantics.

**Size:** M per slice; keep each PR narrow.

## Sequencing

1. **Title sync** and **rewind prompt restore** can land independently first: each is narrow, tests an additive provider-to-app contract, and does not depend on child ownership.
2. **Batch child links** follows once its two renderer regressions are fixed. It stacks protocol → provider mapping → app rendering, but remains independent of agent-record children.
3. **"Import as agent"** follows real-world proof of D-R3 and an authoritative live-parent import guard. It provides most reply-to-child value without identity continuity or manager ownership machinery.
4. **Paseo tools for OMP** proceeds independently when an upstream injection surface exists; split upstream support from Paseo adoption so neither PR carries speculative fallback code.
5. **`pi-shared/` follow-through** is opportunistic and independent: land small transport-only slices when duplication is demonstrated, never as a prerequisite for product features.
6. **Agent-record children** comes last. First land/review the runtime ownership and release contract, then OMP reporting/relay, then app prompting UX. It may reuse import affordance and batch identity work, but neither should wait for it.

Parallelizable groups are (title sync, rewind restore), then (batch links, import affordance, tools, transport slices) once each stated precondition is met. Agent-record work stacks on an explicit ownership contract and must not be bundled with the independent polish.

## Upstream OMP asks

- **Dynamic MCP injection:** Add `--mcp-config <path>` (or an equivalent process-scoped launch option) with documented precedence and no writes to user/project config. **Fallback if declined:** keep `supportsMcpServers: false`; users may use native preconfigured OMP MCP servers, but Paseo does not inject dynamic tools. Do not mutate `.omp/mcp.json`.
- **Authoritative child snapshots/events:** Expose registry-backed child identity, parent ID, lifecycle status, session file, isolation, and resumability, including nested children and explicit ownership state. **Fallback:** retain V1 `provider_subagent` views reconstructed from parent frames/history; no agent-record promotion while the parent lives.
- **Child addressing:** Add RPC commands such as `prompt_subagent`, `abort_subagent`, and `release_subagent`; release must flush, dispose, unregister, and acknowledge that OMP will no longer write the file. **Fallback:** children stay unpromptable in place; users import only after a safe process-exit/release boundary. If only process exit is observable, transfer waits for exit.
- **Native host tools (alternative to MCP):** A capability-negotiated `set_host_tools` surface with correlated calls, updates, cancellation, and reconnect behavior. **Fallback:** use `--mcp-config` if available; otherwise ship no dynamic Paseo tools.
- **Stable title and rewind signals:** Authoritative title-change events and rewind responses containing the selected native entry/text and new session handle. **Fallback:** poll/refresh titles only at existing lifecycle boundaries and retain `variables.rewoundText` composer fallback; never guess identity from client-generated IDs.
