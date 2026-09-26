# Shell execution and run-owned sessions

When a run requests Sandbox, the host-owned policy wraps new shell children.
The command string is never parsed for safety or replay. A setup failure before
launch falls back to Host automatically; a typed denial after start or unknown
outcome returns a one-use, agent-bound recovery token. A later `shell` call can
name `execution_strategy: host_recovery` and that token. It runs in Host and
consumes the token; ordinary program errors and cancellation do not trigger
automatic replay. The run's session manager still owns yielded commands and
stops them before the sandbox worker closes. The ordinary advertised schema
excludes recovery arguments; a typed denial provides the continuation fields.
Production:
`CoordinatedToolExecutor` in `packages/tools/src/execution/coordinator.ts`,
`createShell` in `packages/tools/src/tools/shell.ts`, and
`createAgentToolsCapability` in
`packages/loop/src/runtime/capabilities/tools.ts`. Test:
`packages/tools/tests/unit/execution-coordinator.test.ts` and
`packages/loop/tests/integration/tools.test.ts` and
`packages/tools/tests/component/tool-surface.test.ts`.

`@clarvis/tools` exposes `shell` and `shell_session` as the two agent command tools. Both require execution authority and are absent from the read-only surface. They share one `ExecutionSessionManager` per run for process ownership, bounded capture, and shutdown. Production: `toolDescriptors` in `packages/tools/src/tools/registry.ts`, `ExecutionSessionManager` in `packages/tools/src/lib/execution-session.ts`, and `EXEC_TOOL_NAMES` in `packages/loop/src/runtime/tools/builtin/names.ts`. Test: `packages/tools/tests/component/tool-surface.test.ts`, `packages/loop/tests/unit/toolset.test.ts`, and `packages/tools/tests/integration/execution-session.test.ts`.

An omitted or empty `shell_session` cursor requests the first retained output
page; subsequent polls use the returned opaque `next_cursor`. Production:
`shellSession` in `packages/tools/src/tools/shell-session.ts`. Test:
`accepts an empty cursor as the initial shell session page` in
`packages/tools/tests/integration/execution-session.test.ts`.
For `list` and `stop`, irrelevant optional fields are ignored; `poll` and `stop`
still require a session ID owned by the same run and agent. Production:
`shellSession` in `packages/tools/src/tools/shell-session.ts`. Test:
`yields a live session, pages each stream and stops only its owner's process`
in `packages/tools/tests/integration/shell-session.test.ts`.

## Launch and status

`createShell` validates the command and working directory before launch. The manager resolves the platform shell once, starts a child with closed stdin and separate stdout/stderr pipes, and registers the owned process before returning its opaque `ses_` ID. Children have their own POSIX process group. Pre-abort does not spawn, and an error after spawn stops the child. Production: `createShell` in `packages/tools/src/tools/shell.ts`, `ExecutionSessionManager.launch` in `packages/tools/src/lib/execution-session.ts`, `ownProcessGroup` in `packages/tools/src/lib/process.ts`. Test: `packages/tools/tests/integration/execution-session.test.ts`.

An explicit `cwd` is resolved relative to the workspace when necessary and checked to be a
directory. By default the command starts on Host with that working directory; a trusted Sandbox
policy wraps each new child through `prepareLaunch` without changing the command text. Blocking and yielded
commands share the same `ExecutionSessionManager`; `shell_session` can inspect or stop only the
resulting owned session. A sandboxed child receives `HOME` and `CLARVIS_HOME`
from its execution policy; Host fallback uses the ordinary Host environment.
Polling or stopping that session is Host-owned control and carries no new
Sandbox execution claim.
Production: `createShell` in
[shell.ts](../../packages/tools/src/tools/shell.ts) and `ExecutionSessionManager.launch` in
[execution-session.ts](../../packages/tools/src/lib/execution-session.ts). Test:
[execution-session.test.ts](../../packages/tools/tests/integration/execution-session.test.ts)
and [native-sandbox.test.ts](../../packages/tools/tests/integration/native-sandbox.test.ts).
The sandbox executor adds a typed diagnostic to the completed shell result:
backend, policy, physical exit code and signal, plus bounded stdout and stderr.
Nonzero exit is `command_failed` while the command's own error text cannot prove
an OS sandbox denial. Production: `resultDiagnostic` in
[diagnostics.ts](../../packages/tools/src/execution/diagnostics.ts). Test:
[native-sandbox.test.ts](../../packages/tools/tests/integration/native-sandbox.test.ts).

Without `yield_time_ms`, `shell` waits for exit. With it, the call returns after exit, readiness, or the requested wait, at most 30 seconds. A still-running command returns `running: true` and `session_id`; a finished command returns its physical exit code without a session ID. `timeout_ms` limits total process life independently of the yield. The timer and the output capture path both check the deadline, so a continuous producer cannot indefinitely defer its timeout. `ready_when` scans a bounded rolling window with a regex work budget; `ready: true` reports an observed pattern, not successful completion. The shell receives the approved command unchanged. Production: `createShell` in `packages/tools/src/tools/shell.ts`, `LiveSession.start`, `LiveSession.waitReady`, and `sessionCommand` in `packages/tools/src/lib/execution-session.ts`. Test: `packages/tools/tests/integration/shell-session.test.ts`, `packages/tools/tests/integration/execution-session.test.ts`, and `packages/tools/tests/integration/shell.test.ts`.

## Capture, polling, and stop

Both streams are always drained. Each has a bounded 256 KiB memory window and an independent absolute byte offset. `shell_session({action:"poll"})` returns new fragments with an opaque two-stream `next_cursor`; repeating a cursor is idempotent while its bytes remain retained. An expired cursor reports omitted bytes. Pages advance at UTF-8 boundaries. Blocking `shell` presents a bounded tail with truncation and omitted-byte fields. Capture limits do not change the physical exit code. No command output is spilled to disk. Production: `LiveSession` in `packages/tools/src/lib/execution-session.ts`, `SessionWindow` in `packages/tools/src/lib/session-window.ts`, and `shellSessionView` in `packages/tools/src/tools/shell-session.ts`. Test: `packages/tools/tests/unit/session-window.test.ts`, `packages/tools/tests/integration/shell-session.test.ts`, and `packages/tools/tests/integration/shell.test.ts`.

`poll`, `stop`, and `list` require a session ID owned by the same agent and manager, except `list`, which needs no ID. Unknown, foreign, or closed-run IDs return `not_found` and never become PID authority. `list` is limited to session IDs and status, without command text or paths. `stop` signals the owned process tree and reports whether termination was confirmed; repeating it is safe. POSIX checks the process group even after the launcher exits. A deliberately daemonized descendant outside the tracked group remains outside this guarantee. Production: `shellSession` in `packages/tools/src/tools/shell-session.ts`, `ExecutionSessionManager.getSession` and `LiveSession.stop` in `packages/tools/src/lib/execution-session.ts`, and `stopOwnedProcess` in `packages/tools/src/lib/process-owner.ts`. Test: `packages/tools/tests/integration/shell-session.test.ts` and `packages/tools/tests/integration/execution-session.test.ts`.

`LiveSession.snapshot` projects `starting`, `running`, `exited_pending_status`,
`exited_draining`, or `closed` from one observed state. `poll` and `list` use that same snapshot;
physical exit before an exit code is reported as `exited_pending_status`, never simply as
`running: true`. Production: `LiveSession.snapshot` in
[execution-session.ts](../../packages/tools/src/lib/execution-session.ts) and `shellSession`
in [shell-session.ts](../../packages/tools/src/tools/shell-session.ts). Test: physical-exit
projection in [execution-session.test.ts](../../packages/tools/tests/integration/execution-session.test.ts).

The manager admits at most `maxSessions` tracked sessions. Finished entries may be evicted to make room; a live process tree keeps its slot. At run end, `close` seals admission and stops all tracked processes before the loop removes its own scratch. Failed physical confirmation or an exhausted cleanup budget retains that scratch. The loop does not adopt or clean temporary directories inferred from command text. `createAgentTools` exposes `close()` for its private manager. Production: `ExecutionSessionManager.launch` and `close` in `packages/tools/src/lib/execution-session.ts`, `createAgentToolsCapability` in `packages/loop/src/runtime/capabilities/tools.ts`, and `createAgentTools` in `packages/tools/src/index.ts`. Test: `packages/tools/tests/integration/execution-session.test.ts` and `packages/loop/tests/integration/tools.test.ts`.

## State and operator boundary

Command sessions create no sidecar, output log, exit sentinel, or shell spill. Generic oversized results from other tools still use `createToolSpill`; file tools can read the resulting path when the host OS allows it. Production: `createToolSpill` in `packages/loop/src/runtime/context/tool-spill.ts`, `readRawFile` in `packages/tools/src/lib/files.ts`. Test: `packages/tools/tests/integration/explicit-state-paths.test.ts`.

The operator's local `!` command is a separate `@clarvis/code` path. It uses Bash on POSIX and reserves and observes conversation activity without invoking the agent tool dispatcher. Production: `runLocalBash` in `packages/code/src/adapters/local-shell.ts` and `runBangCommand` in `packages/code/src/run-host.ts`. Test: `packages/code/tests/integration/local-shell.test.ts` and `packages/code/tests/component/run-host.test.ts`.
