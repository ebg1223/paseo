# Open questions and verification items

Numbered; referenced from the phase docs. Each needs an answer against a live pinned omp
before (or during) the phase that cites it. Record answers inline here as they're settled.

## 1. RPC-mode settings reset vs task/todo tools — gates Phase 2

`docs/rpc.md` says RPC mode resets `todo.*`, `task.*`, `memory.*`, `advisor.*`, `async.*`,
`bash.autoBackground.*` to defaults. Verify with a live session that the defaults keep the
`task` and `todo` tools enabled and functional headlessly. If not, determine the launch-time
mechanism to re-enable (flag, settings file, env) and encode it in `launch.ts`.
Also verify `task.isolation` defaults (affects Phase 3 worktree handling).

**Answer:** Defaults keep both tools available and functional in RPC mode as of
`omp/16.3.9`. Evidence: live `get_state` advertised `Task: task` and `Todo: todo` in
the tool inventory; a yolo RPC run successfully emitted `tool_execution_end` for
`todo` init/done and `task`, plus `subagent_lifecycle`/`subagent_progress` for the
task-spawned child
(`packages/server/src/server/agent/providers/omp/__fixtures__/todo_tool_reminder_state.json`,
`subagent_lifecycle_progress.json`). No launch-time re-enable is needed for default
RPC settings. Source check: RPC re-applies host defaults for task settings but does
not host-default `todo.enabled`; `todo.enabled` defaults `true`, and
`task.isolation.mode` defaults `none` in upstream `settings-schema.ts`.

## 2. rpc-ui request vocabulary — gates Phase 2 §3/§4

Capture the exact `extension_ui_request` shapes emitted in `--mode rpc-ui` for: tool approval
cards (bash, edit/write), plan approval, model/select dialogs, `ask_user` chains. Needed to
write the permission mapper and to decide whether plan approval gets `kind:"plan"` or a
confirm dialog. Also: is there a mid-session command to change `--approval-mode` (for
`setMode` without restart)? Check `set_*` command list and settings commands.

**Answer:** `--mode rpc-ui` emits generic `extension_ui_request` frames, not a
separate structured tool-approval method. Observed vocabulary:
`select {id,title,options,timeout?}`, `confirm {id,title,message,timeout?}`,
`input {id,title,placeholder?,timeout?}`, `editor {id,title,prefill?,promptStyle?}`,
plus passive `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`;
`cancel` and `open_url` are present in upstream `rpc-types.ts` but were not needed
for the captured prompts. Tool approvals are `select` frames with two options,
`["Approve","Deny"]`: bash title `Allow tool: bash\nCommand: ...`, edit title
`Allow tool: edit\nFile: ...`, write title
`Allow tool: write\nPath: ...\nContent:\n...`
(`__fixtures__/rpc_ui_extension_requests.json`). The ask tool emits a `select`
with title equal to the question and options including `Other (type your own)`;
source shows choosing that branch opens an `editor` with `promptStyle: true`, and
the generic editor frame was captured. Real plan approval is not currently exposed
by RPC mode: the built-in approval selector lives in interactive mode/ACP, while
`runRpcMode` has no plan approval bridge. No mid-session approval-mode command
exists in the RPC command union or docs; approval mode is launch-time only via
`--approval-mode always-ask|write|yolo`.

## 3. Subagent session files in import discovery — gates Phase 1 §5

Do task-spawned child session files land in the same per-cwd sessions dir the import scanner
walks? If yes, what distinguishes them (header field? `parentSession`? subdirectory?) so the
import picker doesn't list every historical subagent. Phase 3 claims live ones as child
agents; this question is about terminal-started history imports.

**Answer:** Yes, for a normal persisted RPC session, task-spawned child sessions
land below the parent session file stem in the same per-cwd sessions directory.
Observed parent:
`~/.omp/agent/sessions/-tmp-omp-capture-session-task-6HoUad/2026-07-07T23-41-42-657Z_019f3ef5-7980-7000-a76d-1c31457ae89a.jsonl`;
child:
`~/.omp/agent/sessions/-tmp-omp-capture-session-task-6HoUad/2026-07-07T23-41-42-657Z_019f3ef5-7980-7000-a76d-1c31457ae89a/EchoChild.jsonl`.
Distinguish children by being nested under a directory named after the parent
session file stem and by the lifecycle payload's `parentToolCallId`, `detached`,
`agent`, `agentSource`, `description`, and `index`
(`__fixtures__/subagent_session_file_paths.json`).

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

**Answer:** `PI_RPC_EMIT_TITLE=1` does not re-enable headless auto-titling in RPC
mode on `omp/16.3.9`. Evidence: a persisted RPC run launched with
`PI_RPC_EMIT_TITLE=1` emitted no `session_info_update`, no `setTitle` UI request,
and final `get_state.sessionName` stayed unset
(`__fixtures__/title_emission_probe.json`). Source check: protocol modes still set
`noTitle`; `PI_RPC_EMIT_TITLE` only gates forwarding of `ctx.ui.setTitle()` as a
UI event. Ship option (b): Paseo-generated title pushed with `set_session_name`.

## 8. Minimum version + Bun runtime distribution

Pick `MIN_SUPPORTED_OMP_VERSION` (candidate: the version the fixtures are captured against).
Verify: standalone/brew binaries embed Bun; npm-installed `omp` requires Bun ≥ its floor on
PATH. `getDiagnostic` copy should cover the npm-without-Bun failure mode explicitly.

**Answer:** Fixture pin candidate: `MIN_SUPPORTED_OMP_VERSION = "16.3.9"`
(`omp --version` returned `omp/16.3.9`). Installed distribution:
`/home/fedora/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp` is a
native ELF; `ldd` shows libc/pthread/dl/m only, and `strings` contains Bun runtime
markers such as `BUN_1.2` and `bun test`, so this installed standalone/mise binary
embeds Bun. Upstream npm package `@oh-my-pi/pi-coding-agent@16.3.9` exposes
`bin.omp = src/cli.ts` and declares `engines.bun >=1.3.14`, so npm installs need a
Bun runtime on `PATH`; diagnostics should call out missing/old Bun explicitly.

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
