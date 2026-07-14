# RUNBOOK — Phase 4: omp host tools

Executes [04-host-tools.md](04-host-tools.md): deliver Paseo's tool catalog to omp over its
native `set_host_tools`/`host_tool_call` RPC surface instead of the injected MCP server.
Adapter-scoped; implements an existing daemon contract. Follows Phase 2 (committed, CI-green).

## Sequence context

- Phase 4 → D3 → Phase 5, run strictly sequentially (all touch omp adapter + pi-shared).
- Phase 4 is independent of D3; the enable-by-default flip (Phase 5) waits on D3.

## Grounding (verified 2026-07-08)

- Manager contract already present: `client.capabilities.supportsNativePaseoTools`,
  `launchContext.paseoTools` (`PaseoToolCatalog`), `paseoToolCatalogFactory({callerAgentId})`,
  and `stripInternalPaseoMcpServer(launchConfig)` fired when the capability is set AND the
  catalog is present. **No provider implements the capability today — omp is the first.**
- Upstream RPC shapes: `~/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts`
  — `set_host_tools {tools: RpcHostToolDefinition[]}` (response `{toolNames}`),
  `host_tool_call {id, toolCallId, toolName, arguments}`, `host_tool_cancel {id, targetId}`,
  host-sent `host_tool_update {id, partialResult}`, and host-sent
  `host_tool_result {id, result, isError?}`.
- Host-tool fixtures captured in Phase 4:
  `packages/server/src/server/agent/providers/omp/__fixtures__/host_tool_call_update.json` and
  `host_tool_cancel.json`.
- Open question #6 (host-tool dispatch concurrency) is answered below and in
  [open-questions.md](open-questions.md).

## State

- [x] Implement (codex xhigh) — verify-first, then build.
- [ ] Full independent review (opus).
- [ ] Adjudicate → fix → commit.
- [x] Live-omp verification of the host_tool_call round-trip + concurrency (checklist).

### 2026-07-08 implementation note

- `PaseoToolCatalog` shape: `tools` is a `ReadonlyMap<string, PaseoToolDefinition>`;
  each tool carries `name`, `title?`, `description`, `inputSchema?`, `outputSchema?`, and
  `handler`. Callers should invoke through `catalog.executeTool(name, input, { signal })` so
  catalog-owned validation runs before the handler.
- Serializer reused: native OMP `set_host_tools` uses the same MCP SDK
  `normalizeObjectSchema` + `toJsonSchemaCompat(..., strictUnions: true, pipeStrategy: "input")`
  path as MCP `ListTools`, wrapped in `tools/mcp-serialization.ts`. The structured-content
  model-visible fallback from the MCP path is shared with host-tool results.
- Upstream/live shape: OMP 16.3.9 uses `host_tool_call { id, toolCallId, toolName, arguments }`,
  `host_tool_cancel { id, targetId }`, host-sent `host_tool_update { id, partialResult }`, and
  host-sent `host_tool_result { id, result, isError? }`.
- OQ#6 answer: host-tool execution is concurrent with the RPC loop. Live probe delayed a host
  result for ~2 seconds; a concurrent `get_state` returned in 16 ms with `isStreaming: true`.
  Host-sent `host_tool_update` re-emitted as `tool_execution_update`. `abort` while pending
  emitted `host_tool_cancel` and a failed `tool_execution_end`.
- Fixtures captured under `providers/omp/__fixtures__/`: `host_tool_call_update.json` and
  `host_tool_cancel.json`, both with direction markers and capture command notes in the fixture
  README.
- Shipped adapter pieces: OMP advertises `supportsNativePaseoTools: true`, registers
  `launchContext.paseoTools` via native `set_host_tools`, routes host calls through the
  caller-scoped catalog with `AbortSignal`, forwards optional catalog progress via
  `host_tool_update`, drops canceled late results, and keeps MCP fallback unchanged when no
  catalog is present.
- Review fixes: pinned `@modelcontextprotocol/sdk` exactly for shared MCP serializer internals,
  added a serializer schema guard, and added real-catalog coverage for OMP host-tool display names.
- Deviation from early runbook wording: upstream/current OMP frames use `id` rather than
  `callId`, and `toolName`/`arguments` rather than `name`/`args`; implementation follows the
  live 16.3.9 contract.

## Verification gates

Targeted vitest per touched file, pi suites green (pi doesn't set the capability →
unaffected), typecheck/lint/format via npm scripts, CI push at phase end.
