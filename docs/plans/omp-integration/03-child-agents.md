# Phase 3 — Child agents: omp subagents in the subagents track

The flagship. omp `task` subagents become **real Paseo agent records**: live rows in the
subagents track while running, full streaming timelines when opened, and — after completion —
ordinary resumable omp agents. One small provider-agnostic daemon seam; no wire-protocol
schema changes.

## The insight this design rests on

1. Every omp subagent already writes its own JSONL session file (`sessionFile` in the
   lifecycle frames) — the exact artifact our import/resume machinery consumes.
2. `AgentManager` already supports agent records with no live runtime: after a daemon restart
   every idle agent is a JSON record + persistence handle, resumed lazily on the next prompt.

So a live omp subagent is a normal omp agent record in a temporary state: its timeline is
**relayed** from the parent's RPC stream, and it is **locked** against prompt/resume while omp
owns the session file. On the terminal lifecycle frame the lock lifts and the record is
indistinguishable from an imported omp session carrying a parent label.

What we explicitly do NOT build: a new agent-like entity, stub sessions that permanently
can't run, or any change to track/tab/archive/detach semantics — those all key off
`paseo.parent-agent-id` (`packages/protocol/src/agent-labels.ts`) and work unchanged.

## Part A — daemon seam (provider-agnostic, the only core change)

**New surface on `AgentLaunchContext`** (or a sibling context object passed by `AgentManager`
into `createSession`/`resumeSession`): a child-session reporter the adapter calls. Sketch —
names/team-style to be settled in review:

```ts
interface ProviderChildSessionReporter {
  reportChildStarted(input: {
    parentAgentId: string;
    childKey: string; // stable per child: omp subagent id
    title: string; // agent name — task description
    persistence: AgentPersistenceHandle; // provider=omp, nativeHandle=sessionFile
    cwd: string; // parent cwd or isolation worktree path
  }): Promise<{ agentId: string }>;
  relayChildEvent(agentId: string, event: AgentStreamEvent): void;
  reportChildEnded(input: {
    agentId: string;
    status: "completed" | "failed" | "aborted";
    resumable: boolean; // false for merged-and-removed isolation worktrees
  }): Promise<void>;
}
```

`AgentManager` responsibilities:

- `reportChildStarted`: create a normal agent record (same storage path
  `$PASEO_HOME/agents/...`), stamp `paseo.parent-agent-id` = parent, plus a lock label
  `paseo.child-session-lock` = `"relay"`. Publish to subscribers — track rows appear via the
  existing snapshot flow.
- `relayChildEvent`: append to the child's persisted timeline and fan out to timeline
  subscribers, exactly as events from a live session would — the child simply has no runtime
  of its own yet.
- Resume/prompt guard: while the lock label is present, `sendPromptToAgent`/resume paths
  reject with a typed domain error ("running as a subagent of <parent>"); `wait_for_agent`
  and notifications treat lock-release/terminal frame as the finish signal.
- `reportChildEnded`: clear the lock label (or set `paseo.child-session-lock`=`"expired"` when
  `resumable: false`), normalize `lastStatus` (`completed`→`idle`, `failed`→`error`,
  `aborted`→`idle`), publish. From here the record is a plain omp agent: prompting it goes
  through the ordinary resume path (`omp --mode rpc --session <file>`).
- Parent archive cascade, detach, tab semantics, workspace activity: **no changes** — all
  driven by the label and status, which are ordinary.

Design constraints:

- The seam is generic (nothing omp-specific in `AgentManager`); it is the reuse point for a
  future provider and the migration point for an eventual protocol-level child-session
  primitive (see README D2).
- Locked children are excluded from `create_agent`-style targeting errors by the guard, not by
  hiding them: they still appear in `paseo ls`, MCP `list_agents`, etc., with their real
  status. Tools that would prompt them get the typed error.
- Restart: records rehydrate from disk like any agent. If the parent process is gone, the
  daemon clears stale `"relay"` locks on reconcile (a lock without a live parent runtime is
  stale by definition — same spirit as the managed-process reaper). Timeline catch-up for
  missed events comes from Part B hydration on next open.

### App change (small)

Composer/interrupt gating when `labels["paseo.child-session-lock"] === "relay"`: disabled
composer with hint "Running as a subagent of <parent> — you can reply when it finishes."
When the lock is `"expired"` (unresumable worktree children): read-only with a different hint.
Labels already flow to the client, so this is UI gating only — old clients show a normal row
and get the daemon guard error on prompt, which is acceptable degradation per the feature
contract (no fallback path needed).

Feature flag: `server_info.features.providerChildAgents` with the standard
`// COMPAT(providerChildAgents): added in v0.1.X` comment, so the app can distinguish "locked"
from "old daemon that doesn't send lock labels".

## Part B — omp adapter consumption

`providers/omp/subagents.ts` grows from the v1 card-folder into the child-agent driver:

- Subscription level moves `progress` → `events` (`set_subagent_subscription
{level:"events"}`): lifecycle + progress + full nested `subagent_event {id, event}` streams.
- `subagent_lifecycle status:"started"` → `reportChildStarted` (childKey = subagent `id`,
  persistence handle from `sessionFile`, cwd = worktree path when `isolated`).
- `subagent_event` → translate the nested `AgentSessionEvent` through the same event-mapping
  code the adapter uses for the parent (text/thinking deltas, tool executions, turn
  lifecycle) and feed `relayChildEvent`. This is the same mapper — factor it so it is
  instantiable per-stream rather than bound to the parent session singleton.
- `subagent_progress` continues to update the inline v1 card (kept — the parent transcript
  stays readable standalone) and supplies usage (tokens/cost) for the child record.
- `subagent_lifecycle` terminal statuses → `reportChildEnded`. `resumable: false` when the
  child ran isolated and omp merged+removed the worktree (open-questions #4 tracks how to
  detect merge-vs-keep).
- **Catch-up / gap repair:** on adapter (re)attach or missed frames, `get_subagents` snapshots
  combined with `get_subagent_messages {sessionFile, fromByte}` (incremental byte-offset
  transcript tailing, `nextByte`/`reset` cursor) rebuild child timelines. Also the hydration
  path when a user opens a child that started before the client subscribed.
- **Detached tasks** (`detached: true`): frames keep flowing after the parent's turn ends —
  relay continues as long as the parent process lives. If the parent session closes with
  detached children still running, fall back to file-tailing via a short-lived
  `get_subagent_messages` loop or mark the child's lock stale for reconcile (decide in
  implementation; bias to the simple stale-lock path first).
- **Nested spawns** (subagents spawning subagents): frames arrive on the same channels with
  their own ids; parent for the label is the _spawning_ subagent's child record, giving the
  track its natural one-level nesting per existing UI behavior. If frame metadata is
  insufficient to resolve the grandparent (open-questions #5), attach to the root parent —
  correct enough, refine later.

## UX contract (what we're building, testable)

- Task fan-out → rows appear in the parent's track within one frame-batch, named
  `<agent> — <description>`, with live status/tool/cost.
- Tapping a row opens a full streaming timeline; composer locked with the hint.
- Completion → row goes idle; opening it shows the full transcript; prompting it resumes the
  session file as a fork of that conversation (hint copy makes the fork semantics explicit:
  the parent already consumed the yield result).
- Archive X, detach, parent cascade-archive, tab close: identical to Paseo-native subagents.
- Restart mid-task: rows persist with last-known state; live streaming resumes if the parent
  is still running, otherwise locks reconcile away and rows become resumable.

## Testing

- Daemon-seam unit tests with a fake provider driving the reporter: record creation, label
  stamping, relay persistence + fan-out, lock guard errors, terminal transitions, cascade
  archive of relayed children, stale-lock reconcile on restart.
- Adapter tests against captured frame fixtures: lifecycle→reporter calls, event translation
  parity with parent mapping, byte-cursor catch-up (`reset` handling), batch and detached
  cases.
- E2E (behind `isProviderAvailable("omp")`): prompt that provably fans out (pinned agent
  definitions fixture in the test workspace), assert child records exist with parent label,
  locked prompt rejected, post-completion prompt succeeds.
- App: track-row gating snapshot tests for the two lock states.

## PR slicing

1. **PR-1 (core):** reporter seam + lock guard + reconcile + tests. No omp code. Reviewably
   small; this is the PR that needs maintainer-level design sign-off — link README D2's
   rejected-alternatives so the "why not mirrors / why not protocol-level yet" argument is in
   the PR description.
2. **PR-2 (adapter):** events subscription, per-stream mapper, reporter driving, catch-up.
3. **PR-3 (app):** composer/interrupt gating + hints + feature flag read.
