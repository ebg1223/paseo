# RUNBOOK — Phase 5: long tail (safe items) + rollout

Executes [05-long-tail.md](05-long-tail.md) EXCEPT the enable-by-default flip, which stays
gated behind D3 ([RUNBOOK-d3.md](RUNBOOK-d3.md), deferred 2026-07-08). Follows Phase 4
(committed, CI-green).

## In scope (this pass)

- **§1 Provider identity** — omp icon (`packages/app/src/components/icons/` + registration
  in `provider-icons.ts`; port the mark from `~/oh-my-pi/assets/` if present, else a simple
  wordmark glyph flagged for a taste pass) + manifest copy (label "Oh My Pi", first-class
  description).
- **§3 Notices / goals / retry telemetry** — map omp session events onto existing surfaces
  (all optional, non-breaking): `notice` → provider notice/timeline; `goal_updated` →
  provider notice; `auto_retry_start/end`, `retry_fallback_applied/succeeded` → status-line
  notices; `auto_compaction_start/end` → existing compaction timeline item; exotic events
  (`ttsr_triggered`, `irc_message`, memory) log-and-drop.
- **§4 Model roles** — pass through omp `smol`/`slow`/`plan` role flags via provider
  `params` (config escape hatch → launch flags); no UI.
- **§5 Derived custom providers** — `extends: "omp"` works like `extends: "pi"`; add a test
  mirroring the pi-derived one.
- **§6 Docs** — rewrite omp paragraphs in `providers.md`, `custom-providers.md`,
  `agent-lifecycle.md` (provider-managed child agents), `glossary.md` (term ruling:
  "subagents"; "child agent" stays internal).
- **§7 CI** — pin the omp binary onto CI runners (mirror other provider binaries) at the
  fixture/e2e version 16.3.9; a scheduled bump job keeps drift visible. (e2e config already
  wired in Phase 2.)

## Explicitly OUT of scope

- **§2 Quota fetcher** — evaluate; omp aggregates per-provider API keys, so likely nothing
  coherent to show → skip cleanly with a one-line note (don't force it).
- **§8 enable-by-default flip** — DEFERRED, gated behind D3. omp stays
  `enabledByDefault: false`.

## State

- [x] Implement (codex xhigh) — the in-scope items above; do NOT flip enable-by-default.
- [ ] Full independent review (opus).
- [ ] Adjudicate → fix → commit → CI.
- Review fixes (2026-07-08): removed dead provider-notice output/export, pruned compaction
  dead fields, kept compaction-end as `completed` due wire enum, and made the OMP mark
  theme-color adaptive.

### Phase 5 implementation note — 2026-07-08

- **§1 Provider identity:** OMP manifest copy now uses label "Oh My Pi" and first-class
  provider description; `enabledByDefault` remains `false`. The app icon is a real port of
  the MIT-licensed `~/oh-my-pi/assets/icon.svg` mark, not a placeholder.
- **§2 Quota fetcher decision:** skipped. `omp usage --help` and upstream
  `packages/coding-agent/src/cli/usage-cli.ts` describe an aggregate per-provider,
  per-account usage report, not a single coherent OMP plan/credit contract for Paseo's
  provider-usage surface.
- **§3 Notices/goals/retry telemetry:** event shapes were verified against upstream
  `packages/wire/src/index.ts`, `packages/coding-agent/src/session/agent-session.ts`, and
  `python/omp-rpc/src/omp_rpc/protocol.py`/tests. Mapped `notice`, `goal_updated`,
  `auto_retry_start`, `auto_retry_end`, `retry_fallback_applied`,
  `retry_fallback_succeeded`, `auto_compaction_start`, and `auto_compaction_end`. Exotic
  `ttsr_triggered`, `irc_message`, `todo_auto_clear`, and `memory_*`/`mnemopi_*` events
  log-and-drop; unknown OMP extras log-and-drop after Pi-shared handles standard Pi events.
- **§4 Model roles:** provider params `smolModel`, `slowModel`, and `planModel` pass through
  to OMP launch flags `--smol`, `--slow`, and `--plan`.
- **§5 Derived custom providers:** `extends: "omp"` now has a registry test covering command,
  env, and params override flow into `OmpRpcAgentClient`.
- **§6 Docs:** updated `docs/providers.md`, `docs/custom-providers.md`,
  `docs/agent-lifecycle.md`, and `docs/glossary.md` for the dedicated OMP adapter,
  `rpc-ui` approvals, native host tools, provider-managed subagents, and terminology.
- **§7 CI binary:** CI provider-test install steps now install
  `@oh-my-pi/pi-coding-agent@16.3.9`, which provides the `omp` binary. No scheduled
  provider-binary version-bump workflow was found in `.github/workflows/`.
- **Verification:** targeted vitest passed for `providers/omp/event-mapper.test.ts`,
  `providers/omp/agent.test.ts`, `provider-registry.test.ts`, and
  `providers/pi/agent.test.ts` (final combined pass: 4 files / 104 tests). `npm run
build:client` refreshed stale protocol output before rerunning the registry test. `npm run
format`, `npm run lint`, and `npm run typecheck` passed.
- **Manual verify:** live-capture the 8 telemetry events over rpc-ui to confirm arrival +
  rendering (currently verified against upstream types only).
- **Deviations:** no live OMP fixture was captured because source and installed
  `omp/16.3.9` help output were sufficient for the safe long-tail items.

## Verification gates

Targeted vitest per touched file, pi suites green, typecheck/lint/format, CI push. App icon
gets a visual check. No wire-schema changes; manifest copy/params additive only.
