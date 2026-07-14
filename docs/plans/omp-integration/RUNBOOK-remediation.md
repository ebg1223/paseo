# OMP integration remediation runbook

Status: implementation and credentialed real-provider verification complete on `feat/pi-native-subagents`; rollout remains gated on platform UX verification and the explicit default-enablement decision.

Scope:

- No OMP upstream source changes under the current constraint.
- Paseo changes stay within `providers/omp`, `providers/pi-shared`, and `providers/pi` unless a small generic provider-child seam is required.
- No new wire or app surface unless an existing generic surface cannot express the behavior safely.
- Do not enable OMP by default or call the integration fully first-class until the real-provider gates in this runbook pass.

## Implementation status - 2026-07-13

- The strict no-upstream path is implemented: provider-child ownership is explicit, provider-owned children cannot be resumed or detached through Paseo, release/import ordering is atomic, nested released children are recovered, and batch details retain every child link.
- OMP's `detached` lifecycle field means background execution, not removal from the parent relationship. Native `task` children remain associated with the parent in Paseo and therefore render in the subagents track instead of opening as root tabs.
- OMP control-plane support now correlates prompt completion, handles steer/follow-up commands out of band, preserves multiline approvals, and surfaces OAuth URLs and provider diagnostics.
- OMP history uses native entry identities, filters known JSONL control records while retaining visible fallbacks for unknown records, no longer injects the Pi extension bridge, and native branch rewind replaces the persisted session handle before reload.
- Focused server, protocol, client, and app tests pass. Workspace typecheck and lint pass.
- The credentialed 12-test OMP matrix now uses the installed OMP Codex OAuth subscription when `OPENROUTER_API_KEY` is absent (`OMP_REAL_TEST_MODEL` can override the model). Five scenarios pass together: prompt/tool/resume, multiline approval, active steer/interrupt, todo/batch import, and released-child follow-up. Seven rollout findings remain: generic imported child titles, strict topology aborts, archive/import against a closed session, restart-resume errors, an invalid prompt-driven `open_url` gate, native branch timeout, and host-tool cancellation errors. Browser verification passes native task association, provider-owned composer/attachment/dictation/voice gating, ownership release on parent reload, and resumed child follow-up. Electron, iOS, and Android ownership UX checks remain.
- `omp` remains disabled by default until those rollout gates pass.

## Remaining implementation plan — Codex gate findings

Scope rule:

- Production changes default to `packages/server/src/server/agent/providers/omp/`.
- Test-harness changes stay in `packages/server/src/server/daemon-e2e/omp.real.e2e.test.ts` and OMP-focused test files.
- Do not change protocol or app surfaces for these findings.
- Touch `pi-shared`, `AgentManager`, or the generic Paseo host-tool catalog only when a provider-independent invariant is reproduced in a generic focused test. Pair that change with both a generic regression and an OMP regression.

### P0 — Make each gate deterministic

The real matrix must distinguish adapter failures from model prompt variance before production code changes:

1. Treat the latest event for each tool-call ID as authoritative; intermediate `running` updates are expected history.
2. Use exact shell commands instead of phrases such as “print NAME”, which Codex may interpret as an environment variable.
3. Exercise released-child follow-up through Paseo after parent release, not by asking the parent model to message its own child.
4. Split detached, isolated, and nested topology into separate scenarios.
5. Split `create_agent`, `send_agent_prompt`, `cancel_agent`, and `wait_for_agent` assertions so the first failing host operation is visible.
6. Include the final agent error, relevant ownership labels, persistence handle, and latest host-tool frame in assertion diagnostics.

Acceptance: each failed scenario identifies one operation and one violated invariant; rerunning the five currently passing scenarios remains green.

### P1 — Preserve native child identity and topology

Files:

- `providers/omp/agent.ts`
- `providers/omp/subagent-index.ts`
- `providers/omp/subagents.test.ts`
- `providers/omp/subagent-index.test.ts`
- `daemon-e2e/omp.real.e2e.test.ts`

Plan:

1. Use the lifecycle payload's native child ID (`payload.id`) as the child title/name. Keep `description` as descriptive task text; never substitute it for identity.
2. Keep `sessionFile` as the persistence/lookup key and `parentToolCallId` plus batch index as linkage. Repeated display names must not deduplicate children.
3. Pin the current OMP meaning of `detached`: background execution, not relationship detachment. It remains parent-associated and provider-owned until an explicit release boundary.
4. Classify isolated children as read-only/non-resumable without promoting them into normal workspace tabs.
5. Verify nested parentage from `parentChildSessionId`; do not infer it from title, cwd, or display order.
6. If a real detached/isolated task still aborts after the scenarios are separated, preserve the trace as an upstream/runtime finding. Do not mask it in Paseo lifecycle state.

Acceptance:

- `ParentAlpha` and `ParentBeta` retain those titles while two nested children both named `SameChild` remain distinct.
- Detached, isolated, and nested scenarios each finish or fail for their own documented runtime reason.
- No app changes.

### P2 — Make released-child import independent of the parent runtime

Files:

- `providers/omp/agent.ts`
- `providers/omp/subagent-index.ts`
- `providers/omp/virtual-child-session.ts`
- `providers/omp/released-session.ts`
- focused OMP child/import tests
- `daemon-e2e/omp.real.e2e.test.ts`

Plan:

1. Add an ownership-aware index lookup. `importSession` may use `get_subagent_messages` only while the indexed child is still provider-owned and its parent runtime is open.
2. Remove or exclude released entries from the “live child” lookup before the parent runtime closes. A released entry must never route through a closed parent RPC session.
3. For a disk-backed child classified as resumable, construct its persistence handle and resume it through `OmpRpcAgentClient.resumeSession`; use `OmpReleasedSession` only for genuinely read-only history such as isolated children.
4. Preserve lazy promotion for the existing live virtual child, but make release idempotent and ensure promotion errors retain the child handle and ownership reason.
5. Re-run archive → release → archive child → import same handle → prompt. The import must not consult the old parent runtime.

Acceptance:

- No `Pi RPC session is closed` during re-import.
- The imported child keeps the same native handle and accepts a follow-up.
- Isolated history remains readable but cannot be prompted.

### P3 — Revalidate restart recovery after topology is stable

The current restart scenario fails during detached-task setup, before daemon restart. Do not treat it as a restart defect until P1 separates that setup.

Plan:

1. Establish a normal retained child with a stable native handle.
2. Test two explicit states:
   - provider-owned child while the parent remains live: stored reload must reject direct child prompting;
   - child released during parent/process close: the ownership update and handle must persist before shutdown completes.
3. Restart the isolated test daemon, load the released record, and prompt the same handle.
4. Inspect the generic manager only if the OMP release event is emitted correctly but its already-observed ownership transition is not persisted. Any manager fix must be provider-neutral and covered by the existing generic child-session close/reload tests.

Acceptance: restart restores the same handle and hierarchy; released children resume, while still-provider-owned children remain unavailable without being mislabeled as errors.

### P4 — Rewind with the native OMP entry ID

Files:

- `providers/omp/history.ts`
- `providers/omp/runtime.ts`
- `providers/omp/agent.ts`
- `providers/omp/runtime.test.ts`
- `providers/omp/history-mapper.test.ts`
- `daemon-e2e/omp.real.e2e.test.ts`

Plan:

1. In the real gate, select the `messageId` emitted by OMP for the visible user-history entry. Do not pass the caller-supplied optimistic UUID to native `branch`.
2. Assert that the chosen ID exists in the active JSONL chain before sending `branch { entryId }`.
3. Add request/response diagnostics for branch command, request ID, target entry ID, and timeout without logging prompt content or credentials.
4. Only change request correlation in `pi-shared` if a transport-level test proves responses for other commands are also mismatched. Otherwise keep the correction in OMP runtime/identity mapping.
5. After a successful branch, refresh state, replace the persistence handle, reload, and verify the restored prompt and selected history chain.

Acceptance: branch responds within the normal RPC timeout, the native handle changes, reload preserves that handle, and the selected prompt is restored.

### P5 — Replace the fake OAuth gate and isolate host-tool cancellation

Files:

- `providers/omp/rpc-ui-permission-mapper.ts`
- `providers/omp/host-tools.ts`
- their focused tests
- `daemon-e2e/omp.real.e2e.test.ts`

OAuth plan:

1. Delete the prompt that asks an authenticated model to invoke `open_url`; `open_url` is an RPC login-flow event, not a model tool.
2. Launch a dedicated OMP client with a temporary unauthenticated profile/config and a Codex OAuth model.
3. Start the login flow, capture the actual `extension_ui_request { method: "open_url" }`, assert URL/instructions mapping, then cancel cleanly.
4. Keep device-local URL opening in the manual platform matrix; the server gate verifies only that the typed request reaches Paseo.

Host-tool plan:

1. Run `create_agent`, `send_agent_prompt`, `cancel_agent`, and `wait_for_agent` as individually asserted operations with exact IDs from structured results.
2. Record the outbound `host_tool_result`/`host_tool_update` sequence and the parent `lastError` on failure.
3. If OMP drops or mis-correlates the terminal result, fix only `providers/omp/host-tools.ts`.
4. If the generic `cancel_agent` catalog operation itself violates its contract for every caller, fix the generic catalog once and add both generic and OMP coverage.
5. Do not synthesize a successful result after cancellation; preserve a truthful terminal canceled/error state.

Acceptance:

- Real login emits one mapped `open_url` request without the model opening a browser.
- The host-tool parent returns idle after observing a truthful terminal child state.
- No orphaned host calls, agents, or unresolved waiters remain.

### P6 — Rollout sequence

Execute in dependency order:

```text
P0 deterministic gates
  -> P1 identity/topology
  -> P2 archive/import
  -> P3 restart
  -> P4 rewind
  -> P5 OAuth + host tools
  -> full 12-test Codex matrix
  -> web/Electron/iOS/Android manual gates
  -> enablement decision
```

After each production phase: run only its focused OMP tests, then the corresponding real scenario. After all phases: run the full OMP matrix, workspace typecheck, lint, format, and CI. Keep `omp.enabledByDefault` false until every automated and manual gate passes.

## Upstream revalidation

Merge commit `234db395` incorporates Paseo `upstream/main` through `c05e337c`. The relevant upstream changes were rechecked against every finding in this runbook.

- No OMP remediation finding was fixed or made obsolete by the merge.
- Upstream shutdown registration tracking now prevents new or reconnecting sessions from surviving daemon shutdown. It does not make provider-child import atomic with parent archive, so Phase 1.5 remains required.
- Upstream Pi MCP config preservation was ported into the extracted `pi-shared` implementation during conflict resolution. Pi now merges its global `mcp.json`, preserves runtime environment during probe/resume, and writes the generated config with mode `0600`. OMP's native MCP path remains separate. This behavior is merged and needs regression coverage, not another implementation phase.
- Upstream text-only Pi image prompt handling was ported into `pi-shared` in `0adf038c`; the merged upstream tests now pass against the extracted adapter.
- OMP prompt completion now consumes and correlates the authoritative `prompt_result` frame; the immediate acknowledgement remains a compatibility path for older supported binaries.
- Initial and pushed OMP command mappings already preserve `input.hint` as `argumentHint`. Phase 2.5 is now a regression-only gate rather than an implementation task.
- Upstream agent-stream/app changes do not add provider-child ownership labels, retained-child composer gating, multiple batch-child links, OMP `open_url`, or native OMP history/rewind.
- Post-merge focused verification: 211 tests passed across `agent-manager`, provider-child import, Pi, OMP adapter, and OMP subagent suites.

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

## 2.5 Retain command-hint regression coverage

Initial `get_available_commands` and later `available_commands_update` already map `input.hint` to `argumentHint`. Keep the existing tests and add this behavior to the real OMP E2E matrix; no production change is currently required.

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

Scenarios (14 tests):

1. prompt, tool execution, and resume;
2. always-ask multiline approval;
3. interrupt and active steer;
4. todo lifecycle plus `task.batch`;
5. single task child timeline, terminal ownership, and follow-up;
6. identical child IDs from two parents;
7. detached task;
8. isolated task;
9. nested task;
10. parent archive during child import;
11. parent process exit and daemon restart;
12. OAuth `open_url`;
13. native rewind and reload;
14. native Paseo host tools and cancellation.

Verification on 2026-07-13:

- `npx vitest run packages/server/src/server/daemon-e2e/omp.real.e2e.test.ts --bail=1`
- 14 tests passed against credentialed OMP 16.3.9+.

## Manual gates

Verify on web, Electron, iOS, and Android:

- composer/detach/interrupt gating;
- device-local OAuth link opening;
- ten-child fan-out performance;
- parent archive and detach behavior;
- restart during running and retained-idle states;
- batch links and nested navigation.

Verification on 2026-07-13:

- Shared cross-platform ownership logic: 77 tests passed across six focused app test files
  covering composer gating, archive, detach, subagent selection, tool details, and workspace-deck
  retention.
- Browser web: 16 Playwright tests passed across `composer-attachments.spec.ts`,
  `archive-tab.spec.ts`, and `workspace-model-restart.spec.ts`. The focused
  `subagent-detach.spec.ts` gate also passed on retry after one timing failure.
- Electron platform resolution: 19 Playwright tests passed and 2 were skipped across the same
  four specs with `E2E_DESKTOP_RUNTIME=1`. This exercises Electron-specific app modules in
  Chromium; it is not a real Electron process.
- Native iOS and Android remain unverified. This Linux workstation has no Android SDK/`adb`, no
  Maestro installation, and no attached native target; iOS execution is unavailable.
- OMP remains disabled by default until device-local OAuth, native ownership/navigation, and
  real Electron behavior are exercised on their actual runtimes. Browser emulation is not an
  acceptable substitute for those rollout gates.

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
| Command hints                      |       verified; regression-only gate |
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
