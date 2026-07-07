# Open questions and verification items

Numbered; referenced from the phase docs. Each needs an answer against a live pinned omp
before (or during) the phase that cites it. Record answers inline here as they're settled.

## 1. RPC-mode settings reset vs task/todo tools — gates Phase 2

`docs/rpc.md` says RPC mode resets `todo.*`, `task.*`, `memory.*`, `advisor.*`, `async.*`,
`bash.autoBackground.*` to defaults. Verify with a live session that the defaults keep the
`task` and `todo` tools enabled and functional headlessly. If not, determine the launch-time
mechanism to re-enable (flag, settings file, env) and encode it in `launch.ts`.
Also verify `task.isolation` defaults (affects Phase 3 worktree handling).

**Answer:** _pending_

## 2. rpc-ui request vocabulary — gates Phase 2 §3/§4

Capture the exact `extension_ui_request` shapes emitted in `--mode rpc-ui` for: tool approval
cards (bash, edit/write), plan approval, model/select dialogs, `ask_user` chains. Needed to
write the permission mapper and to decide whether plan approval gets `kind:"plan"` or a
confirm dialog. Also: is there a mid-session command to change `--approval-mode` (for
`setMode` without restart)? Check `set_*` command list and settings commands.

**Answer:** _pending_

## 3. Subagent session files in import discovery — gates Phase 1 §5

Do task-spawned child session files land in the same per-cwd sessions dir the import scanner
walks? If yes, what distinguishes them (header field? `parentSession`? subdirectory?) so the
import picker doesn't list every historical subagent. Phase 3 claims live ones as child
agents; this question is about terminal-started history imports.

**Answer:** _pending_

## 4. Isolated-worktree lifecycle — gates Phase 3

For `isolated: true` tasks: does omp always merge+remove the worktree on completion, or can
it persist (merge strategy settings)? How does the adapter detect which happened (lifecycle
frame field? follow-up state?) to set `resumable` correctly on `reportChildEnded`? What cwd do
frames report during the run?

**Answer:** _pending_

## 5. Nested-spawn parent resolution — gates Phase 3 nesting

When a subagent spawns its own subagent, do the grandchild's lifecycle/progress frames carry
enough to resolve the _spawning subagent_ as parent (e.g. does `parentToolCallId` reference a
tool call inside the child's stream, and is the child's subagent `id` recoverable from it)?
If not, attach grandchildren to the root parent (documented fallback in 03 §Part B).

**Answer:** _pending_

## 6. Host-tool dispatch concurrency — gates Phase 4

Confirm `host_tool_call` handling is concurrent with the streaming turn and that long-blocking
host tools (foreground `create_agent`, `wait_for_agent`) don't deadlock the turn loop. Also
confirm `host_tool_update` semantics for progressive results (do we get re-renders?).

**Answer:** _pending_

## 7. Title emission in RPC mode — gates Phase 2 §8

Does `PI_RPC_EMIT_TITLE` (or equivalent) re-enable auto-titling headlessly, and does the title
arrive via `session_info_update`? If flaky, ship option (b) only (Paseo-generated title pushed
via `set_session_name`).

**Answer:** _pending_

## 8. Minimum version + Bun runtime distribution

Pick `MIN_SUPPORTED_OMP_VERSION` (candidate: the version the fixtures are captured against).
Verify: standalone/brew binaries embed Bun; npm-installed `omp` requires Bun ≥ its floor on
PATH. `getDiagnostic` copy should cover the npm-without-Bun failure mode explicitly.

**Answer:** _pending_

## Standing risks (not questions — monitor)

- **Upstream velocity:** omp is a fast-moving v16.x fork. Mitigations: Zod-lenient parsing
  (passthrough + optional), unknown events/frames are log-and-drop never fatal, pinned CI
  binary, capability probing over version parsing (README D4).
- **Frame volume:** `events`-level subagent subscription multiplies stream traffic by fleet
  size. The relay path must coalesce like the parent path does; watch daemon CPU with a
  10-subagent fan-out before calling Phase 3 done (`docs/terminal-performance.md` spirit).
- **Fork semantics confusion:** post-completion prompting of a child forks its transcript;
  the parent never sees it. Composer hint copy carries this; watch for user confusion in
  beta feedback.
- **Double orchestration:** task tool + Paseo `create_agent` both available (Phases 2/4).
  System-prompt disambiguation is the mitigation; watch for models picking the wrong one.
