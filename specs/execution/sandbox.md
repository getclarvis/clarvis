# Native tool execution boundary

`@clarvis/sandbox` constructs trusted launch policies and OS-specific process
wrappers. Absence of an execution policy keeps the existing Host behavior in
`@clarvis/tools`. A Sandbox policy requires an execution port and backend; it
cannot silently dispatch native file handlers on Host. The file kernel selects
the policy from its global `isolation` settings snapshot for each run.

Production: `createExecutionPolicy` in `packages/sandbox/src/policy.ts`,
`prepareLaunch` in `packages/sandbox/src/launcher.ts`, `resolveConfig` in
`packages/tools/src/config.ts`, and `dispatch` in `packages/tools/src/core.ts`.
Test: `packages/sandbox/tests/unit/policy.test.ts` and
`packages/tools/tests/integration/native-sandbox.test.ts`.

## Policy and boundaries

The policy has `host` and `sandbox` modes, workspace `read-write` and
`read-only` access, and enabled or disabled network. The default values are
Host, read-write workspace and enabled network. Only the trusted caller can
construct the policy; tool arguments cannot replace it. The policy uses
`configurationRoots` and `globalPaths` from `@clarvis/paths` for `~/.agents`,
global workflows and the exact settings file. An explicit home root also
selects the default global root through `globalRoot`; an ambient `CLARVIS_HOME`
still selects the effective override. Explicit home credential
directories are denied. Absolute tool paths retain their meaning; the OS
boundary decides whether they are accessible. Installation roots are
canonicalized and rejected when they overlap the workspace or a writable
sandbox root, so the installed worker remains outside the agent's write surface.

Production: `createExecutionPolicy` and `assertExecutionPolicy` in
`packages/sandbox/src/policy.ts`; `resolveToolPath` in
`packages/tools/src/lib/paths.ts`. Test: `packages/sandbox/tests/unit/policy.test.ts`
and `packages/tools/tests/integration/open-authority.test.ts`.

The native backends allow host filesystem reads by default while denying writes
outside explicit grants. Executables, interpreters, modules and their symlinks
keep their host paths; neither the kernel nor tools maintains a tool catalog or
infers installation prefixes from `PATH`. The inherited shell `PATH` therefore
resolves visible host tools. Ordinary files outside the workspace, including
sibling repositories, are readable. This is not workspace-only read isolation.
The default private home paths are `.ssh`, `.aws`, `.config`, `.gnupg`, `.kube`,
`.docker`, `.npmrc`, `.netrc`, and `.git-credentials`. Custom denies extend this
set. Arbitrary sensitive files outside those paths are not discovered or hidden.
Tools must direct mutable caches or state to admitted write roots; their presence
does not override the network setting or grant host services and sockets.

Production: `createExecutionPolicy` in `packages/sandbox/src/policy.ts`,
`BubblewrapBackend.prepare` in `packages/sandbox/src/linux/bubblewrap.ts`, and
`seatbeltProfile` in `packages/sandbox/src/macos/seatbelt.ts`. Test: `host tools
resolve symlinks, interpreters and modules without tool-specific grants` in
`packages/sandbox/tests/integration/host-tools-native.test.ts` and
`packages/sandbox/tests/integration/linux-native.test.ts`.

The Linux backend starts from a read-only bind of the host root. It replaces
`/proc` and `/dev` with sandbox views and masks `/sys`. It binds the workspace
according to policy and the real `/tmp` and `/dev/shm` read-write when present.
Mounts apply from ancestors to descendants, so a home or read-only workspace
inside a temporary root stays read-only. Narrower explicit write grants remain
available. It projects the
global root as read-only and overlays only `workflows` and the settings file
for writes. An absent settings file cannot be created in that projection.
Compatibility files such as `/etc/resolv.conf` and `/etc/nsswitch.conf` retain
their original paths and host symlinks through the root bind.
The host root and directory deny masks are remounted read-only. File
denies bind a packaged zero-permission mask, so neither a readable placeholder
nor a writable synthetic path stands in for denied host data.
`~/.agents` is a separate writable exception. Temporary roots are shared with
the host and provide no isolation between runs. A file deliberately placed in
them is accessible unless a specific deny masks it.
Native canaries verify that the home exceptions remain writable with a read-only
workspace while credential directories, private global
siblings, and symlinks to private global data remain inaccessible to shell and
file tools.
The compiled launcher sets `no_new_privs` and passes a seccomp filter to
Bubblewrap. The filter denies creation of AF_UNIX and AF_VSOCK sockets in both
network modes, preventing connections to administrative sockets even when their
path is in shared `/tmp`. With network disabled, the network namespace and
connection syscall restrictions block network access while preserving the
worker's inherited stdout channel. Tool and shell launches inherit only their intended
standard streams; a native probe checks that no launcher control descriptor
reaches the child. The same probe opens the admitted character devices, checks
that `/dev/mem` is absent, and verifies that a host PID cannot be signaled
through the PID namespace. The build records hashes of the launcher, packaged Bubblewrap,
and deny mask in a versioned manifest; the backend verifies them before use.
The backend probes a trusted system command under the selected namespace,
seccomp, and network settings before the caller's command is admitted. Success
is cached by helper identity and network mode. A failed probe is a pre-launch
`sandbox_unavailable` result, eligible for only the authorized Host recovery.
Native canaries exercise both binary selections, AF_UNIX/AF_VSOCK denial, blocked IPv4/IPv6 TCP and
UDP connection syscalls with network disabled, and a TCP connection to a local
host server with network enabled. A local TLS canary resolves `localhost`,
validates a disposable certificate in the sandbox, and confirms that the same
connection fails with network disabled. A missing deny target inside a writable mount
fails setup before launch because creating a mountpoint there would change the
host directory. The same rule applies to an absent private global root under a
writable mount. Existing symlink denies mask their canonical target, including
when it is outside the home directory. The packaged binary still depends on
compatible target system libraries.

Production: `BubblewrapBackend.prepare` in
`packages/sandbox/src/linux/bubblewrap.ts`, `main` in
`packages/sandbox/native/linux-launcher.c`, and the asset build in
`packages/sandbox/tooling/build-native.ts`. Test:
`packages/sandbox/tests/integration/linux-native.test.ts`.

The macOS backend generates a Seatbelt profile and reports
`pidNamespace: false`, `mountNamespace: false`, and `ipcNamespace: false`.
Its profile admits host reads and does not create `/dev/shm`.
Only `/dev/null`, `/dev/random`, and `/dev/urandom` receive device file rules;
the process may signal itself while other signal authority stays closed by
default.
Broad read and temporary write grants use `require-not` filters for the private
global root, including canonical aliases; an allow rule for workflows or the
exact settings file can then grant only that exception. Temporary grants also
exclude the home and a read-only workspace when they contain them; explicit
workspace and scratch grants can admit narrower writes. Explicit credential and
custom denies, including canonical aliases, remain final rules. Installation roots
inside private global state are rejected during policy construction.
A temporary root equal to the global root is rejected; a narrower run scratch
inside it remains an explicit exception.
It denies AF_UNIX socket creation in either network mode so an allowed temporary
path cannot by itself expose an administrative socket.
It grants metadata traversal only on ancestors of allowed paths so runtime
resolution can reach them without allowing directory contents. The profile has
unit coverage for escaping, traversal and workspace read-only mode. Its native
canary places home, workspace and a sibling repository outside the writable
scratch roots, then checks private global siblings, credential denial, sibling
read access with write denial, symlink denial, read-only workspace and the real `/tmp`.
The separate installed-tool canary executes an unknown command through a symlink and host
interpreter. The macOS runner's `/usr/bin/git` launcher can invoke developer-tool setup inside
Seatbelt, so the native boundary test does not use it as a generic execution probe.
Another canary redirects global state inside the real `/tmp` and checks the
private subtree, exact settings file, workflows, and absent settings. A third
uses a disposable local TLS server to compare enabled and disabled network
profiles without public internet. CI executes these canaries on macOS Intel
and ARM64 runners.

Production: `SeatbeltBackend.prepare` and `seatbeltProfile` in
`packages/sandbox/src/macos/seatbelt.ts`. Test:
`packages/sandbox/tests/unit/seatbelt-profile.test.ts`,
`packages/sandbox/tests/unit/policy.test.ts`, and
`packages/sandbox/tests/integration/macos-native.test.ts`.

## Tool integration and recovery

The `isolation` block in global `settings.json` owns `mode: host|sandbox`,
`workspace: read-only|read-write`, and `network: enabled|disabled`. Missing
fields resolve to Host, read-write, enabled. Workspace `settings.json` may
contain the block but it has no effect; it produces no trust prompt or refusal.
Global partial edits retain the other fields. Host ignores the workspace and
network preferences. The global settings file is agent-writable, so a later
valid edit changes future runs, while the active run retains its admission
snapshot. This is preferential isolation: an automatic Host fallback has Host
filesystem and network authority and is reported as such.

Production: `isolationSettingsSpec` and `resolveIsolationSettings` in
`packages/kernel/src/config/isolation-settings.ts`, `operatorLayers` in
`packages/kernel/src/config/file-config-store.ts`, `createIsolationService` in
`packages/kernel/src/execution/isolation-service.ts`, and `prepareKernelRun` in
`packages/kernel/src/runs/prepare-run.ts`. Test:
`packages/kernel/tests/integration/isolation-settings.test.ts` and
`packages/kernel/tests/unit/isolation-service.test.ts`.

The kernel binds the owner and execution ID before the tools capability activates.
Internal Goal and Memory runs that invoke the loop directly create and release
the same binding around execution; a missing identity fails before activation.
The tools capability receives one policy, backend and worker per run; agents
share the run boundary but keep their own session identity. Workflow leaders
inherit the manager's preference, and a missing binding fails explicitly.
The kernel identifies its own Bun executable directory, source worker and
product directory as installation roots when constructing a Sandbox policy,
so policy validation keeps trusted product code outside writable grants.
Host filesystem reads supply tool availability independently of those roots.
The tools capability closes sessions and the worker before releasing its scratch.
Providers, hooks, MCP transports and operator shell are outside this selector.
`shell_session` observes or stops a run-owned process through the Host session
manager; it does not launch a command or claim a new Sandbox attempt.
The loop advertises only mounted temporary roots to the native file worker;
an inherited Host `TMPDIR` outside the Sandbox mounts is omitted from worker
configuration. Host mode retains its accessible system temporary roots.
Production: `temporaryRootsForExecution` in
`packages/loop/src/runtime/capabilities/tools.ts`. Test:
`sandbox workers receive only mounted temporary roots` in
`packages/loop/tests/unit/tools-temporary-roots.test.ts`.

Production: `createRunService` in `packages/kernel/src/runs/run-service.ts`,
`createWorkflowsService` in `packages/kernel/src/workflows/workflows-service.ts`,
`createAgentToolsCapability` in `packages/loop/src/runtime/capabilities/tools.ts`,
`executeWithIsolationBinding` in `packages/kernel/src/execution/isolation-service.ts`,
and `createIsolationService` in that file.
Test: `packages/kernel/tests/unit/isolation-service.test.ts`,
`packages/kernel/tests/integration/goal-formulate-service.test.ts`, and
`packages/loop/tests/integration/tools.test.ts`, plus
`packages/tools/tests/unit/execution-coordinator.test.ts` for session control.

`CoordinatedToolExecutor` falls back to Host after pre-launch failure, caches
that unavailability for the run, and retries a denied read once. A single-file
write or edit rejected by the read-only workspace mount with `EROFS` also
retries once in Host because that mount could not modify the target. The exact
settings file can recover in Host when an atomic staged write cannot proceed.
An OS-confirmed Sandbox denial establishes backend availability even when the
logical operation then recovers in Host.
An uncertain or partially started mutation is never replayed automatically;
later operations remain available. A typed shell denial or uncertain outcome
issues a one-use recovery token tied to the agent. A follow-up `shell` call can
use `execution_strategy: host_recovery` with that token. The runtime does not
inspect shell text to classify denial. The ordinary `shell` tool schema omits
recovery fields so a model cannot infer a Host continuation before a denial
has issued a token; dispatch still accepts the explicit fields on a follow-up
call. Tool results and trace/protocol events carry requested/effective mode,
backend, policy and attempt identity; a Host
result does not claim Sandbox network restrictions.
Failed Sandbox calls retain typed execution identity in dispatch metadata and
their serialized error. A shell recovery token remains visible in the error
returned to the model, while trace and protocol carry the operation's mode.
Cached unavailability and token-driven continuation list only their actual
Host attempt; a fresh denial or setup failure lists both the failed Sandbox
attempt and the Host recovery.

Production: `CoordinatedToolExecutor` in
`packages/tools/src/execution/coordinator.ts`, `REAL_AGENT_TOOLS_ADAPTER` in
`packages/loop/src/runtime/tools/builtin/toolset.ts`, and `engineEventToProto`
in `packages/kernel/src/runs/map-events.ts`. Test:
`packages/tools/tests/unit/execution-coordinator.test.ts` and
`packages/kernel/tests/contract/transport-codecs.test.ts` and
`packages/tools/tests/component/core.test.ts` and
`packages/tools/tests/component/tool-surface.test.ts`.

`dispatch` validates the selected tool and arguments before invoking an optional
`ToolExecutionPort`. `SandboxToolExecutor` starts one source worker under the
policy and sends only typed tool operations through bounded frames. The worker
validates identity and schema again and executes complete file handlers in its
own process. Shell remains under `ExecutionSessionManager`, which can launch
each command using the same policy and sets its `HOME` and `CLARVIS_HOME` to
the policy roots. The standalone toolset defaults to the
in-process Host port. The worker is loaded from the installed `@clarvis/tools`
source package, outside the selected workspace. Its versioned
manifest binds the source hash to the OS, architecture, protocol and required
executables; `SandboxToolExecutor` verifies it before launch.
Sandbox results identify the effective backend, policy, and that the operation
started. Setup failures carry the selected backend and policy with
`execution_started: false`; worker handler failures and unknown outcomes carry the same
identity with the operation-started flag. A completed shell result also carries
an `ExecutionDiagnostic` with bounded stdout and stderr. A nonzero physical exit
is `command_failed`; output text alone never establishes `sandbox_denied`.
For file tools, `sandbox_denied` requires a filesystem permission error at an
explicit policy deny, or `EROFS` inside a read-only workspace. Other permission
failures retain their ordinary tool error.
The shell result keeps its exit code and does not become a tool dispatch error.
An authorized Host fallback carries a Host diagnostic with the original policy
identifier.

Production: `dispatch` in `packages/tools/src/core.ts`, `SandboxToolExecutor`
in `packages/tools/src/execution/sandbox.ts`, `handle` in
`packages/tools/src/execution/worker.ts`, and `ExecutionSessionManager.launch`
in `packages/tools/src/lib/execution-session.ts`; asset build in
`packages/tools/tooling/build-worker.ts`. Test:
`packages/tools/tests/integration/native-sandbox.test.ts` (including disabled-network worker I/O) and
`packages/tools/tests/integration/worker-manifest.test.ts` and
`packages/tools/tests/contract/worker-protocol.test.ts` and
`packages/tools/tests/component/core.test.ts`, plus `serializeError` in
`packages/tools/src/errors.ts` and
`packages/tools/tests/unit/errors.test.ts` for pre-launch diagnostics.
`resultDiagnostic` in `packages/tools/src/execution/diagnostics.ts` owns the
command classification, covered by the native tools test.

`CoordinatedToolExecutor` serializes file mutations. A Host fallback requires
authorization in its constructor, follows a pre-launch `SandboxSetupError`, a
safe read denial, a proven read-only single-file denial, or an atomic settings
staging failure, and marks the result
as Host. Backend unavailability is cached for that run. An operation whose
worker dies after admission has an unknown outcome and is not replayed;
subsequent operations start a fresh worker after termination is confirmed. Worker shutdown confirms the owned
process tree before releasing its queue; an unconfirmed stop is reported during
close. Shell and external processes are outside the native file mutation queue.
Native tests distinguish direct sandboxed writes to the exact settings file
from atomic replacement and creation, which use the marked Host recovery when
the projection denies staging. The exact settings target is compared through
its nearest existing canonical ancestor so macOS `/var` aliases and an absent
configuration directory retain that recovery. Seatbelt
`EPERM` also qualifies for a single-file mutation in a read-only workspace
outside explicit denies.
Other denied paths retain their Sandbox error.

Production: `CoordinatedToolExecutor` in
`packages/tools/src/execution/coordinator.ts` and `SandboxToolExecutor.onWorkerExit`
in `packages/tools/src/execution/sandbox.ts`. Test:
`packages/tools/tests/unit/execution-coordinator.test.ts` and
`packages/tools/tests/integration/native-sandbox.test.ts`.

This boundary does not eliminate the documented pathname TOCTOU, hardlink
aliasing, or access to shared temporary files. Full macOS native evidence,
qualification of the packaged Linux binary across supported targets remain
unverified in this environment.
