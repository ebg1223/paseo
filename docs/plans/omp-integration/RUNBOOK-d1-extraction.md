# RUNBOOK — D1 extraction: shared pi core, dedicated omp adapter

Executes design decision D1 from [README.md](README.md): `omp` gets its own adapter
(`providers/omp/`) on a shared transport/mapping core extracted from `providers/pi/`.
Follow-up to the phase-3 child-agents work (see
[RUNBOOK-child-agents.md](RUNBOOK-child-agents.md)), which deliberately parked omp
features inside the pi adapter ahead of this split.

## Goal

- `providers/pi/` and `providers/omp/` are thin adapters over a shared core.
- pi keeps: injected `.mjs` extension bridge, `PASEO_ENTRY_CAPTURE`/`PASEO_COMMAND_RESULT`
  marker capture, stock RPC dialect.
- omp owns: subagent index, virtual child sessions, `child_session` emission,
  `<system-notice>` absorption (`omp-system-notice.ts`), `omp-poll:` callId coalescing,
  `get_available_commands` dialect, `~/.omp/agent/sessions`.
- Registry (`provider-registry.ts`): `omp` factory constructs the omp adapter, not
  `PiRpcAgentClient` with params.

## Invariants (non-negotiable)

1. **pi is byte-for-byte unaffected.** Existing pi test suites are the regression gate;
   no pi test may change to pass. (Exception already landed pre-split: custom messages
   replay as assistant text — that is a pi bug fix, keep it in the shared core.)
2. No wire-protocol schema changes. No client/app changes.
3. omp gating becomes explicit adapter identity, not marker sniffing where avoidable —
   but marker-gated absorption of `<system-notice>` stays marker-gated _within the omp
   adapter_ (it is content, not capability).
4. No probing/fallback between dialects (both runtimes turn unknown-command mismatches
   into timeouts — see `docs/providers.md`).

## State

- [x] Phase-3 omp features landed inside `providers/pi/` (commit `2894e855`).
- [x] Recon inventory complete: [recon/d1-extraction-inventory.md](recon/d1-extraction-inventory.md)
      (codex/gpt-5.5, agent `c2a0d76e`).
- [x] Extraction spec written (below).
- [x] Persistence identity investigated before code moves: raw `PiRpcAgentSession`
      currently emits `describePersistence().provider === "pi"` and metadata `{ cwd, model?,
thinkingOptionId? }`; registry `wrapSessionProvider` rewrites the outward handle provider
      to the registry id (`"pi"` or `"omp"`). Registry create/resume/import calls pass inner
      configs/handles with `provider: inner.provider`, then map runtime info, stream events, and
      import persistence back to the outer provider. The split must preserve raw Pi-core handles
      as `"pi"` and rely on the wrapper for outer `"omp"` persisted records.
- [x] Implementation completed in working tree: Pi-lineage runtime/session/mappers moved to
      `providers/pi-shared/`, Pi adapter restored as a thin wrapper, and `providers/omp/` now owns
      OMP dialect hooks, subagent types/runtime wrappers/index/virtual session/system notices/poll
      IDs. Deviation recorded for review: `rewind.ts` implementation lives in `pi-shared` with a
      Pi wrapper so shared core does not import `providers/pi/`.
- [x] Registry updated: built-in `omp` now constructs `OmpRpcAgentClient`; `commandsRpcType`
      removed from registry construction. OMP adapter owns `argv: ["omp"]`, default session dir,
      and `get_available_commands`.
- [x] Verification green: targeted touched/moved Vitest files passed; `npm run typecheck`,
      `npm run format`, and `npm run lint` passed.
- [x] Independent review fix applied: #1 fixed with coverage by sharing
      `providers/omp/history-hooks.ts` between the OMP dialect and virtual child sessions; #2
      accepted as persisted-bytes deviation per review adjudication; #3 deferred with the D3 tags.
- [x] Independent review complete (claude/opus-4.8, agent `9bb0cfb4`): fix-then-ship.
      Lens verdicts: pi preservation CLEAN (only the permitted subscription delta), seam
      quality CLEAN, persistence CLEAN, test migration CLEAN, type hygiene CLEAN. Finding
      #1 (virtual-child transcript lost omp hooks) fixed with coverage; #2 (imported child
      records persist `metadata.provider: "omp"`, was `"pi"`) accepted — verified inert, no
      reader consumes it; #3 (`as OmpRuntimeEvent` casts, pre-split-equivalent) deferred.
- [ ] Commit + push; full suite and pi real e2e run in CI (the pi regression gate).

## Plan (extraction spec)

Read [recon/d1-extraction-inventory.md](recon/d1-extraction-inventory.md) first — it has
the per-symbol classification, the `agent.ts` deep map, external consumers, and risks this
spec responds to.

### Ruling: behavior-preserving for BOTH providers

The extension bridge is injected unconditionally for pi _and_ the omp alias today, and omp
(a pi fork) runs it. Dropping it from omp now would mix a behavior change into a structural
refactor. So: **the `.mjs` extension bridge, marker capture, rewind, and MCP-adapter probing
stay in the shared core for this extraction**, used by both adapters, tagged with a
`// D3(omp-native-branch):` note. D3 later moves them into the pi adapter when omp switches
to native `branch` RPCs. The only permitted observable delta from this refactor: pi stops
sending the best-effort `set_subagent_subscription` on session start (today it gets an
unknown-command error and a debug log) — that call becomes omp-only.

### Target layout

```
providers/pi-shared/            # dialect-free core; MUST NOT import from providers/pi/ or providers/omp/
  cli-runtime.ts                # spawn/JSONL/id-correlation + stock-pi command wrappers;
                                #   exposes a generic typed request() escape hatch; subagent
                                #   wrappers REMOVED; forwards unrecognized well-formed frames
                                #   to a dialect-provided handler instead of typing omp frames
  rpc-types.ts                  # stock pi shapes only (omp subagent types move out)
  history-mapper.ts             # + hooks (see Dialect seam)
  tool-call-mapper.ts           # poll coalescing removed (moves to omp)
  agent.ts (or session/client split)  # shared session+client parameterized by PiDialect;
                                #   includes extension bridge & compaction & permission UI (per ruling)
  session-descriptor.ts         # pi-shaped scanner, used by both (behavior-preserving)
  test-utils/fake-pi.ts         # stays shared incl. subagent/extension knobs (test util pragmatism)
providers/pi/
  agent.ts                      # pi dialect (all defaults) + PiRpcAgentClient wiring
  rewind.ts                     # stays
providers/omp/
  agent.ts                      # omp dialect + OmpRpcAgentClient
  rpc-types.ts                  # subagent commands/frames/types (from pi rpc-types.ts:115-164,178-184,238-239)
  runtime.ts                    # subagent RPC wrappers over the core generic request()
  subagent-index.ts             # moved; rename Pi* -> Omp* symbols
  virtual-child-session.ts      # moved (keep paired with subagent-index — recon risk 9)
  system-notice.ts              # moved from omp-system-notice.ts
  tool-call-id.ts               # readPollTargets + resolveEmittedToolCallId (omp-poll coalescing)
```

Exact file names at implementer's discretion within repo conventions (kebab-case, named
after main export, no barrels). Directory boundaries and the dependency rule are not.

### Dialect seam

`PiDialect` interface defined in `pi-shared`, implemented once per adapter. Keep it small
and mapping/lifecycle-focused; big divergent machinery belongs in adapter-owned objects,
not hooks. Sketch (implementer refines):

- `providerId` — but see Persistence invariant below.
- `commandsRpcName` — `get_commands` (pi) / `get_available_commands` (omp); the
  `commandsRpcType` registry flag dies.
- `sessionDirDefault` — omp: `~/.omp/agent/sessions` (moves out of the registry factory).
- Mapper hooks: `resolveToolCallId(callId, tracked)` (identity default; omp = poll
  coalescing) and `mapCustomMessage(text)` (default: assistant-text item; omp wraps with
  system-notice absorption first). Same hooks feed live path and history replay so the two
  can't drift.
- `handleExtraRuntimeEvent(event, ctx)` — omp consumes `subagent_lifecycle`/
  `subagent_progress` (owns subagentIndex + sessionFile memory in its own state, not in the
  shared session; preserve the sessionFile-by-id fallback — recon risk 8).
- Lifecycle hooks: session start (omp: best-effort subscription), close / process exit
  (omp: `clearParent`; shared core keeps extension-result rejection per ruling).
- Client-side: optional `importSession` interceptor (omp live-subagent path) and
  availability/diagnostic config (keep today's behavior exactly; parameterize only what
  already differs via the alias).

`ctx` is a narrow interface (emit, runtimeSession request access, logger) — dialect hooks
must not reach into shared-session private state.

### Registry

`omp` factory constructs `OmpRpcAgentClient` from `providers/omp/agent.js`. The
`argv: ["omp"]` merge moves into the omp adapter. Registry becomes symmetric and thin.
`provider-registry.test.ts` is the one test whose _meaning_ changes (it currently pins the
alias); update it to pin the new construction.

### Persistence invariant (recon risk 3 — investigate before coding)

Existing persisted agent records (pi and omp, incl. `derivedFromProviderId: "pi"` cases,
see `agent-manager.test.ts:6317`) must load and resume unchanged in both directions — the
data model has no migrations. Verify what `describePersistence` and the registry wrapper
actually emit for omp today and preserve those bytes. If provider identity must be injected,
wire it so today's emissions are reproduced exactly.

### Non-negotiables

1. pi behavior byte-for-byte (except the named subscription delta); pi test files pass with
   mechanical-only updates (import paths, moved omp cases removed).
2. omp behavior also unchanged in this refactor (bridge retained per ruling).
3. `pi-shared` imports from neither adapter directory (recon risk 10).
4. No wire-protocol changes, no client/app changes, no new provider params.
5. omp-specific test cases move from pi test files into `providers/omp/` tests, preserved
   one-for-one (poll coalescing: agent.test.ts:467-527, notices: 547-590, history-mapper
   130-259, tool-call-mapper 78-92, cli-runtime 222-289, plus subagents.test.ts and
   omp-system-notice.test.ts wholesale).

## Verification gates

## Verification gates

- Targeted vitest on every touched/moved test file (`npx vitest run <file> --bail=1`),
  never the full suite locally.
- `npm run typecheck`, `npm run lint`, `npm run format` (npm scripts only).
- Full-suite verification via CI push.

## Rollback

Single-commit revert; no persisted-state or protocol changes involved.
