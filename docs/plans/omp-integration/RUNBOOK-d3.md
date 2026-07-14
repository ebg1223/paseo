# RUNBOOK — D3: kill the extension bridge for omp (native branch/rewind)

Executes design decision D3 from [README.md](README.md): the omp adapter stops injecting the
generated `.mjs` extension bridge and reimplements rewind + history-entry capture on omp's
native `branch` / `get_branch_messages` / `switch_session` RPCs. The bridge machinery
(extension file, `PASEO_ENTRY_CAPTURE`/`PASEO_COMMAND_RESULT` marker capture, `paseo_tree`
rewind, MCP-adapter probe) relocates from `pi-shared/` into `providers/pi/` and becomes
pi-only. Follows Phase 4 (committed). Must land BEFORE Phase 5's enable-by-default flip.

## Why now / why it was deferred

D1 deliberately kept the extension bridge in the shared core (used by both pi and omp,
tagged `D3(omp-native-branch)`) because dropping it mid-extraction would have mixed a
behavior change into a behavior-preserving refactor. D3 is that deferred behavior change:
omp goes native, pi keeps the bridge. `rg "D3(omp-native-branch)"` lists the relocation
sites.

## Invariants

1. **pi byte-for-byte unaffected.** pi keeps the extension bridge exactly as today; pi
   suites are the regression gate. This is the same make-or-break invariant as D1.
2. `pi-shared/` imports neither adapter; the bridge becomes pi-dialect-owned (hooks) so pi
   supplies it and omp supplies native equivalents.
3. No wire-protocol changes; no packages/app changes (the message-trail / rewind UI already
   consumes whatever the provider emits).
4. omp rewind + history-entry identity must be behaviorally equivalent to what the bridge
   produced — verified against live omp, not just unit fakes (rewind parity is the hard part).

## State

- [x] Recon DONE 2026-07-08 (`573729e0`): [recon/d3-native-branch-recon.md](recon/d3-native-branch-recon.md),
      3 live fixtures. **Verdict: D3 is not the clean win the plan assumed — native surface
      diverges from the premise.** Key findings: - `branch {entryId}` works but creates/switches to a NEW session file and returns the
      selected user `text` — Paseo's `revertConversation(): Promise<void>` has no channel
      for that text (no prefill), and the persistence handle changes on rewind. This is a
      different rewind model than pi's in-place `navigateTree`+`currentLeafOverrideId`. - Message-trail identity is WORSE over RPC, not better: `get_messages`/`get_state`
      carry NO per-message ids; stable id/parentId live only in the session JSONL file.
      So native omp history identity requires session-file parsing (with pending-write
      freshness hazards) or `get_branch_messages` (user entries only, no parentId,
      includes abandoned branches) — arguably new fragility replacing the marker capture. - High coupling: 18 bridge items tied into streamHistory, live event ordering,
      permission-frame filtering, timeout correlation, and rewind state.
- [x] **DECISION 2026-07-08 (maintainer): DEFER D3.** Do Phase 5's safe long-tail now; keep
      the enable-by-default flip gated behind D3. Rationale: recon showed D3 replaces a
      working (if fragile) injected extension with a large extraction that introduces
      _different_ fragility (session-file parsing) AND changes rewind UX (new session file,
      no prefill). Not worth rushing into this session. D3 becomes its own effort, and
      needs app-side work first (a return channel on `revertConversation` for the branch
      prefill `text`, and a decision on new-session rewind semantics) — possibly an upstream
      ask for a native "session entries with ids" RPC to avoid file-scraping.
- [ ] (Deferred) Seam spec — the recon's proposed dialect hooks are a starting point.
- [ ] (Deferred) Implement / review / commit / live-verify.
- [ ] (Blocked on D3) Phase 5 enable-by-default flip.

## Verification gates

Targeted vitest per touched file, pi suites as the regression gate, typecheck/lint/format,
CI push. Live rewind round-trip on real omp before this is called done.
