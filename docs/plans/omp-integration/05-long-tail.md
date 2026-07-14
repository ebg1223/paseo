# Phase 5 — Long tail and rollout

Independent, mostly-small items that make the integration feel finished, plus the
enable-by-default rollout. All adapter/manifest/app-asset scoped.

## 1. Provider identity

- **Icon:** `packages/app/src/components/icons/omp-icon.tsx` + registration in
  `packages/app/src/components/provider-icons.ts`. Today omp falls back to the generic `Bot`
  icon. Source the mark from `oh-my-pi/assets/` (MIT-licensed) or draw a wordmark-derived
  glyph.
- **Manifest copy:** label "Oh My Pi", description reflecting first-class status (not
  "Pi-compatible fork").

## 2. Plan usage / quota fetcher

`omp usage` exists as a CLI; if omp exposes structured plan/credit data (auth-broker or local
accounting), add `packages/server/src/services/quota-fetcher/providers/omp.ts` + manifest
registration per `docs/providers.md` "Provider Usage Fetchers". Skip cleanly if omp only
aggregates per-provider API keys (nothing coherent to show) — decide during implementation,
don't force it.

## 3. Notices, goals, retry telemetry

Map omp's extended session events into existing surfaces, all optional and non-breaking:

- `notice` → `AgentProviderNotice`/timeline notice.
- `goal_updated` → provider notice (a dedicated goals UI is out of scope; note it as a
  possible future primitive).
- `auto_retry_start/end`, `retry_fallback_applied/succeeded` → status-line notices so users
  see why a turn is stalled/retrying.
- `auto_compaction_start/end` → the existing compaction timeline item (Pi parity).
- `ttsr_triggered`, `irc_message`, memory events: log-and-drop for now; revisit if users ask.

## 4. Model roles (deferred surface)

omp's `smol`/`slow`/`plan` model roles have no Paseo surface. Do not invent one now. Ensure
the adapter passes through role flags if configured via provider `params` (config escape
hatch: `params.smolModel` etc. → launch flags), so power users can set them without UI.

## 5. Custom providers derived from omp

`extends: "omp"` in custom-provider config should work the way `extends: "pi"` does
(command/env/params overrides through the registry's derived-provider path). Verify the
derived path picks up the new adapter; add a test mirroring the existing pi-derived one.

## 6. Docs

- `docs/providers.md`: rewrite the omp paragraphs — dedicated adapter, rpc-ui approvals,
  native rewind, subagent child-agent behavior, host tools; delete the
  `commandsRpcType`-explanation once the alias dies.
- `docs/custom-providers.md`: `extends: "omp"` example; session dir/XDG notes.
- `docs/agent-lifecycle.md`: a short "Provider-managed child agents" section documenting the
  lock label and its two states (Phase 3).
- `docs/glossary.md`: decide the user-facing term (recommend: they're just "subagents" — the
  glossary's one-term rule; "child agent" stays an internal/daemon term).

## 7. E2E and CI

- `daemon-e2e/agent-configs.ts`: omp entry (full=`yolo`, ask=`always-ask`), availability check
  = binary + minimum version.
- CI runner needs the pinned omp binary installed (mirror how other provider binaries get onto
  runners); pin the version used for fixtures and e2e so upstream releases can't break CI
  overnight. A scheduled job bumping the pin (like the ACP catalog pin updates) keeps drift
  visible.

## 8. Rollout

1. Phases 1–2 land → `omp` stays `enabledByDefault: false` for one beta cycle; announce in
   changelog; dogfood.
2. Flip `enabledByDefault: true` in the manifest once the beta soak is clean (provider still
   only shows as available when the binary resolves, so this is low-risk).
3. Phase 3 ships behind `server_info.features.providerChildAgents`; no client fallback path
   (feature contract: old clients simply see normal-looking rows; daemon guard protects
   correctness).
4. Keep the migration note for users who used the alias provider: persisted agents and
   session handles remain compatible (same provider id `omp`, same `nativeHandle` shape —
   Phase 1 §3 guarantees this on purpose).
