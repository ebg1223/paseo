# OMP RPC fixtures

Captured on 2026-07-07 with `omp/16.3.9`.

Installed binary: `/home/fedora/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp`.
It is a standalone ELF binary with embedded Bun runtime markers; upstream npm
package `@oh-my-pi/pi-coding-agent@16.3.9` declares `engines.bun >=1.3.14`.

Capture commands used throwaway temp directories and never touched the Paseo
daemon:

- `omp --mode rpc --no-session --no-skills --no-rules --approval-mode yolo --provider openai-codex --model gpt-5.5 --thinking low`
  - `tool_execution_bash_read_edit_write.json`
  - `subagent_lifecycle_progress.json`
  - `todo_tool_reminder_state.json`
  - `available_commands_update.json`
  - `get_state_context_usage.json`
  - `get_available_models_reasoning.json`
  - `get_session_stats.json`
- `omp --mode rpc-ui --no-session --no-skills --no-rules --approval-mode always-ask --provider openai-codex --model gpt-5.5 --thinking low`
  - `rpc_ui_extension_requests.json`
- `PI_RPC_EMIT_TITLE=1 omp --mode rpc --no-skills --no-rules --approval-mode yolo --provider openai-codex --model gpt-5.5 --thinking low`
  - `title_emission_probe.json`
- `omp --mode rpc --no-skills --no-rules --approval-mode yolo --provider openai-codex --model gpt-5.5 --thinking low`
  - `subagent_session_file_paths.json`

Notes:

- `todo_auto_clear` was not emitted. Upstream source says auto-clear was removed
  and `tasks.todoClearDelay` is inert; completed/abandoned tasks survive until an
  explicit `todo rm`/`drop`.
- Built-in plan approval was not reachable in RPC/RPC-UI. The live RPC-UI
  approval surface for tools is a generic `select` frame with `Approve`/`Deny`.
- `PI_RPC_EMIT_TITLE=1` did not produce `session_info_update` or `setTitle` for
  auto-titling in RPC mode.
