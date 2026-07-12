# OMP integration remediation runbook

Status: proposed remediation plan for `feat/pi-native-subagents` after the 2026-07-11 integration review.

Scope:

- No OMP upstream source changes under the current constraint.
- Paseo changes stay within `providers/omp`, `providers/pi-shared`, and `providers/pi` unless a small generic provider-child seam is required.
- No new wire or app surface unless an existing generic surface cannot express the behavior safely.
- Do not enable OMP by default or call the integration fully first-class until the real-provider gates in this runbook pass.

## Constraint conflict

OMP 16.3.9 does not expose enough RPC control to make retained and nested task agents fully first-class. In particular, Paseo cannot currently:

- tell when OMP has parked or released a retained child;
- prompt or release a retained child through RPC;
- enumerate OMP's process-global nested `AgentRegistry` through RPC;
- observe authoritative nested-child status after a direct task finishes;
- enter OMP plan mode through RPC.

A Paseo-only implementation can be safe and high-fidelity, but completed children must remain read-only while their parent OMP process owns them. Process restarts, file moves, idle-TTL guesses, and imports of private OMP modules are rejected: they do not provide an ownership acknowledgement and can reintroduce concurrent writers or kill detached work.

Two outcomes are therefore possible:

1. **Strict no-upstream path:** fix all correctness problems, represent retained ownership truthfully, and describe the result as high-fidelity rather than 100% first-class.
2. **True 100% path:** allow a small OMP RPC addition for registry-backed child snapshots/events, child prompting, and explicit child release. This is the recommended architecture if the 100% goal remains mandatory.

The remaining phases apply to both paths.

## Child ownership contract

Replace the current assumption that a terminal task lifecycle releases the child session with this state machine:

```text
provider_running
    | task lifecycle terminal
    v
provider_retained_idle
    | explicit OMP release, or parent OMP process exits
    +-------------------------------+
    v                               v
released_resumable             released_readonly
    | first Paseo prompt
    v
paseo_owned
```

Invariants:

- `completed` means the task invocation ended. It does not mean OMP released the child session.
- Paseo never starts a second OMP process for a provider-owned session file.
- Provider-owned children may be read and streamed, but cannot be independently resumed.
- Isolated children become `released_readonly`, never `released_resumable`.
- Promotion is lazy and occurs only when a released, resumable child receives a prompt.
- Child lifecycle status and ownership status remain separate.

### Required OMP RPC for true 100% parity

The minimum upstream contract would be:

1. Registry-backed child snapshots/events containing `id`, `parentId`, `status`, `sessionFile`, `isolated`, and `resumable`.
2. `prompt_subagent` or equivalent, so a Paseo virtual child remains promptable while OMP owns it.
3. `release_subagent`, which flushes, disposes, unregisters, and acknowledges ownership transfer.

Without this surface, live detach, retained-child prompting, authoritative nested-child recovery, and real plan mode remain blocked by the no-upstream constraint.

# Phase 1 — Child-session safety and lifecycle integrity

This phase blocks all further child-agent rollout.

## 1.1 Scope child IDs to their parent runtime

Files:

- `packages/server/src/server/agent/providers/omp/agent.ts`
- `packages/server/src/server/agent/providers/omp/subagent-index.ts`
- `packages/server/src/server/agent/providers/omp/subagents.test.ts`

Replace the client-global `Map<subagentId, sessionFile>` with a runtime-scoped structure such as `WeakMap<PiRuntimeSession, Map<subagentId, sessionFile>>`. Every lifecycle and progress lookup must use `(parentRuntime, subagentId)`.

Acceptance:

- Two parent sessions can both spawn a child named `Explore`.
- A terminal frame without `sessionFile` completes only the child belonging to the emitting runtime.
- Closing one parent does not mutate another parent's child index.

## 1.2 Stop terminal-time promotion

Files:

- `packages/server/src/server/agent/providers/omp/virtual-child-session.ts`
- `packages/server/src/server/agent/providers/omp/subagent-index.ts`
- `packages/server/src/server/agent/providers/omp/agent.ts`

Changes:

- Retain terminal index entries while the parent runtime owns them.
- Emit the child's terminal turn state without promoting it.
- Continue transcript hydration through `get_subagent_messages` while the parent is alive.
- Finish the final transcript fetch before emitting the child's terminal turn event.
- Treat explicit close and unexpected `process_exit` as ownership release.
- After release, read the session file directly and promote lazily on the next prompt.

## 1.3 Detect isolated and read-only children

OMP lifecycle frames do not contain sufficient isolation state. After ownership release:

- parse the child session header and `session_init` contract;
- read the recorded cwd;
- verify that cwd still exists;
- verify that the persisted session has a resumable contract.

A missing isolated worktree yields `released_readonly`. Never call `resumeSession` for it.

Acceptance:

- A normal child can be prompted after release.
- An isolated child remains readable and returns a typed non-resumable error.
- The UI never advertises an isolated child as independently promptable.

## 1.4 Add a generic provider-child ownership seam

This is the first justified core exception.

Files:

- `packages/server/src/server/agent/agent-sdk-types.ts`
- `packages/server/src/server/agent/agent-manager.ts`
- `packages/protocol/src/agent-labels.ts`
- minimal composer and subagent-track gating in the app

Extend the internal-only child event with ownership information:

```ts
type ProviderChildOwnership =
  | { owner: "provider" }
  | { owner: "paseo"; resumable: true }
  | { owner: "none"; resumable: false; reason: string };
```

Persist the state through existing labels rather than adding a wire message:

```text
paseo.provider-child-owner = provider | paseo | none
paseo.provider-child-resumable = true | false
```

Manager behavior:

- update existing children on later ownership events instead of dropping every duplicate;
- reject prompts while `owner=provider`;
- gate composer, interrupt, and detach from the same ownership state;
- enable them after ownership moves to Paseo.

## 1.5 Make child import and parent archive atomic

Files:

- `packages/server/src/server/agent/agent-manager.ts`
- `packages/server/src/server/agent/agent-manager-child-session.test.ts`

Before publishing an imported child:

1. confirm the parent still exists and is not archived;
2. register the child;
3. re-check the parent state;
4. if archival raced the import, archive the child in the same operation.

No imported child may escape parent cascade because it completed after the cascade snapshot.

## 1.6 Correct detach semantics

Strict no-upstream path:

- reject detach while OMP owns the child;
- provide a typed explanation;
- disable detach from the ownership label;
- allow detach after release.

True 100% path:

1. call `release_subagent`;
2. wait for release acknowledgement;
3. promote or mark read-only;
4. then remove the parent label.

Phase acceptance:

- no concurrent child-session writer;
- same-name children are isolated per parent runtime;
- archive during import leaves no orphan;
- detach never silently cancels child work;
- parent crash releases normal children;
- isolated children never attempt resume.

# Phase 2 — Complete the OMP RPC control plane

## 2.1 Replace the no-turn heuristic with `prompt_result`

Files:

- `packages/server/src/server/agent/providers/pi-shared/runtime.ts`
- `packages/server/src/server/agent/providers/pi-shared/cli-runtime.ts`
- `packages/server/src/server/agent/providers/pi-shared/rpc-types.ts`
- `packages/server/src/server/agent/providers/pi-shared/agent.ts`
- `packages/server/src/server/agent/providers/omp/rpc-types.ts`
- OMP and Pi tests

Changes:

- carry the generated RPC request ID through prompt acknowledgement;
- parse `prompt_result { id, agentInvoked }`;
- correlate it with the active OMP prompt;
- buffer `command_output` until the correlated result arrives;
- complete local commands only on immediate `agentInvoked:false` or matching `prompt_result.agentInvoked:false`.

Remove the current `setImmediate` plus `get_state.isStreaming` inference and its shared Pi state. Keep Pi behavior unchanged unless source verification establishes the same frame contract.

## 2.2 Add active-turn steer and follow-up

Expose OMP runtime methods for `steer` and `follow_up`. Add OMP-only out-of-band commands:

```text
/steer <message>
/follow-up <message>
```

Use the existing `tryHandleOutOfBand` path so these commands work while a foreground turn is active without allocating another Paseo turn.

## 2.3 Fix multiline approval fidelity

Files:

- `packages/server/src/server/agent/providers/omp/rpc-ui-permission-mapper.ts`
- `packages/server/src/server/agent/providers/omp/rpc-ui-permission-mapper.test.ts`
- OMP fixtures

For bash approvals, retain the `Command:` line suffix and every subsequent line exactly. The displayed shell detail and metadata command must be identical to the OMP approval prompt.

Cover destructive second lines, blank lines, whitespace, CRLF, and command text containing other approval prefixes.

## 2.4 Surface `open_url`

`open_url` is a fire-and-forget UI event, not a permission. Add an OMP dialect side-effect hook that emits an existing compatible Markdown timeline row containing the URL, `launchUrl`, and instructions. Never open the URL on the daemon host; it must reach the web/mobile client.

## 2.5 Preserve command hints

Make initial `get_available_commands` and later `available_commands_update` map `input.hint` identically to `argumentHint`.

## 2.6 Correct OMP diagnostics

Override diagnostics in `OmpRpcAgentClient` instead of adding more shared Pi policy. Report the resolved binary, version, minimum version, active OMP profile/XDG paths, OMP `agent.db`, and the Bun requirement for npm installs. Never use Pi auth paths for OMP.

Phase acceptance:

- slash commands cannot complete before an extension-triggered turn starts;
- multiline approvals display the complete command;
- OAuth URLs reach web/mobile clients;
- `/steer` and `/follow-up` operate during a turn;
- initial and updated command lists are equivalent;
- Pi behavior remains unchanged.

# Phase 3 — Native history, identity, threads, and rewind

## 3.1 Add OMP-native history mapping

Read session JSONL entries as the identity source. Deliberately map:

- `user` to user messages with entry IDs;
- `assistant` to text, reasoning, and tool calls;
- `toolResult` to tool completion;
- `developer` and `hookMessage` to provider/system notices;
- `pythonExecution` and `bashExecution` to execution tool calls;
- `compactionSummary` to the existing compaction/history surface;
- `branchSummary` to the existing history summary surface;
- `fileMention` to user context;
- unknown roles to a logged visible fallback rather than silent deletion.

## 3.2 Consume `get_subagent_messages.entries`

Retain transcript entries in `OmpSubagentMessagesResult`. Use them to attach user entry IDs, parent relationships, timestamps, and branch identity while the child remains virtual.

## 3.3 Remove the injected Pi extension from OMP

Add explicit pi-shared dialect hooks for launch artifacts, history identity, and rewind:

- Pi continues using the current extension bridge.
- OMP launches with no generated Pi extension.
- OMP ignores Pi capture/result markers.
- Remove the old OMP extension path rather than retaining dual behavior.

## 3.4 Implement native branch and rewind

OMP rewind sequence:

1. validate a branchable user entry;
2. call native `branch { entryId }`;
3. refresh state;
4. replace persistence with the new session file/session ID;
5. emit `thread_started`;
6. clear active tool state;
7. rehydrate the selected branch.

For exact prompt restoration, allow an optional generic result:

```ts
revertConversation(...): Promise<{ restoredPrompt?: string } | void>
```

Thread `restoredPrompt` through the existing rewind response and prefill the composer. The optional field is a useful cross-provider compatibility-safe core improvement.

Phase acceptance:

- OMP launches with no generated Pi extension;
- visible user messages have stable native IDs;
- rewind persists the new native handle;
- reload shows the same branch;
- the selected prompt is restored;
- unknown OMP history roles are not silently lost.

# Phase 4 — Nested children, restart recovery, and batch UX

## 4.1 Nested and restart reconciliation

With the required OMP RPC contract:

1. request a registry-backed child snapshot at session start and reconnect;
2. reconcile by parent runtime/session and native child ID;
3. import missing records;
4. use upstream `parentId` for the hierarchy;
5. update authoritative status and ownership;
6. tail missing transcript bytes;
7. clear ownership only on explicit release or process death.

Strict no-upstream fallback:

- after the parent process exits, recursively scan `<parent-session-stem>/**/*.jsonl`;
- derive historical parentage from directory nesting;
- import released historical children;
- never infer a live status from mtime or transcript shape.

The fallback restores history but cannot provide authoritative live nested agents.

## 4.2 Show every `task.batch` child

Add an optional generic field to the existing `sub_agent` detail:

```ts
children?: Array<{
  sessionId: string;
  label: string;
  status?: string;
}>;
```

Render one link per child. Older clients retain the aggregate log and existing first-child fallback. This is a small cross-provider improvement for any fan-out tool.

## 4.3 Preserve child identity

Display `<agent> — <description>` and store native ID, title, parent tool call, batch index, model, and session file separately. Never dedupe by display title.

Phase acceptance:

- restart restores every released child transcript and hierarchy;
- with upstream registry support, live nested rows recover too;
- every batch child is reachable;
- repeated child names across parents remain distinct.

# Phase 5 — Verification and rollout

## Targeted unit tests

Cover:

- two parents using the same child ID;
- terminal child remains provider-owned;
- no resume before ownership release;
- lazy promotion after release;
- isolated child becomes read-only;
- archive/import race;
- live detach rejection or release handshake;
- parent crash ownership release;
- multiline approval fidelity;
- `prompt_result` ordering races;
- `open_url`;
- `/steer` and `/follow-up`;
- all OMP history roles;
- subagent entry IDs;
- native branch/new session handle;
- nested hierarchy reconciliation;
- batch child links;
- OMP diagnostics;
- unchanged Pi launch/history/rewind behavior.

Tests defend observable contracts and use typed fakes or a real provider process; they do not inspect private maps.

## Real OMP E2E

Add a dedicated credentialed job using the pinned OMP version. It must fail if the intended binary or credentials are missing rather than silently reporting a skipped provider matrix as green.

Scenarios:

1. prompt, tool execution, and resume;
2. always-ask multiline approval;
3. interrupt and active steer;
4. todo lifecycle;
5. single task child timeline, terminal ownership, and follow-up;
6. `task.batch`;
7. identical child IDs from two parents;
8. detached task;
9. isolated task;
10. nested task;
11. parent archive during child import;
12. parent process exit and daemon restart;
13. OAuth `open_url`;
14. native rewind and reload;
15. native Paseo host tools and cancellation.

## Manual gates

Verify on web, Electron, iOS, and Android:

- composer/detach/interrupt gating;
- device-local OAuth link opening;
- ten-child fan-out performance;
- parent archive and detach behavior;
- restart during running and retained-idle states;
- batch links and nested navigation.

## Final checks

After behavioral smoke tests pass:

- targeted Vitest files;
- `npm run build:client` when protocol declarations change;
- `npm run typecheck`;
- `npm run lint`;
- `npm run format`;
- full CI matrix;
- then update integration docs and the enablement decision.

## Coverage matrix

| Review issue                       |                                Phase |
| ---------------------------------- | -----------------------------------: |
| Retained writer / double ownership |                                  0–1 |
| Isolated children                  |                                    1 |
| Child-ID collisions                |                                    1 |
| Archive/import race                |                                    1 |
| Detach semantics                   |                                    1 |
| Multiline approvals                |                                    2 |
| OAuth `open_url`                   |                                    2 |
| `prompt_result`                    |                                    2 |
| Follow-up and steer                |                                    2 |
| Command hints                      |                                    2 |
| Diagnostics                        |                                    2 |
| Missing history roles              |                                    3 |
| Child entry IDs                    |                                    3 |
| Native branch/thread integration   |                                    3 |
| Nested subagents                   | 4; upstream required for live parity |
| Restart recovery                   |                                    4 |
| `task.batch` links                 |                                    4 |
| Real E2E/manual verification       |                                    5 |

Critical sequence:

```text
ownership contract
  -> lifecycle safety
  -> RPC correctness
  -> native history and rewind
  -> nested and batch completeness
  -> rollout
```
