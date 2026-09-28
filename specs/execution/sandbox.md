# Native tool execution boundary

The TUI requires an explicit scope confirmation before switching an existing Sandbox preference
to Host. That preference affects built-in tools; `forbidden` rules still prevent their matching
actions. Remembering a literal argv prefix may make every fully understood segment eligible for
Host bypass only when each has an explicit allow and no mandatory read-only or deny-read requirement
applies. Production:
`IsolationPicker` in `packages/code/src/views/overlays/IsolationPicker.tsx`,
`createApprovalService` in `packages/kernel/src/execution/approval-service.ts`. Test:
`packages/code/tests/integration/app-shell-render.test.tsx` and
`packages/kernel/tests/integration/approval-policy.test.ts`.

`@clarvis/sandbox` translates a host-owned execution profile into a native process boundary. The file Kernel defaults to Sandbox, read-write workspace, broad filesystem reads and disabled network. The profile is captured for the run; each permission delta is selected for one authorized action. Host means an explicit unrestricted selection, never recovery from a backend failure. Providers, trusted hooks, MCP transports, Kernel persistence and the operator's `!` shell are outside this native tool boundary. Production: `resolveIsolationSettings` in `packages/kernel/src/config/isolation-settings.ts`, `createIsolationService` in `packages/kernel/src/execution/isolation-service.ts`, `createExecutionPolicy` in `packages/sandbox/src/policy.ts`. Test: `packages/kernel/tests/integration/isolation-settings.test.ts`, `packages/kernel/tests/integration/approval-policy.test.ts`.

## Policy and native projection

The Sandbox profile admits ordinary reads anywhere the host user can read, writes in the workspace and admitted temporary roots, and the configured network mode. Additional write roots, read-only subtrees and explicit deny-read paths come from the trusted host policy or an approved action delta. There is no implicit deny-read list for home credentials and no unconditional settings, plugin or workflow write exception. The workspace metadata directories `.git`, `.clarvis`, `.agents` and `.aws`, including a linked worktree gitdir, remain read-only by default. `@clarvis/paths` supplies product path conventions. An approved exact metadata root can be writable for one action unless a host read-only requirement still covers it. Installation roots remain outside writable grants. A read-only workspace grants no product write root; private executor scratch is separate from action targets. Production: `createExecutionPolicy` in `packages/sandbox/src/policy.ts`, `prepareToolAction` in `packages/tools/src/execution/action.ts`, `selectAuthorizedExecution` in `packages/kernel/src/execution/isolation-service.ts`. Test: `packages/sandbox/tests/integration/common/policy.test.ts`, `packages/sandbox/tests/integration/native/linux-native.test.ts`, `packages/tools/tests/integration/native/native-sandbox.test.ts`.

Linux starts with a read-only bind of the host root, then mounts admitted write roots and remounts protected subtrees read-only. It uses private process and network namespaces, bounded device views, and a compiled launcher with `no_new_privs` and seccomp. Disabled network separates the process from host network endpoints; local Unix sockets remain usable where their path is visible. The backend probes its helper before action launch and reports setup failure if it cannot construct the boundary. It never runs the action on Host as recovery. Production: `BubblewrapBackend.prepare` in `packages/sandbox/src/linux/bubblewrap.ts`, `main` in `packages/sandbox/native/linux-launcher.c`. Test: `packages/sandbox/tests/integration/native/linux-native.test.ts`, `packages/sandbox/tests/integration/native/host-tools-native.test.ts`.
Linux retained sessions use that same Bubblewrap boundary and require its PID namespace capability. `shell.keep_alive` is rejected before spawn on Host, macOS Seatbelt, or a scoped permission-delta policy; there is no Host fallback. The host verifies the immutable `session-supervisor.ts` source against `packages/tools/assets/worker.manifest.json`, launches it inside the boundary, and sends the original shell file/argv, cwd and selected environment as one bounded bootstrap frame. The supervisor closes command stdin, keeps only its run-owned controller lease open, and emits bounded versioned control frames with separately encoded stdout/stderr payloads. A zero initializer exit retains the boundary; a failure, invalid frame, unexpected EOF or supervisor bootstrap error closes it. The run timeout includes the retained phase, and stop/timeout/cancellation/close require physical termination confirmation. Production: `ExecutionSessionManager.prepareSupervisor` in `packages/tools/src/lib/execution-session.ts`, `SupervisorChild` in `packages/tools/src/execution/session-supervisor.ts`, and `BubblewrapBackend.prepare` in `packages/sandbox/src/linux/bubblewrap.ts`. Test: `packages/tools/tests/integration/common/session-supervisor.test.ts` and `packages/tools/tests/integration/native/retained-session-native.test.ts`.

macOS Seatbelt projects broad reads, explicit write roots, protected metadata, explicit deny-read paths and network selection. It reports that PID, mount and IPC namespaces are unavailable on that platform. Local Unix sockets are allowed where the filesystem profile permits them. Profiles are escaped and canonical paths are accounted for. Production: `seatbeltProfile` and `SeatbeltBackend.prepare` in `packages/sandbox/src/macos/seatbelt.ts`. Test: `packages/sandbox/tests/integration/common/seatbelt-profile.test.ts`, `packages/sandbox/tests/integration/native/macos-native.test.ts`.

Temporary roots are shared with the host and are not private data storage. Host-user permissions, pathname races, hardlink aliases and code executing as the same user limit confidentiality. A denied read remains denied even when all command segments match explicit allow rules; that bypass cannot select Host. Production: `createExecutionPolicy` in `packages/sandbox/src/policy.ts`, `createApprovalService` in `packages/kernel/src/execution/approval-service.ts`. Test: `packages/sandbox/tests/integration/common/policy.test.ts`, `packages/kernel/tests/integration/approval-policy.test.ts`.

## Tool execution and failure

`execution_requirements.read_only_paths` and `deny_read_paths` are mandatory boundaries, distinct
from the overridable workspace preference. Host cannot enforce them, so both initial Host selection
and per-action Host escalation are refused when either is present. An approved additional write
root at or inside the workspace can override the workspace preference on Linux and macOS;
mandatory read-only paths remain protected. Production: `createApprovalService` in
[approval-service.ts](../../packages/kernel/src/execution/approval-service.ts),
`createIsolationService` in [isolation-service.ts](../../packages/kernel/src/execution/isolation-service.ts),
and `seatbeltProfile` in [seatbelt.ts](../../packages/sandbox/src/macos/seatbelt.ts).
Test: `mandatory filesystem requirements survive approved deltas and reject Host execution` in
[isolation-service.test.ts](../../packages/kernel/tests/integration/isolation-service.test.ts) and
[scoped-writes-native.test.ts](../../packages/sandbox/tests/integration/native/scoped-writes-native.test.ts).

The trusted `sharedTemporaryWrites` option defaults to true for ordinary tool policies. The
inspection runner sets it to false: neither backend adds its usual shared system temporary write
grants, and only the explicitly supplied scratch is writable. Production: `createExecutionPolicy`
in [policy.ts](../../packages/sandbox/src/policy.ts), `BubblewrapBackend.prepare` in
[bubblewrap.ts](../../packages/sandbox/src/linux/bubblewrap.ts), `seatbeltProfile` in
[seatbelt.ts](../../packages/sandbox/src/macos/seatbelt.ts), and `createJudgeRunner` in
[judge-runner.ts](../../packages/kernel/src/execution/judge-runner.ts). Test:
[seatbelt-profile.test.ts](../../packages/sandbox/tests/integration/common/seatbelt-profile.test.ts),
[scoped-writes-native.test.ts](../../packages/sandbox/tests/integration/native/scoped-writes-native.test.ts),
and `inspection reads but cannot change workspace data` in
[judge-runner.test.ts](../../packages/kernel/tests/integration/judge-runner.test.ts).

`dispatch` validates and coerces a cloned action before the host authorization port decides it. Builtin file and shell tools use the selected policy. The file worker validates tool identity and schema again inside the sandbox; shell children use the same policy through `ExecutionSessionManager`. A selected permission delta creates a scoped profile for that action. `shell_session` only observes or stops a run-owned process and does not launch another command. Production: `dispatch` in `packages/tools/src/core.ts`, `SandboxToolExecutor` in `packages/tools/src/execution/sandbox.ts`, `ExecutionSessionManager.launch` in `packages/tools/src/lib/execution-session.ts`. Test: `packages/tools/tests/integration/common/action-authorization.test.ts`, `packages/tools/tests/integration/native/native-sandbox.test.ts`, `packages/tools/tests/integration/common/shell-session.test.ts`.

A pre-launch setup failure has `execution_started: false`. A failure or denial after admission may have effects; an uncertain outcome is never replayed automatically. Backend unavailability is cached only to avoid repeated probes. The next action still passes policy and either uses an explicitly authorized profile or fails. `CoordinatedToolExecutor` retains file-mutation serialization and does not issue a Host recovery token. Tool results carry the requested/effective mode, policy and backend when known; shell diagnostics distinguish physical exit from OS sandbox denial. Production: `CoordinatedToolExecutor` in `packages/tools/src/execution/coordinator.ts`, `resultDiagnostic` in `packages/tools/src/execution/diagnostics.ts`. Test: `packages/tools/tests/unit/execution-coordinator.test.ts`, `packages/tools/tests/integration/native/native-sandbox.test.ts`.
