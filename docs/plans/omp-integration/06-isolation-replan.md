# OMP integration replan — read-only subagents, provider-scoped

Status: **FINAL — approved 2026-07-14.** This is the authoritative landing plan;
execute workstreams in order 1 → 2 → 3 → 4 → 5 → 6. Earlier phase docs and runbooks in
this directory are historical context only where they conflict with this file.

Supersedes the landing strategy of `README.md` phases 1–5 and `RUNBOOK-remediation.md` for
the current `feat/pi-native-subagents` branch. The adapter implementation is largely done;
this plan restructures the branch so the single PR against upstream `getpaseo/paseo` is
maximally reviewable: **all OMP behavior lives in the provider**, and the shared core,
protocol, and app are untouched.

Context: this ships as **one feature-branch PR to an upstream OSS project we do not own**.
That constraint drives every call below — minimize the shared/diff surface a maintainer
must trust, prefer upstream-friendly shapes over fork conveniences, and cut anything that
reads as unrelated.

## Decisions (recorded 2026-07-14)

- **D-R1 — Live subagent rows are non-negotiable.** Deferred visibility ("children appear
  only after completion") was considered and rejected: seeing agents live is the point.
- **D-R2 — Subagents are read-only views, not agent records.** OMP `task` children render
  through the existing `provider_subagent` path — the same first-class treatment Claude,
  Codex, and OpenCode sidechains get: live rows in the subagents track, full streaming
  timeline panes, restart recovery from parent history. They are never promptable through
  Paseo. Consequences:
  - No `child_session` manager seam, no child agent records, no ownership model, no
    prompt/detach/load guards, no virtual sessions, no released-child discovery.
  - The double-open hazard disappears structurally: Paseo never opens a child JSONL while
    the parent may own it. (Recon of the OMP source confirmed this hazard is real and
    host-side only: the session writer opens JSONL with plain append and no lock; the
    terminal `subagent_lifecycle` frame is the only release signal; no RPC command can
    address a running child. See "Upstream facts" below.)
  - This decision was reached by elimination: agent-record children require either
    persisted ownership (forgeable via labels; two P1s found in review) or live-parent
    session locking (sound, but drags a manager import seam with race and status-mapping
    complexity), and the intermediate hybrid (provider_subagent live → import at terminal
    frame) orphans an open read-only pane at the exact moment the user would want to
    reply. Read-only-always is the only variant with zero shared surface and no identity
    discontinuity.
- **D-R3 — Reply-to-a-child happens via manual session import.** A completed child's JSONL
  is an ordinary importable OMP session. Users who want to continue a child conversation
  import it through the existing session-import flow, producing a normal, promptable OMP
  agent. The branch's `session-import-filter.ts` must therefore **keep child session files
  listable** (it currently filters them out) — or filter them by default with a documented
  override; either way the import path is the escape hatch and must work. A one-tap
  "Import as agent" affordance on the read-only pane is a recorded app-side follow-up, not
  part of this PR.
- **D-R4 — Keep the `pi-shared/` extraction, gated by the Pi e2e suite.** Vendoring a
  private transport copy into `providers/omp/` was considered for isolation, but in a
  single upstream PR duplication is a maintenance burden the project would carry.
  Constraints: behavior-preserving for `pi` (its e2e suite is the regression gate); the
  diff should read as move-then-parameterize, not rewrite; intentional Pi-visible changes
  riding along (no-turn slash-command output, custom-message history replay) are
  enumerated in the PR description, not buried.
- **D-R5 — No dynamic Paseo tools in v1 (amended during execution, 2026-07-14).** The
  original intent was to ship host tools via OMP's native MCP client. Execution recon
  found OMP 16.3.9 has **no `--mcp-config` launch flag** — it discovers MCP servers only
  from native user/project config files (`.omp/mcp.json`, user profile), and injecting
  Paseo's dynamic per-session servers would mean mutating user-owned config with
  lifecycle cleanup — unsafe, rejected. The adapter therefore sets
  `supportsMcpServers: false`: no dynamic Paseo MCP tools in v1; user-preconfigured
  native MCP servers still work untouched. Still drops `supportsNativePaseoTools`,
  `tools/mcp-serialization.ts` (whose SDK-internals import forces an exact
  `@modelcontextprotocol/sdk` pin — a hard sell upstream), and `wait_for_agent` from
  this PR. Dynamic tool delivery moves to the follow-ups table.
- **D-R6 — Defer the polish contracts.** `restoredPrompt` (app already falls back to
  `variables.rewoundText`), `notifyTitleChanged`, and `sub_agent.children[]` (which
  carries two app regressions: fabricated `running` status for legacy OpenCode cards and
  cross-server child navigation) are each severable follow-ups. With D-R2 their removal
  makes "no wire-protocol changes, no app changes" literally true.

## Upstream facts (recon of ../oh-my-pi, pinned adapter target 16.3.9)

Recorded because they justify D-R2/D-R3 and should survive into the PR description:

- `subagent_lifecycle` frames carry stable `id`, `sessionFile`, `parentToolCallId`,
  `index`, and `status: started|completed|failed|aborted`. The terminal frame is the
  **only** release signal — there is no ownership/release protocol.
- The session writer appends without any file lock; a second `omp` process can resume a
  still-being-written JSONL with no protocol-level rejection. Any "don't touch live child
  files" rule is host policy; read-only rendering sidesteps it entirely.
- No RPC command addresses a running child (`steer`/`follow_up`/`abort` are parent-only).
  Live children are physically unpromptable regardless of Paseo's design.
- `get_subagents` covers live children only (terminal frames delete snapshots);
  `get_subagent_messages` reads transcripts by `subagentId`/`sessionFile` + byte offset
  (≤256 in-process refs). Historical enumeration is host-side JSONL reading.
- `set_subagent_subscription` is connection-wide (`off|progress|events`); `events` streams
  every child's full `AgentSessionEvent` stream (producer coalesces progress at 150ms).
  Watch daemon CPU with a wide fan-out before enabling `events` unconditionally.

## Branch restructuring — what the single PR contains

### Workstream 1 — subagents become provider_subagent emissions (the main rework)

Replace the child-agent machinery with mapping onto the existing sidechain path:

- Adapter maps `subagent_lifecycle` / `subagent_progress` / `subagent_event` frames to
  `provider_subagent` stream events (`upsert` descriptors keyed on the stable child id;
  `timeline` items from child `AgentSessionEvent`s via the existing history mapper).
  Nested children reuse the same flat descriptor space (parent linkage in the title or
  descriptor metadata; the store is per-parent-agent).
- History replay: during parent history hydration, emit the same `provider_subagent`
  events from the parent JSONL (the manager already restores and broadcasts these —
  `hydrateTimelineFromProvider` — with no changes).
- Inline `sub_agent` tool cards (v1 parity work: `subagent-card-tracker.ts`,
  `tool-call-mapper.ts`) stay, minus the `children[]` field (D-R6) — the card's
  `childSessionId` continues to work with the existing renderer.
- **Delete from the branch:** `virtual-child-session.ts`, `released-session.ts`,
  released/historical child discovery and classification, `child_session` emissions in
  `agent.ts`, and every trace of the ownership model.
- `session-import-filter.ts`: ensure child JSONLs remain importable per D-R3.

### Workstream 2 — revert all shared-core, protocol, and app changes

Remove from the branch (all obsoleted by D-R2/D-R5/D-R6):

- `agent-manager.ts` child-session import seam (`childSessionImportsInFlight`,
  `onStreamChildSession`, `importChildProviderSession`, `reparentHistoricalChildSession`,
  `applyChildSessionStatus`, `waitForChildSessionImports`) and the `child_session` event
  type in `agent-sdk-types.ts`.
- `protocol/agent-labels.ts` ownership vocabulary; guards in `agent-prompt.ts`,
  `agent-loading.ts`, manager detach/interrupt/reload paths.
- All app changes: composer ownership gating, archive/detach/select/track special-casing,
  `agent-snapshots.ts` / `session-store.ts` ownership fields, `tool-call-details.tsx`
  children rendering, rewind `restoredPrompt` plumbing.
- All protocol changes: `sub_agent.children[]`, rewind `restoredPrompt`, ownership labels.
- `supportsNativePaseoTools`, `mcp-serialization.ts`, MCP SDK exact pin, `wait_for_agent`,
  `notifyTitleChanged` (D-R5/D-R6).
- `create-agent-mode.ts` empty-mode-list semantics — unrelated ACP/Pi behavior change; OMP
  has explicit modes and does not need it. Propose separately if wanted.

Net: outside `providers/`, the diff touches only `provider-registry.ts` (factory) and
`provider-manifest.ts` (OMP_MODES `full`/`ask`, label, description; still
`enabledByDefault: false`) — plus docs and CI.

### Workstream 3 — OMP adapter fixes (provider-local)

- Catalog models mapped with the dialect's provider, not hardcoded `"pi"`
  (`pi-shared/agent.ts:1340-1343` takes the provider from the dialect/client).
- A well-formed `todo_auto_clear` maps to `{ type: "todo", items: [] }` instead of being
  dropped (stale-checklist bug); keep the fixture note that upstream currently never
  emits it.
- Re-verify fixtures against the pinned `16.3.9` — upstream moves fast (local checkout is
  already 16.4.x) and the fixture set is the compatibility contract.

### Workstream 4 — CI + real e2e

- Dedicated OMP job only: pinned Bun setup + `@oh-my-pi/pi-coding-agent@16.3.9` + the
  real matrix (`omp.real.e2e.test.ts`). Remove the OMP install from the generic server /
  Playwright / CLI jobs — the npm package's `dist/cli.js` is `#!/usr/bin/env bun`, those
  runners have no Bun, and their `npm run test` excludes `*.real.e2e.test.ts` anyway.
  (Whether upstream CI can run a credentialed OMP job at all is a maintainer
  conversation; if not, the real matrix stays documented as a local gate and CI gets no
  OMP install.)
- Fix the real-test gate: `canRunRealProvider("omp")` currently requires
  `OPENROUTER_API_KEY`, making the Codex-authenticated fallback model unreachable
  (`real-provider-test-config.ts:151-174`). Exempt OMP (or a configured
  `OMP_REAL_TEST_MODEL`) from the OpenRouter requirement.
- Rework the real e2e matrix: drop scenarios that tested ownership/release/child-prompt
  flows; keep prompt/tool/resume, approvals, steer/interrupt, todos, subagent
  lifecycle-to-track rendering, and import-a-completed-child (D-R3 escape hatch).

### Workstream 5 — strip fork/branch noise (mandatory before the upstream PR)

- Delete `.github/workflows/sync-fork-with-upstream.yml` — fork automation hardcoded to
  `ebg1223/paseo`, meaningless and alarming upstream (scheduled `contents: write`).
- Revert `.mise.toml` `node = "latest"` — conflicts with CI's pinned Node 22.
- Regenerate `package-lock.json` minimally — the current +26/−920 is dedupe churn with no
  resolution change; with D-R5 the MCP SDK pin also reverts.
- `docs/plans/omp-integration/` (plans, runbooks, recon, this file): **keep on the branch
  while the restructuring is in progress** — the docs are the working state for
  workstreams 1–4. Removal is the final step, once the branch is finalized: fold the
  factual updates into `docs/providers.md`, `docs/custom-providers.md`,
  `docs/agent-lifecycle.md`, `docs/glossary.md`; move this file's decisions into the PR
  description; then delete the whole `docs/plans/omp-integration/` directory before the
  upstream PR is marked ready (2,900+ lines of branch-local process a maintainer cannot
  review and should not merge).

### Workstream 6 — finalization: mechanical re-branch for the clean PR

Implementation happens on `feat/pi-native-subagents` (the restructuring is mostly
subtractive; redoing the adapter elsewhere would mean porting ~34k lines to avoid
deleting ~3k). Once workstreams 1–5 are done and green, produce the PR branch
mechanically:

1. `git checkout -b feat/omp-provider upstream/main`, then `git checkout
feat/pi-native-subagents -- <path>` for exactly: `providers/` (omp, pi-shared, pi),
   `provider-registry.ts`, `provider-manifest.ts`, the daemon-e2e OMP test files, the CI
   workflow, and the durable doc updates. Nothing else can leak in by construction.
2. Commit in logical units: `pi-shared` extraction → OMP adapter → e2e/CI → docs. The
   current 37-commit history (six upstream merges, runbook status commits, fork-sync
   chore) must not reach the upstream PR; do not assume maintainers squash-merge.
3. Verify: `git diff feat/pi-native-subagents feat/omp-provider --stat` shows only the
   intentionally dropped noise; `git diff upstream/main feat/omp-provider --stat`
   matches the success-criteria path list exactly.
4. Peel off standalone Pi fixes riding on this branch (`585e5d72` complete locally
   handled prompts, `0adf038c` text-only image prompt handling) into their own small
   upstream PRs if they are genuine independent bugs — they shrink this PR's Pi-visible
   delta and stand on their own merits.
5. Last step before marking the PR ready: the docs/plans removal from Workstream 5.

## Follow-ups (post-merge candidates, each independently proposable)

| Candidate                    | Content                                                                                                                                                                                           | Precondition                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "Import as agent" affordance | One-tap import from the read-only child pane (app-only, additive)                                                                                                                                 | D-R3 flow proven                                                                                                        |
| Agent-record children        | Import-on-terminal-frame seam → real resumable child agents, reply-in-pane                                                                                                                        | Own design review; this PR proven in the wild first                                                                     |
| Paseo tools for OMP          | Dynamic MCP injection (needs an upstream OMP `--mcp-config` flag or scoped-config launch mechanism) or native `set_host_tools` + capability flag + MCP serialization + SDK pin + `wait_for_agent` | Upstream OMP launch surface, or own security/API review                                                                 |
| Batch child links            | `sub_agent.children[]` protocol field + renderer                                                                                                                                                  | Fix the two renderer regressions first (no fabricated `running`; lookup scoped to `(serverId, provider, nativeHandle)`) |
| Rewind prompt restore        | `AgentRewindResult.restoredPrompt` through manager/session/protocol/app                                                                                                                           | —                                                                                                                       |
| Title sync                   | `notifyTitleChanged` hook + registry wrapper                                                                                                                                                      | —                                                                                                                       |
| `pi-shared/` follow-through  | Any further transport consolidation                                                                                                                                                               | Pi e2e green                                                                                                            |

## Success criteria

- OMP `task` subagents appear **live** in the subagents track the moment they start,
  stream full timelines in read-only panes, and survive daemon restart via parent-history
  replay — identical treatment to Claude/Codex/OpenCode sidechains.
- A completed child imports through the ordinary session-import flow into a normal,
  promptable OMP agent (the D-R3 escape hatch, exercised by the real e2e matrix).
- Outside `providers/omp/` and `providers/pi-shared/`, the diff touches only:
  `provider-registry.ts`, `provider-manifest.ts`, docs, and CI. **No `agent-manager.ts`,
  no protocol schema, no app changes.**
- The `pi` provider's e2e suite passes unchanged; intentional Pi-visible deltas are
  enumerated in the PR description.
- Nothing in the diff references the fork (`ebg1223/*`) or branch-local process.
