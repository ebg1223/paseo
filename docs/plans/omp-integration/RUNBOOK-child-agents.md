# Runbook — omp native subagents as Paseo child agents (current design)

Status: **implemented** on branch `feat/pi-native-subagents` (2026-07-07);
commits `1e1a9877` (types groundwork) + `27808d0e` (feature). 61 targeted tests
green, workspace typecheck/lint/format green. Full-suite verification belongs
in CI after push.

This supersedes the child-agent approach in [03-child-agents.md](03-child-agents.md)
(relay protocol / composer lock / app changes). The settled design needs **zero
`packages/app` changes and zero wire-protocol changes**; everything rides on the
existing Pi provider, `paseo.parent-agent-id` labels, and the import-session path.

## Design summary

- omp subagents run in-process in the parent but write their own session files.
  omp RPC mode broadcasts `subagent_lifecycle` / `subagent_progress` after
  `set_subagent_subscription level=progress`, and serves incremental transcripts
  via `get_subagent_messages {subagentId|sessionFile, fromByte}`.
- Pi adapter emits an internal `child_session` `AgentStreamEvent`
  (agent-sdk-types.ts — internal only, never crosses the WebSocket).
- AgentManager reacts in its dispatch switch: dedupe by (provider, nativeHandle)
  against live agents + stored records, then
  `importProviderSession({provider, providerHandleId: sessionFile, cwd: parent.cwd,
workspaceId: parent.workspaceId, labels: {[PARENT_AGENT_ID_LABEL]: parentId}})`.
- Single-owner session files: while the subagent is live, `importSession` returns a
  **virtual** AgentSession reading transcripts through the _parent's_ RPC (fromByte
  cursor); after terminal lifecycle it **promotes** to a real resumed session and
  delegates. No second pi process on a live file.

## State

- `1e1a9877` — committed groundwork: `child_session` stream event variant, Pi RPC
  subagent types/frames, no-op frame guard in `PiRpcAgentSession`.
- Delegated (Paseo subagents, gpt-5.5):
  - `f924b2e5` — Pi provider: runtime wrappers (`setSubagentSubscription`,
    `getSubagents`, `getSubagentMessages`), lifecycle bridge, client-level
    live-subagent index, virtual child session + promotion, incremental
    history-mapper refactor, tests. **Reviewed; one fix bounced back**: buffer
    virtual-session events emitted before the manager subscribes (cursor advanced
    with zero listeners → rows permanently skipped).
  - `0ede6be0` — AgentManager: `case "child_session"` (background import, never
    dispatched to the wire), live/stored/in-flight dedupe, optional title plumbing,
    tests in `agent-manager-child-session.test.ts`. **Done, reviewed, accepted**
    (6/6 tests green; final integration typecheck pending Agent A).
- Next: orchestrator review of both diffs, targeted vitest runs, typecheck/lint,
  format, commit. Full-suite verification via CI push, not locally.
- Working tree (uncommitted): omp `<system-notice>` absorption
  (`pi/omp-system-notice.ts`) — harness-injected background-job notices map to
  synthetic `task_notification` tool calls (callId `omp-notice:<id>`, mirrors
  the Claude `task-notification-tool-call.ts` precedent) instead of raw notice
  text. **Notices arrive as `custom_message` records (`customType:
"async-result"`), i.e. RPC role `"custom"` — NOT as user messages** (verified
  against a real parent transcript in `~/.omp/agent/sessions`). Hooked in the
  `role === "custom"` branches: `handleMessageEnd` (live) and `PiHistoryMapper`
  (replay; also makes non-notice custom messages replay as assistant text to
  match live — previously they were silently dropped on reload). Marker-gated
  (message starts with `<system-notice>`), no provider flag: vanilla pi never
  emits the marker. Also uncommitted: `omp-poll:<targets>` callId coalescing
  for repeated subagent poll tool calls.
- Working tree (uncommitted): virtual child sessions now emit turn lifecycle
  events so omp child agents show running/idle/error like Paseo-native
  subagents. `turn_started` at construction (subagent is guaranteed live at
  import), `turn_completed`/`turn_failed`/`turn_canceled` from the index
  terminal event (completed/failed/aborted), emitted before promotion so a
  failed promotion can't leave a stale spinner. Constructor re-checks
  `index.get()` after subscribing: if the subagent went terminal during the
  import's async gap it promotes directly instead of emitting `turn_started` —
  this also closes the pre-existing race where that window left the virtual
  session frozen (never promoted). No manager/protocol/client changes; the
  manager's out-of-band turn handlers do the rest.

## Gotchas (carry-over from design session)

- omp lifecycle `"started"` → Paseo `"running"`; terminal frames may omit
  `sessionFile` (resolve from earlier frames); registry retains transcript refs for
  up to 256 terminal subagents.
- Surface both detached and non-detached spawns.
- Upstream `pi` CLI lacks the subagent RPCs — subscription must be best-effort.
- Parent close kills in-process subagents → index treats them as aborted.

## Known v1 limitations (accepted)

- If the parent closes while a child subagent is live, the virtual session's
  final transcript fetch fails (parent RPC gone); promotion still resumes the
  full session file, but timeline rows fetched-but-not-yet-emitted stay missing
  until the user reloads the child agent (reload re-streams provider history).
- Child records are created on the first lifecycle sighting; later
  `child_session` events for the same child are dedupe no-ops. Status now
  flows through the virtual session's turn lifecycle events instead (see
  State), so this only means titles don't update after import.
- A subagent lifecycle frame arriving in the narrow window between parent
  session creation and manager subscription is dropped; the terminal lifecycle
  frame self-heals record creation (import then takes the resume path).
