# Runbook — omp native subagents as Paseo child agents (current design)

Status: **in progress** on branch `feat/pi-native-subagents` (2026-07-07).

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
- Child records are created on the first lifecycle sighting; later status
  changes don't sync back onto an already-imported record (dedupe no-op).
- A subagent lifecycle frame arriving in the narrow window between parent
  session creation and manager subscription is dropped; the terminal lifecycle
  frame self-heals record creation (import then takes the resume path).
