# D3 native branch recon

Date: 2026-07-08. Branch: `feat/pi-native-subagents`.

Scope: verification and mapping only. No source implementation changes. Live `omp`
was run in `/tmp` and the Paseo daemon on port 6767 was not touched.

## Deliverables written

- `packages/server/src/server/agent/providers/omp/__fixtures__/native_branch.json`
- `packages/server/src/server/agent/providers/omp/__fixtures__/get_branch_messages.json`
- `packages/server/src/server/agent/providers/omp/__fixtures__/session_entries_ids.json`

Each fixture has an embedded `readmeNote` instead of modifying the existing fixture
README, to keep writes limited to fixture JSON plus this report.

## Native RPC verdict

### `branch`

Verdict: works, but D3 should describe it as "branch before a user entry into a
new session file", not as an in-place tree rewind.

Upstream shape:

- Request: `{ id?: string; type: "branch"; entryId: string }`
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:76`.
- Success response: `{ id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }`
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:267`.
- Implementation: `AgentSession.branch(entryId)` requires `entryId` to name a
  `type:"message"` user entry, returns the selected user text, clears pending
  work, flushes, then:
  - if the selected user entry has no parent, starts a new session with
    `parentSession` pointing at the previous session file;
  - otherwise creates a new session file containing only the path to
    `selectedEntry.parentId`.
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/session/agent-session.ts:14759-14825`.

Live capture:

- Fixture: `native_branch.json`.
- Request: `{ "id": "req_9", "type": "branch", "entryId": "60493110" }`.
- Response: `{ "id": "req_9", "type": "response", "command": "branch", "success": true, "data": { "text": "Reply exactly: ONE", "cancelled": false } }`.
- Before branch, `get_branch_messages` returned user entries `60493110` and
  `9e941ebe`.
- After branching to first user entry `60493110`, `get_state.sessionFile`
  changed from:
  `/tmp/omp-d3-live.lh3m2j/sessions/2026-07-08T04-59-47-934Z_019f4018-b15e-7000-86ba-7867c6c04779.jsonl`
  to:
  `/tmp/omp-d3-live.lh3m2j/sessions/2026-07-08T04-59-51-594Z_019f4018-bfaa-7000-9188-5a9d5652d36d.jsonl`.
- The new branch session file carried the original model/thinking entries
  (`b83c2ef7`, `e26f9d41`) and then the new prompt `BRANCHED`; it did not carry
  the selected user message `ONE`.

Meaning for Paseo rewind: this reproduces the "rewind to before this user
message" behavior, but through a new session file and returned editor text.
Paseo's current `AgentSession.revertConversation(input): Promise<void>` has no
return channel for the `text` field, so an omp adapter that simply calls
`branch(entryId)` will not prefill/resubmit the selected message unless a local
provider-side workaround is added.

### `get_branch_messages`

Verdict: works for branch selector IDs, but it does not return full session
entries and does not expose `parentId`.

Upstream shape:

- Request: `{ id?: string; type: "get_branch_messages" }`
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:77`.
- Success response: `{ id?: string; type: "response"; command: "get_branch_messages"; success: true; data: { messages: Array<{ entryId: string; text: string }> } }`
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:271-273`.
- Implementation scans all session entries, keeps user `message` entries, and
  returns `{ entryId: entry.id, text }`.
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/session/agent-session.ts:15113-15125`.

Live capture:

- Fixture: `get_branch_messages.json`.
- Empty session response: `messages: []`.
- After two turns: `messages: [{ entryId: "60493110", text: "Reply exactly: ONE" }, { entryId: "9e941ebe", text: "Reply exactly: TWO" }]`.
- After `branch("60493110")`, before new prompt: `messages: []`.
- After new branch prompt: `messages: [{ entryId: "560a4638", text: "Reply exactly: BRANCHED" }]`.
- After `switch_session` back to the original file: original IDs `60493110`,
  `9e941ebe` returned again.

### `switch_session`

Verdict: works and is the native way to move between existing session files.

Upstream shape:

- Request: `{ id?: string; type: "switch_session"; sessionPath: string }`
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:75`.
- Success response: `{ id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }`
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:266`.

Live capture:

- Fixture: `native_branch.json`.
- Request `req_17` switched back to the original session file.
- Response: `{ cancelled: false }`.
- Subsequent `get_state` returned the original session id
  `019f4018-b15e-7000-86ba-7867c6c04779`, message count `4`, and original
  branch messages.

### `get_messages` and session entries

Verdict: D3's wording is partly wrong. Session-file entries carry stable
`id`/`parentId`; `get_messages` does not.

Upstream shape:

- Request: `{ id?: string; type: "get_messages" }`
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:83`.
- Success response: `{ id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }`
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts:286`.
- Session entries: `SessionEntryBase` has `{ type: string; id: string; parentId: string | null; timestamp: string }`; `SessionMessageEntry` wraps `message: AgentMessage`.
  - Source: `/home/fedora/oh-my-pi/packages/coding-agent/src/session/session-entries.ts:23-31`.

Live capture:

- Fixture: `session_entries_ids.json`.
- `get_messages` responses for `req_7`, `req_15`, and `req_19` had no top-level
  `id` or `parentId` on any `AgentMessage`.
- The JSONL session entries did carry stable ids and parent links:
  - `60493110` parent `e26f9d41`, user `Reply exactly: ONE`
  - `61369a47` parent `60493110`, assistant `ONE`
  - `9e941ebe` parent `61369a47`, user `Reply exactly: TWO`
  - `c3ecdb43` parent `9e941ebe`, assistant `TWO`
  - branch session `560a4638` parent `e26f9d41`, user `Reply exactly: BRANCHED`

Implication: native omp history mapping should read IDs from `get_branch_messages`
for user-message rewind targets and/or parse the `sessionFile` JSONL. It cannot
build a full stable message trail from `get_messages` alone.

## Rewind semantics comparison

Current pi-shared rewind:

- `streamHistory()` forces `requestEntryCapture("history")`, then passes
  `capturedUserEntries` into `streamPiHistory()`.
  - `packages/server/src/server/agent/providers/pi-shared/agent.ts:1335-1342`.
- Live user messages are buffered in `pendingUserMessages`; an extension capture
  assigns the new stable entry id and emits the `user_message` timeline item with
  `messageId`.
  - `packages/server/src/server/agent/providers/pi-shared/agent.ts:2130-2138`,
    `1770-1790`.
- `revertConversation({ messageId })` captures entries, validates the message id
  exists, calls `/paseo_tree`, and sets `currentLeafOverrideId` to the target
  entry's parent.
  - `packages/server/src/server/agent/providers/pi-shared/agent.ts:1438-1457`.
- `/paseo_tree` calls `ctx.navigateTree(targetId, { summarize: false })`.
  - generated extension:
    `packages/server/src/server/agent/providers/pi-shared/agent.ts:728-742`.

Native omp:

- `branch(entryId)` is closest to the bridge's `/paseo_tree` path for user
  entries because both select the state before the user message.
- It differs operationally: `navigateTree` stays in one tree/session file;
  `branch` creates a new session file and changes `state.sessionFile`.
- The app/server rewind RPC returns `void`:
  `packages/server/src/server/agent/rewind/rewind.ts:11-21`,
  `packages/server/src/server/agent/agent-sdk-types.ts:642`.
  Native omp's returned `text` currently has nowhere to go.

## Bridge extraction map

Inventory: 18 bridge-owned items across 5 production files/areas, plus fake
runtime/test assertions. Worst coupling is `PiRpcAgentSession` private state:
`capturedUserEntries`, `capturedUserEntriesById`, `seenUserEntryIds`,
`pendingUserMessages`, `pendingExtensionResults`, `currentLeafOverrideId`,
`activeToolCalls`, `state`, `runtimeSession`, and `extensionTimeoutMs`.

| Item                                                                                                           | Current location                                                                        | What it does                                                                                                                                | Private state / dependencies                                                                                                      | D3 destination                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge constants `paseo_tree`, `paseo_capture_entries`, `PASEO_ENTRY_CAPTURE`, `PASEO_COMMAND_RESULT`, timeout | `pi-shared/agent.ts:93-97`, params at `103-107`                                         | Names slash commands, marker prefixes, and timeout.                                                                                         | `extensionTimeoutMs`, parser helpers.                                                                                             | Pi-only bridge module.                                                                                                                                           |
| `createPiPaseoExtensionFile()`                                                                                 | `pi-shared/agent.ts:660-748`                                                            | Generates `.mjs` extension; captures user entries; registers `/paseo_capture_entries` and `/paseo_tree`; emits notify markers.              | Temp-file cleanup; hard-coded markers and command names.                                                                          | Pi-only launch artifact hook.                                                                                                                                    |
| Extension injection on create                                                                                  | `pi-shared/agent.ts:2262-2283`                                                          | Always creates extension and passes `extensionPaths: [paseoExtension.path]`.                                                                | `prepareMcpConfig`, cleanup combine, runtime start input.                                                                         | Pi dialect supplies extension; omp supplies none.                                                                                                                |
| Extension injection on resume                                                                                  | `pi-shared/agent.ts:2324-2344`                                                          | Same as create for resumed sessions.                                                                                                        | Resume config, cleanup combine.                                                                                                   | Same hook as create.                                                                                                                                             |
| `PiStartSessionInput.extensionPaths` / launch arg                                                              | `pi-shared/runtime.ts:22-37`, `134-135`                                                 | Converts extension paths to `--extension` args.                                                                                             | Shared runtime launch shape.                                                                                                      | Keep core capability, but only pi passes paths. Omp launch should assert no extension.                                                                           |
| Marker parser dispatch                                                                                         | `pi-shared/agent.ts:1825-1834`                                                          | Intercepts `extension_ui_request` notify frames before normal permission mapping.                                                           | `handleEntryCaptureMarker`, `handleCommandResultMarker`, permission state.                                                        | Pi-owned event handler; omp keeps RPC-UI permission mapping without marker parsing.                                                                              |
| Entry capture parser                                                                                           | `pi-shared/agent.ts:1795-1806`                                                          | Parses `PASEO_ENTRY_CAPTURE`, records entries, resolves pending result.                                                                     | `capturedUserEntries*`, `pendingExtensionResults`.                                                                                | Pi-owned history capture implementation.                                                                                                                         |
| Command result parser                                                                                          | `pi-shared/agent.ts:1808-1822`                                                          | Parses `PASEO_COMMAND_RESULT`, resolves/rejects pending extension command promises.                                                         | `pendingExtensionResults`.                                                                                                        | Pi-owned command bridge.                                                                                                                                         |
| Captured-entry state machine                                                                                   | `pi-shared/agent.ts:1228-1232`, `1757-1790`                                             | Maintains last captured tree and assigns captured IDs to buffered live user messages.                                                       | `capturedUserEntries`, `capturedUserEntriesById`, `seenUserEntryIds`, `pendingUserMessages`.                                      | Pi-owned `HistoryIdentityBridge`; omp native path should not share this state.                                                                                   |
| `requestEntryCapture()`                                                                                        | `pi-shared/agent.ts:1712-1719`                                                          | Sends slash command and waits for marker result.                                                                                            | `runtimeSession.prompt`, `waitForExtensionResult`, timeout.                                                                       | Pi-only capture hook.                                                                                                                                            |
| `wait/resolve/rejectExtensionResult()`                                                                         | `pi-shared/agent.ts:1721-1755`                                                          | Correlates extension command results.                                                                                                       | `pendingExtensionResults`, `extensionTimeoutMs`.                                                                                  | Pi-only command bridge.                                                                                                                                          |
| `streamHistory()` dependency                                                                                   | `pi-shared/agent.ts:1335-1342`                                                          | Requires entry capture before history mapping.                                                                                              | `runtimeSession.getMessages`, `capturedUserEntries`, dialect hooks.                                                               | Dialect hook: pi captures then maps; omp maps from native session entries/branch messages.                                                                       |
| `PiHistoryMapper` user id pairing                                                                              | `pi-shared/history-mapper.ts:12-15`, `54-61`, `94-109`, `239-246`                       | Assigns `messageId` to user messages by ordinal against captured user entries.                                                              | Captured entry order must match `getMessages()` user order.                                                                       | Pi can keep as-is; omp should not rely on this for full native identity.                                                                                         |
| Live user message capture                                                                                      | `pi-shared/agent.ts:2130-2138`                                                          | Buffers user text at `message_end` and triggers capture to emit the timeline item with provider id.                                         | `activeTurnId`, `pendingUserMessages`, `requestEntryCapture`.                                                                     | Pi-only; omp needs a native way to emit user `messageId` after session entry exists. If no event includes id, parse session file after `message_end`/`turn_end`. |
| `revertConversation()`                                                                                         | `pi-shared/agent.ts:1438-1457`                                                          | Validates captured id, runs tree command, sets current leaf override, clears active tool calls.                                             | `activeTurnId`, `state`, `capturedUserEntriesById`, `currentLeafOverrideId`, `activeToolCalls`.                                   | Dialect hook: pi bridge implementation unchanged; omp calls native `branch`.                                                                                     |
| `runPiTreeExtensionCommand()`                                                                                  | `pi-shared/agent.ts:1460-1465`                                                          | Calls `/paseo_tree <base64>` and waits for command result.                                                                                  | `runtimeSession.prompt`, `pendingExtensionResults`.                                                                               | Pi-only.                                                                                                                                                         |
| `revertPiConversation()` / `PiRewindNavigator`                                                                 | `pi-shared/rewind.ts:1-14`; re-export in `providers/pi/rewind.ts:1-2`                   | Thin validation wrapper around navigator.                                                                                                   | None except target id.                                                                                                            | Move to `providers/pi/` with bridge, or inline into pi bridge.                                                                                                   |
| MCP adapter probe                                                                                              | `pi-shared/agent.ts:2457-2470`, `2493-2509`                                             | If dialect lacks native MCP support, starts a probe session and checks commands for `pi-mcp-adapter`.                                       | `runtime.startSession`, `getCommands`, logger. Probe currently also inherits shared launch behavior through FakePi/buildPiLaunch. | Dialect hook: pi probe path only; omp uses `supportsMcpServers: true` and writes config directly.                                                                |
| RPC-UI permission handling entanglement                                                                        | `pi-shared/agent.ts:1825-1848`; OMP mapper imports in `omp/rpc-ui-permission-mapper.ts` | Normal `extension_ui_request` frames are also real permission UI. Marker frames are distinguished only by `method:"notify"` message prefix. | `pendingExtensionUiRequests`, ask-user combine state, dialect permission mapper.                                                  | Split marker bridge before generic permission mapping, but leave generic RPC-UI permission handling shared or copied for omp.                                    |
| Fake runtime bridge simulation                                                                                 | `pi-shared/test-utils/fake-pi.ts:62-68`, `105`, `317-373`                               | `FakePi` uses `buildPiLaunch`, simulates `/paseo_tree`, capture markers, command-result markers.                                            | Test helper state `capturedUserEntries`, `treeNavigationRequests`.                                                                | Pi test utility or dialect-configurable fake; omp tests should stop expecting extension injection.                                                               |

External/test consumers:

- Pi tests assert extension injection and rewind bridge behavior:
  `packages/server/src/server/agent/providers/pi/agent.test.ts:569`,
  `599`, `645`, `845`, `1117-1126`, `1180`, `1234`.
- Omp tests currently still assert `--extension` and therefore must change under
  D3:
  `packages/server/src/server/agent/providers/omp/agent.test.ts:440`,
  `509`.
- Omp history tests currently import shared `streamPiHistory`:
  `packages/server/src/server/agent/providers/omp/history-mapper.test.ts:4`.
- Omp virtual child sessions delegate `streamHistory()` and
  `revertConversation()` to the parent/delegate:
  `packages/server/src/server/agent/providers/omp/virtual-child-session.ts:152-155`,
  `272-275`.

## Seam proposal

Goal: make the extension bridge pi-dialect-owned without changing pi behavior.

Recommended hooks:

1. `buildLaunchArtifacts(input): { extensionPaths?: string[]; cleanup?: () => void }`
   - Pi default: call today's `createPiPaseoExtensionFile()` and pass the path.
   - Omp: return no extension paths.
   - Keep `PiRuntimeLaunch.extensionPaths` support in shared runtime so the pi
     path remains byte-for-byte equivalent.

2. `captureHistoryEntries(session, reason): Promise<readonly CapturedUserEntry[]>`
   - Pi: today's `requestEntryCapture()` plus `capturedUserEntries`.
   - Omp: call native `get_branch_messages` for branchable user IDs, and parse
     `state.sessionFile` JSONL when parent/assistant ids are needed.
   - Do not make `get_messages` the identity source for omp; live evidence says
     it has no ids.

3. `mapHistory({ messages, state, identitySource })`
   - Pi: today's `streamPiHistory(provider, getMessages(), capturedUserEntries, dialect)`.
   - Omp: new native history mapper that joins `AgentMessage[]` with session
     `message` entries by order/content/timestamp, or reads session entries first
     and maps entries directly.

4. `revertConversation(input, context): Promise<void>`
   - Pi: today's extension-backed `navigateTree` behavior unchanged.
   - Omp: validate target entry is branchable, call `runtimeSession.request({ type: "branch", entryId })`, refresh state, update persistence handle/session file, clear active tool calls. Decide explicitly what to do with returned `text`.

5. `onRuntimeEventForIdentity(event, context): boolean`
   - Pi: marker parsing plus live pending-user-message flush.
   - Omp: native path should update user-message identity from session entries
     after the user entry is persisted. If no live event exposes the entry id,
     perform a bounded session-file read after `message_end`/`turn_end`.

6. `prepareMcpConfig` / `detectMcpCapability`
   - Pi: old probe path for `pi-mcp-adapter`.
   - Omp: no probe; native MCP config is supported by dialect and launch writes
     `--mcp-config`.

Clean native replacements:

- Launch extension: clean. Omp should inject no extension.
- MCP config: clean. Omp already advertises native support.
- Rewind command: mostly clean via `branch(entryId)`, with returned-text and
  new-session-file caveats.
- Branch selector: clean for user IDs via `get_branch_messages`.

Awkward replacements:

- Full message trail identity: awkward. Native session entries have the data, but
  `get_messages` does not. The adapter needs a session-entry reader or a native
  RPC that returns entries.
- Live user message emission: awkward. Today's shared code delays the user
  message until extension capture yields the stable id. Omp needs an equivalent
  native capture moment.
- Rewind UI prefill semantics: awkward. Omp returns selected text but Paseo's
  rewind interface returns `void`.

## Risks

1. D3 wording overstates `get_messages`. It says "session entries with stable
   id/parentId" and lists `switch_session` / session entries / `get_state` /
   `get_messages` together. Verified: session JSONL entries have ids;
   `get_messages` and `get_state` do not expose per-message ids.

2. Rewind parity is not exact. Pi bridge uses `navigateTree` in the same session
   tree and stores `currentLeafOverrideId`. Omp `branch` creates a new session
   file and returns selected user text. The adapter must update persistence and
   decide whether ignoring `data.text` is acceptable.

3. Private-state coupling is high. The bridge is not just launch setup; it is
   tied into `streamHistory`, live event ordering, permission-frame filtering,
   timeout correlation, and rewind state. Extracting only
   `createPiPaseoExtensionFile()` would leave marker assumptions in shared code.

4. `get_branch_messages` returns all user entries from `getEntries()`, not only
   the current branch. That is fine for a branch selector, but if the adapter uses
   it as the only identity index it may expose ids for abandoned branches too.

5. Session-file parsing needs file freshness discipline. Native entries are
   stable after persistence, but a live turn may have pending writes. Use
   `turn_end`/`agent_end` or explicit state refresh before treating JSONL as
   complete.

## Commands run against omp

Version/discovery:

```bash
omp --version
omp --help
```

Failed fully isolated probe, useful negative evidence that a throwaway `HOME`
has no models/auth:

```bash
HOME="$tmp/home" PI_CONFIG_DIR=.omp XDG_DATA_HOME="$tmp/xdg-data" XDG_STATE_HOME="$tmp/xdg-state" XDG_CACHE_HOME="$tmp/xdg-cache" node -e 'spawn("omp", ["--mode", "rpc"], ...)'
```

Live authenticated probe, with sessions forced into `/tmp` and extension
discovery disabled:

```bash
omp --mode rpc \
  --cwd /tmp/omp-d3-live.lh3m2j/work \
  --session-dir /tmp/omp-d3-live.lh3m2j/sessions \
  --no-extensions \
  --no-tools \
  --approval-mode yolo \
  --append-system-prompt "For this verification run, answer with exactly the requested short token and no extra text."
```

RPC stdin sequence in the live probe:

```text
get_state
get_messages
get_branch_messages
prompt "Reply exactly: ONE"
prompt "Reply exactly: TWO"
get_state
get_messages
get_branch_messages
branch { entryId: "60493110" }
get_state
get_messages
get_branch_messages
prompt "Reply exactly: BRANCHED"
get_state
get_messages
get_branch_messages
switch_session { sessionPath: originalSessionFile }
get_state
get_messages
get_branch_messages
```

No `omp --mode rpc` processes remained after the probes.
