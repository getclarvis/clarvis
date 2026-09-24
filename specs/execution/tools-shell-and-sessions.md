# Shell execution and run-owned sessions

`@clarvis/tools` exposes `shell` and `shell_session` as the two agent command tools. Both require execution authority and are absent from the read-only surface. They share one `ExecutionSessionManager` per run for sandbox policy, process ownership, bounded capture, and shutdown. Production: `toolDescriptors` in `packages/tools/src/tools/registry.ts`, `ExecutionSessionManager` in `packages/tools/src/lib/execution-session.ts`, and `EXEC_TOOL_NAMES` in `packages/loop/src/runtime/tools/builtin/names.ts`. Test: `packages/tools/tests/component/tool-surface.test.ts`, `packages/loop/tests/unit/toolset.test.ts`, and `packages/tools/tests/integration/execution-session.test.ts`.

## Launch and status

`createShell` validates the command, working directory, guard decision, and per-command sandbox escalation before launch. The manager resolves the platform shell once, applies `sandboxCommand` once, starts a child with closed stdin and separate stdout/stderr pipes, and registers the owned process before returning its opaque `ses_` ID. POSIX children have their own process group; Windows children are not unconditionally detached. Pre-abort does not spawn, and an error after spawn stops the child. An unavailable required sandbox fails closed. Production: `createShell` in `packages/tools/src/tools/shell.ts`, `ExecutionSessionManager.launch` in `packages/tools/src/lib/execution-session.ts`, `ownProcessGroup` in `packages/tools/src/lib/process.ts`, and `resolveSandboxEscalation` in `packages/tools/src/lib/sandbox-permissions.ts`. Test: `packages/tools/tests/integration/execution-session.test.ts`, `packages/tools/tests/integration/shell-escalation.test.ts`, and `packages/tools/tests/integration/sandbox.test.ts`.

An explicit `cwd` is resolved relative to the workspace when necessary and checked to be a
directory; the legacy file-tool confinement flag does not authorize command working directories.
The selected Host or Sandbox placement decides whether the shell can enter that
directory. Blocking and yielded commands use the same frozen filesystem policy through their
`ExecutionSessionManager`; `shell_session` can inspect or stop only the resulting owned session.
Production: `createShell` in [shell.ts](../../packages/tools/src/tools/shell.ts),
`resolveFilesystemPolicy` in [sandbox.ts](../../packages/tools/src/sandbox.ts), and
`ExecutionSessionManager.launch` in
[execution-session.ts](../../packages/tools/src/lib/execution-session.ts). Test:
[sandbox.test.ts](../../packages/tools/tests/integration/sandbox.test.ts) (`uses the same broad-read
write-limited policy for shell and shell_session with an external cwd`) and
[shell-escalation.test.ts](../../packages/tools/tests/integration/shell-escalation.test.ts).

Without `yield_time_ms`, `shell` waits for exit. With it, the call returns after exit, readiness, or the requested wait, at most 30 seconds. A still-running command returns `running: true` and `session_id`; a finished command returns its physical exit code without a session ID. `timeout_ms` limits total process life independently of the yield. The timer and the output capture path both check the deadline, so a continuous producer cannot indefinitely defer its timeout. `ready_when` scans a bounded rolling window with a regex work budget; `ready: true` reports an observed pattern, not successful completion. PowerShell preserves a native executable's exit code with `sessionCommand`; POSIX sends the approved command unchanged. Production: `createShell` in `packages/tools/src/tools/shell.ts`, `LiveSession.start`, `LiveSession.waitReady`, and `sessionCommand` in `packages/tools/src/lib/execution-session.ts`. Test: `packages/tools/tests/integration/shell-session.test.ts`, `packages/tools/tests/integration/execution-session.test.ts`, and `packages/tools/tests/integration/shell.test.ts`.

## Capture, polling, and stop

Both streams are always drained. Each has a bounded 256 KiB memory window and an independent absolute byte offset. `shell_session({action:"poll"})` returns new fragments with an opaque two-stream `next_cursor`; repeating a cursor is idempotent while its bytes remain retained. An expired cursor reports omitted bytes. Pages advance at UTF-8 boundaries. Blocking `shell` presents a bounded tail with truncation and omitted-byte fields. Capture limits do not change the physical exit code. No command output is spilled to disk. Production: `LiveSession` in `packages/tools/src/lib/execution-session.ts`, `SessionWindow` in `packages/tools/src/lib/session-window.ts`, and `shellSessionView` in `packages/tools/src/tools/shell-session.ts`. Test: `packages/tools/tests/unit/session-window.test.ts`, `packages/tools/tests/integration/shell-session.test.ts`, and `packages/tools/tests/integration/shell.test.ts`.

`poll`, `stop`, and `list` require a session ID owned by the same agent and manager, except `list`, which needs no ID. Unknown, foreign, or closed-run IDs return `not_found` and never become PID authority. `list` is limited to session IDs and status, without command text or paths. `stop` signals the owned process tree and reports whether termination was confirmed; repeating it is safe. POSIX checks the process group even after the launcher exits. Windows uses the retained child handle and `taskkill /T /F`. A deliberately daemonized descendant outside the tracked group remains outside this guarantee. Production: `shellSession` in `packages/tools/src/tools/shell-session.ts`, `ExecutionSessionManager.getSession` and `LiveSession.stop` in `packages/tools/src/lib/execution-session.ts`, and `stopOwnedProcess` in `packages/tools/src/lib/process-owner.ts`. Test: `packages/tools/tests/integration/shell-session.test.ts` and `packages/tools/tests/integration/execution-session.test.ts`.

`LiveSession.snapshot` projects `starting`, `running`, `exited_pending_status`,
`exited_draining`, or `closed` from one observed state. `poll` and `list` use that same snapshot;
physical exit before an exit code is reported as `exited_pending_status`, never simply as
`running: true`. Production: `LiveSession.snapshot` in
[execution-session.ts](../../packages/tools/src/lib/execution-session.ts) and `shellSession`
in [shell-session.ts](../../packages/tools/src/tools/shell-session.ts). Test: physical-exit
projection in [execution-session.test.ts](../../packages/tools/tests/integration/execution-session.test.ts).

The manager admits at most `maxSessions` tracked sessions. Finished entries may be evicted to make room; a live process tree keeps its slot. At run end, `close` seals admission and stops all tracked processes before the loop removes its own scratch. Failed physical confirmation or an exhausted cleanup budget retains that scratch. The loop does not adopt or clean temporary directories inferred from command text. `createAgentTools` exposes `close()` for its private manager. Production: `ExecutionSessionManager.launch` and `close` in `packages/tools/src/lib/execution-session.ts`, `createAgentToolsCapability` in `packages/loop/src/runtime/capabilities/tools.ts`, and `createAgentTools` in `packages/tools/src/index.ts`. Test: `packages/tools/tests/integration/execution-session.test.ts`, `packages/loop/tests/integration/tools.test.ts`, and `packages/loop/tests/integration/command-guard-wiring.test.ts`.

## State and operator boundary

Command sessions create no sidecar, output log, exit sentinel, or shell spill. Generic oversized results from other tools still use `createToolSpill`; `read_file` and `read_files` admit only an exact, regular, non-link generic spill in the current workspace's local state. They pin its filesystem identity through open. A shell command receives no implicit state mount or guard exception. Production: `createToolSpill` in `packages/loop/src/runtime/context/tool-spill.ts`, `resolveReadableTextPath` in `packages/tools/src/lib/state-artifacts.ts`, `readRawFile` in `packages/tools/src/lib/files.ts`, and `buildGuardContext` in `packages/tools/src/guard/context.ts`. Test: `packages/tools/tests/unit/state-artifact-access.test.ts`, `packages/tools/tests/integration/explicit-state-paths.test.ts`, and `packages/tools/tests/integration/guard-dispatch.test.ts`.

The operator's local `!` command is a separate `@clarvis/code` path. It uses Bash on POSIX, reserves and observes conversation activity, and does not invoke the agent command guard. Production: `runLocalBash` in `packages/code/src/adapters/local-shell.ts` and `runBangCommand` in `packages/code/src/run-host.ts`. Test: `packages/code/tests/integration/local-shell.test.ts` and `packages/code/tests/component/run-host.test.ts`.
