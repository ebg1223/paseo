# Phase 4 — Host tools: native Paseo tools without MCP

Goal: deliver Paseo's tool catalog (`create_agent`, `send_agent_prompt`, `wait_for_agent`,
`speak`, …) to omp through its **host tools** RPC surface instead of the injected MCP server.
Adapter-scoped; implements an existing daemon contract.

## Why

- Paseo already defines the contract: providers that can register runtime tools directly set
  `supportsNativePaseoTools: true` and consume `launchContext.paseoTools`; `AgentManager` then
  strips the internal Paseo MCP server from the launch config so tools aren't delivered twice
  (`docs/providers.md`). omp's `set_host_tools` is a textbook implementation target.
- Removes a process hop and the OAuth/config special-casing of the `/mcp/agents` HTTP
  endpoint; tool schemas and results stay in-process on the daemon side.
- Host tools appear to the omp model as first-class tools (better prompting surface than
  namespaced MCP tools).

The native host-tool transport is now the sole Paseo orchestration path for OMP. There is no
generated Pi extension or MCP fallback; `supportsNativePaseoTools` selects the adapter-owned
catalog transport.

## Upstream surface (reference)

`oh-my-pi/docs/rpc.md` "host tools" + `rpc-types.ts`:

- Host registers: `set_host_tools [{name, description, parameters (JSON Schema), ...}]`.
- OMP calls: outbound frame
  `host_tool_call {id, toolCallId, toolName, arguments}`; optional progressive
  `host_tool_update`; the host answers `host_tool_result {id, result: AgentToolResult}`;
  cancellation arrives as `host_tool_cancel {id, targetId}`.
- Also available, not in scope: `set_host_uri_schemes` (virtual filesystems) — noted for a
  possible future "attach Paseo-managed context" feature; do not build now.

## Adapter work

- On session create/resume, when `launchContext.paseoTools` is present:
  1. Set capability `supportsNativePaseoTools: true` (static on the adapter; the launch
     context is per-session).
  2. Translate the catalog's tool definitions (name/description/Zod schema → JSON Schema —
     the catalog already produces MCP-shaped schemas, reuse that serialization) into
     `set_host_tools`.
  3. Route `host_tool_call` → invoke the catalog tool handler with the caller-agent-scoped
     context (same scoping the MCP path uses: `callerAgentId` = this agent) → map the result
     (including isError) into `host_tool_result`.
  4. `host_tool_cancel` → abort the in-flight handler via AbortSignal if the catalog supports
     it; otherwise let it complete and drop the result.
- Tool calls made this way still show up in the parent timeline via normal
  `tool_execution_*` events on omp's side — verify naming so `tool-call-mapper` renders them
  as Paseo tool calls, not `unknown`.
- Long-running host tools (`create_agent` foreground waits, `wait_for_agent`) run while omp's
  turn is streaming — confirm omp's host-tool dispatch is concurrent with the turn (docs
  indicate bash/host dispatch is concurrent; verify under load, open-questions #6).
- System-prompt disambiguation (from Phase 2 §9) becomes more important here: task tool =
  in-process, host `create_agent` = independent Paseo agents. One paragraph in the appended
  system prompt, maintained alongside the tool catalog descriptions.
- OMP must not arm Paseo caller finish notifications. Those notifications are delivered as a
  synthetic user prompt and interrupt the still-active OMP RPC turn. The OMP serializer advertises
  `notifyOnFinish: false`, the router enforces it for `create_agent` and `send_agent_prompt`, and
  callers use the catalog's `wait_for_agent` host tool instead.

## Testing

- Unit: catalog→`set_host_tools` serialization; `host_tool_call` round-trip with a fake
  catalog; cancellation.
- E2E: omp agent calls `create_agent` (host path) → child appears as a genuine Paseo subagent
  in the track; MCP server absent from launch config (assert the strip happened).
- Regression: with the flag on, no duplicate tools visible to the model (previously the
  MCP+native double-delivery failure mode).
