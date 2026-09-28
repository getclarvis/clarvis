# Shell execution and run-owned sessions

When a run requests Sandbox, the host-owned policy wraps new shell children.
The Kernel analyzes the validated command for rules and approval, then binds the
decision to the actor, call and attempt. `shell.execution_permissions` can request
`use_default`, `require_escalated` or `with_additional_permissions`; the latter
names write roots and/or enabled network. A restricted-profile delta requires
approval. A setup failure, typed denial or uncertain outcome never replays the
command on Host automatically. The run's session manager owns yielded commands
and stops them before the sandbox worker closes.
Production:
`CoordinatedToolExecutor` in `packages/tools/src/execution/coordinator.ts`,
`createShell` in `packages/tools/src/tools/shell.ts`, and
`createAgentToolsCapability` in
`packages/loop/src/runtime/capabilities/tools.ts`. Test:
`packages/tools/tests/unit/execution-coordinator.test.ts` and
`packages/loop/tests/integration/tools.test.ts` and
`packages/tools/tests/integration/common/tool-surface.test.ts`.

`@clarvis/tools` exposes `shell` and `shell_session` as the two agent command tools. Both require execution authority and are absent from the read-only surface. They share one `ExecutionSessionManager` per run for process ownership, bounded capture, and shutdown. Production: `toolDescriptors` in `packages/tools/src/tools/registry.ts`, `ExecutionSessionManager` in `packages/tools/src/lib/execution-session.ts`, and `EXEC_TOOL_NAMES` in `packages/loop/src/runtime/tools/builtin/names.ts`. Test: `packages/tools/tests/integration/common/tool-surface.test.ts`, `packages/loop/tests/unit/toolset.test.ts`, and `packages/tools/tests/integration/common/execution-session.test.ts`.

An omitted or empty `shell_session` cursor requests the first retained output
page; subsequent polls use the returned opaque `next_cursor`. Production:
`shellSession` in `packages/tools/src/tools/shell-session.ts`. Test:
`accepts an empty cursor as the initial shell session page` in
`packages/tools/tests/integration/common/execution-session.test.ts`.
For `list`, `status`, `tail`, `read` and `stop`, irrelevant wait fields are ignored; all actions except `list`
still require a session ID owned by the same run and agent. Production:
`shellSession` in `packages/tools/src/tools/shell-session.ts`. Test:
`yields a live session, pages each stream and stops only its owner's process`
in `packages/tools/tests/integration/common/shell-session.test.ts`.

## Launch and status

`createShell` validates the command and working directory before launch. The manager resolves the platform shell once, starts a child with closed stdin and separate stdout/stderr pipes, and registers the owned process before returning its opaque `ses_` ID. Children have their own POSIX process group. Pre-abort does not spawn, and an error after spawn stops the child. Production: `createShell` in `packages/tools/src/tools/shell.ts`, `ExecutionSessionManager.launch` in `packages/tools/src/lib/execution-session.ts`, `ownProcessGroup` in `packages/tools/src/lib/process.ts`. Test: `packages/tools/tests/integration/common/execution-session.test.ts`.

`keep_alive: true` is a separate, explicit contract. It requires an explicit `yield_time_ms`, the run's default Sandbox policy, and a Linux Bubblewrap backend whose PID namespace capability is proven. Host, macOS Seatbelt and per-action permission deltas reject before any child is spawned. The original command remains the analyzed and authorized `file`/`args` payload; a verified `session-supervisor.ts` asset is launched inside the Sandbox and starts that payload exactly once with stdin closed. The supervisor's stdin is the run-owned lease and its stdout carries only bounded, versioned frames whose output payload is encoded separately from control. Production: `createShell` in `packages/tools/src/tools/shell.ts`, `ExecutionSessionManager.prepareSupervisor` in `packages/tools/src/lib/execution-session.ts`, and `SupervisorChild` in `packages/tools/src/execution/session-supervisor.ts`. Test: `keep_alive requires explicit yield and rejects permission deltas before spawn` in `packages/tools/tests/unit/execution-session-policy.test.ts` and `packages/tools/tests/integration/common/session-supervisor.test.ts`.

One manager supplies the clock, timers and ownership operations to every live session.
The shell handler reads that clock for yield and elapsed diagnostics; readiness,
timeout, output coalescing, drain and close use the same scheduler. The default
ownership adapter probes the real process group and confirms exit; a successful
signal alone is not confirmation. `stopOwnedProcess` keeps the TERM grace, KILL
escalation and final confirmation policy separate from probes, signals and waits.
`createShell` also accepts a directory-check function beside its spawn seam so
handler timing can be tested without a filesystem operation.
Production: `ExecutionSessionManager`, `LiveSession` and `SessionClock` in
`packages/tools/src/lib/execution-session.ts`, `createOutputCoalescer` in
`packages/tools/src/lib/output.ts`, `stopOwnedProcess` in
`packages/tools/src/lib/process-owner.ts`, and `runCommand` in
`packages/tools/src/tools/shell.ts`. Test:
`packages/tools/tests/unit/execution-session-policy.test.ts`,
`packages/tools/tests/unit/process-owner-policy.test.ts` and
`packages/tools/tests/integration/common/process-owner.test.ts`.

An explicit `cwd` is resolved relative to the workspace when necessary and checked to be a
directory. By default a standalone command starts on Host with that working directory; a trusted Sandbox
policy wraps each new child through `prepareLaunch` without changing the command text. Blocking and yielded
commands share the same `ExecutionSessionManager`; `shell_session` can inspect or stop only the
resulting owned session. A sandboxed child receives `HOME` and `CLARVIS_HOME`
from its execution policy; an explicitly selected Host profile uses the ordinary Host environment.
Polling or stopping that session is Host-owned control and carries no new
Sandbox execution claim.
Production: `createShell` in
[shell.ts](../../packages/tools/src/tools/shell.ts) and `ExecutionSessionManager.launch` in
[execution-session.ts](../../packages/tools/src/lib/execution-session.ts). Test:
[execution-session.test.ts](../../packages/tools/tests/integration/common/execution-session.test.ts)
and [native-sandbox.test.ts](../../packages/tools/tests/integration/native/native-sandbox.test.ts).
The sandbox executor adds a typed diagnostic to the completed shell result:
backend, policy, physical exit code and signal, plus bounded stdout and stderr.
Nonzero exit is `command_failed` while the command's own error text cannot prove
an OS sandbox denial. Production: `resultDiagnostic` in
[diagnostics.ts](../../packages/tools/src/execution/diagnostics.ts). Test:
[native-sandbox.test.ts](../../packages/tools/tests/integration/native/native-sandbox.test.ts).

Without `yield_time_ms`, `shell` waits for exit. With it, the call returns after exit, readiness, or the requested wait, at most 30 seconds. A still-running command returns `running: true` and `session_id`; a finished command returns its physical exit code and a retained session ID for log inspection. For retained sessions, a successful initializer can already report `command_status: "exited"` and `command_exit_code: 0` while `running: true`; that session remains the only authority for later polling or stop. A nonzero initializer or signal closes the boundary instead of retaining it. A controller lease already closed before retention is recognized without waiting for another EOF; protocol output failures terminate the initializer and fail the supervisor. `timeout_ms` limits total process life independently of the yield, including the retained phase. The timer and the output capture path both check the deadline, so a continuous producer cannot indefinitely defer its timeout. Empty or whitespace-only `ready_when` is ignored without changing `yield_time_ms`; nonblank patterns preserve their original whitespace. `ready_when` scans a bounded rolling window with a regex work budget; `ready: true` reports an observed pattern, not successful completion. The shell receives the approved command unchanged. Production: `createShell` in `packages/tools/src/tools/shell.ts`, and `LiveSession.start`, `LiveSession.waitReady` and `LiveSession.readStreams` in `packages/tools/src/lib/execution-session.ts`. Test: `packages/tools/tests/integration/common/shell-session.test.ts`, `packages/tools/tests/integration/common/execution-session.test.ts`, and `packages/tools/tests/integration/common/shell.test.ts`; `runSessionSupervisor` in `packages/tools/src/execution/session-supervisor.ts`, tested by `packages/tools/tests/integration/common/session-supervisor.test.ts` and `packages/tools/tests/unit/session-supervisor-protocol.test.ts`.

## Capture, polling, and stop

Both streams are always drained. Each keeps a bounded 256 KiB memory tail and a private plain-text log preserving its first 16 MiB, rounded down to complete UTF-8 characters. `stdout_log` and `stderr_log` identify the run-owned files; `log_truncated` reports a log cap or capture failure. The host creates them through `allocateShortTemporaryRoot`, independently of command write grants, and removes them on session eviction or confirmed run cleanup. A capture failure leaves recent memory output available and emits `tools.session_log_failed`; an allocation failure occurs before command spawn. Production: `createSessionLog` in `packages/tools/src/lib/session-log.ts`, `LiveSession.start`, `LiveSession.outputInfo`, `ExecutionSessionManager.forget` and `ExecutionSessionManager.close` in `packages/tools/src/lib/execution-session.ts`. Test: `packages/tools/tests/integration/common/session-log.test.ts`.

`poll` batches output until its requested wait expires (default 10000 ms, maximum 30000 ms), or until completion/cancellation. Already buffered output and incoming chunks do not shorten the wait; 0 explicitly requests an immediate check. `status` returns status and log metadata without output; `tail` reads the latest output immediately; `read` reads earlier log pages immediately. Poll/read/tail limit returned text to 8 KiB (and the configured output ceiling), preserve UTF-8 boundaries and return `next_cursor` and `has_more`. The two-stream cursor is an absolute byte offset; an omitted/empty cursor starts at zero. Log pages remain recoverable after the memory tail advances. Logs use an exclusive temporary directory removed in full on disposal, without leaving a shared allocation container. If both the capped log and memory tail lack a range, reads report omitted bytes. A tail cursor resumes after its displayed output. Command exit does not imply all log pages have been read. Production: `shellSession`, `shellSessionView` in `packages/tools/src/tools/shell-session.ts`, `LiveSession.waitForChange`, `LiveSession.readStreams`, `LiveSession.readTail` in `packages/tools/src/lib/execution-session.ts`. Test: `poll batches continuous and already pending output until its wait expires`, `poll completion and cancellation wake promptly and remove timers` and blank-readiness cases in `packages/tools/tests/unit/execution-session-policy.test.ts`; `packages/tools/tests/integration/common/session-log.test.ts`.

Blocking `shell` returns a bounded recent tail, log paths and a session ID, including completed nonzero commands. Timeout errors also retain log metadata. Logs support later `read_file`, `tail` or `rg` diagnosis without replaying effects; the session manager's ownership check remains required for session actions. Production: `runCommand` in `packages/tools/src/tools/shell.ts`. Test: `a failed noisy command keeps its first diagnostic and final tail without rerunning` in `packages/tools/tests/integration/common/session-log.test.ts`.

`poll`, `read`, `tail`, `status`, `stop`, and `list` require a session ID owned by the same agent and manager, except `list`, which needs no ID. Unknown, foreign, or closed-run IDs return `not_found` and never become PID authority. `list` is limited to session IDs and status, without command text or paths. `stop` signals the owned process tree and reports whether termination was confirmed; repeating it is safe. POSIX checks the process group even after the launcher exits. A retained Linux supervisor additionally owns the PID namespace boundary, so descendants inside that boundary are terminated with the supervisor; callers still provide no PID, socket or path authority. Production: `shellSession` in `packages/tools/src/tools/shell-session.ts`, `ExecutionSessionManager.getSession` and `LiveSession.stop` in `packages/tools/src/lib/execution-session.ts`, and `stopOwnedProcess` in `packages/tools/src/lib/process-owner.ts`. Test: `packages/tools/tests/integration/common/shell-session.test.ts`, `packages/tools/tests/integration/common/execution-session.test.ts`, and `packages/tools/tests/integration/native/retained-session-native.test.ts`.

`LiveSession.snapshot` projects `starting`, `running`, `exited_pending_status`,
`exited_draining`, or `closed` from one observed state. `poll` and `list` use that same snapshot;
physical exit before an exit code is reported as `exited_pending_status`, never simply as
`running: true`. Production: `LiveSession.snapshot` in
[execution-session.ts](../../packages/tools/src/lib/execution-session.ts) and `shellSession`
in [shell-session.ts](../../packages/tools/src/tools/shell-session.ts). Test: physical-exit
projection in [execution-session.test.ts](../../packages/tools/tests/integration/common/execution-session.test.ts).

The manager admits at most `maxSessions` tracked sessions. Finished entries may be evicted to make room; a live process tree keeps its slot. At run end, `close` seals admission and stops all tracked processes before the loop removes its own scratch. Failed physical confirmation or an exhausted cleanup budget retains that scratch. The loop does not adopt or clean temporary directories inferred from command text. `createAgentTools` exposes `close()` for its private manager. Production: `ExecutionSessionManager.launch` and `close` in `packages/tools/src/lib/execution-session.ts`, `createAgentToolsCapability` in `packages/loop/src/runtime/capabilities/tools.ts`, and `createAgentTools` in `packages/tools/src/index.ts`. Test: `packages/tools/tests/integration/common/execution-session.test.ts` and `packages/loop/tests/integration/tools.test.ts`.

## State and operator boundary

Session logs are separate from generic tool-response spills. A generic spill preserves one serialized tool response, which may already contain truncated streams; it is not the complete command log. The compaction marker calls it a “complete tool response”. Production: `createToolSpill` in `packages/loop/src/runtime/context/tool-spill.ts`, `appendToolMessage` in `packages/loop/src/runtime/context/live-context.ts`. Test: `packages/loop/tests/unit/context-compaction.test.ts` and `packages/loop/tests/integration/compaction-subagent-truncate.test.ts`.

The operator's local `!` command is a separate `@clarvis/code` path. It uses Bash on POSIX and reserves and observes conversation activity without invoking the agent tool dispatcher. Production: `runLocalBash` in `packages/code/src/adapters/local-shell.ts` and `runBangCommand` in `packages/code/src/run-host.ts`. Test: `packages/code/tests/integration/local-shell.test.ts` and `packages/code/tests/component/run-host.test.ts`.
