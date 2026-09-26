# `@clarvis/tools`

Coding tools for Clarvis agents and standalone TypeScript callers. This private
workspace package depends on `@clarvis/paths`. The host composes native isolation
through injected execution contracts without a runtime dependency on the sandbox package. Its contracts are
[dispatch](../../specs/execution/tools-contract.md),
[reading and listing](../../specs/execution/tools-read.md),
[mutations](../../specs/execution/tools-mutation.md), and
[shell sessions](../../specs/execution/tools-shell-and-sessions.md), and
[native execution](../../specs/execution/sandbox.md).

## Tools and authority

The registry exposes nine tools. `read_file`, `read_image` and `list_dir` are
observing tools. `write_file`, `edit_file`, `apply_patch`, `remove`, `shell` and
`shell_session` can change state. `readOnly: true` advertises and dispatches only
the three observing tools. Relative file paths resolve from `workspaceRoot`;
absolute paths remain absolute. Host filesystem permissions determine access.
`secretEnvNames` filters credential variables from command environments.
Trusted callers may provide a Sandbox policy, native backend and execution port.
Sandbox shell children receive `HOME` and `CLARVIS_HOME` from that policy.
They retain the host `PATH`; native backends admit host reads with private-path
denies and restrict writes to policy grants. Installed tools need no registration.
Mutable caches must use an admitted writable directory such as `TMPDIR`.
When the host explicitly authorizes recovery, a file mutation denied by a
read-only workspace can retry on Host; explicit deny paths cannot use that retry.
`shell_session` observes or stops an owned command through the Host session
manager and does not claim a new sandboxed launch.
`readOnly` controls the advertised tool surface independently of the Sandbox
workspace access preference.

Production: `toolDescriptors` in [registry.ts](src/tools/registry.ts),
`dispatch` in [core.ts](src/core.ts), and `resolveToolPath` in
[paths.ts](src/lib/paths.ts). Test: [tool-surface.test.ts](tests/component/tool-surface.test.ts)
and [open-authority.test.ts](tests/integration/open-authority.test.ts).

## Usage

```ts
import { createAgentTools } from "@clarvis/tools";

const agentTools = createAgentTools({ workspaceRoot: process.cwd() });
const available = agentTools.listTools();
const result = await agentTools.callTool("read_file", { path: "package.json" });
await agentTools.close();
```

`workspaceRoot` must be an existing directory. The toolset owns a session
manager unless the host supplies one. Call `close()` when finished so shell
sessions exit. `resolveConfig`, `listTools` and `dispatch` support host
integrations. The standalone library has no temporary roots by default; the
Clarvis loop supplies run-owned scratch and system temporary roots. The first
root becomes `TMPDIR`, `TEMP` and `TMP` for commands.
The optional `SandboxToolExecutor` runs file handlers in its source worker. Its
versioned manifest, generated at `assets/worker.manifest.json` and ignored by Git,
binds the worker source to an OS, architecture, protocol and
SHA-256 digest; a mismatch fails before launch.
Sandbox outcomes identify the selected backend and policy. Setup errors report
`execution_started: false`; worker handler failures and uncertain outcomes
report that execution started so callers do not replay effects blindly.
Failed Sandbox calls retain their execution identity in structured dispatch
metadata.
Completed sandboxed shell calls also return a typed diagnostic with the physical
exit status, bounded streams and `command_failed` for a nonzero exit; command
text is not denial evidence.
File access errors become `sandbox_denied` only when the OS reports a permission
failure at an explicit policy deny, or a read-only workspace write returns
`EROFS`.
The worker protocol test exercises real stdin/stdout frames, rejects shell and
invalid file operations, and closes on a version mismatch.
`CoordinatedToolExecutor` serializes mutations and caches backend unavailability
to avoid repeated probes. It never falls back to Host or replays an uncertain
mutation. Kernel-bound calls use a structural authorization port after final
schema validation; `shell.execution_permissions` can request Host, added write
roots or network for one action. A denied or uncertain result requires a fresh
action through the gate if the caller chooses to retry.
Worker shutdown waits for its process tree and reports an unconfirmed stop.

## Execution and limits

`shell` can return a live `session_id` when `yield_time_ms` expires.
`shell_session` polls, stops or lists only sessions owned by the same run and
agent. Output capture uses bounded per-stream windows. Text reads use bounded
descriptor reads and reject non-regular files. An omitted or empty cursor
starts a `shell_session` read at the first retained output page.
`list` ignores session, cursor and wait fields; `stop` ignores cursor and wait
fields while still requiring a run-owned session ID.
`read_image` recognizes PNG, JPEG, GIF and WebP from bytes. `apply_patch` stages a complete multi-file
transaction and commits atomically. Host remains the default. When a trusted
caller supplies a Sandbox policy and port, the file worker and each shell
command use the native launch boundary; the dispatcher applies no extra path
approval gate.
If steering or a mode edit changes authorization during review, the dispatcher
requests a fresh decision with current authorization and policy revisions for the same final
action before launch. The Kernel's
inspection runner uses this toolset behind a read-only native Sandbox and exposes
only read, list, image and shell tools to its reviewer. Production: `dispatch` in
`src/core.ts` and `createJudgeRunner` in
`packages/kernel/src/execution/judge-runner.ts`. Test:
`tests/unit/action-authorization.test.ts` and
`packages/kernel/tests/unit/judge-runner.test.ts`.

Production: `readRawFile` in [files.ts](src/lib/files.ts),
`ExecutionSessionManager` in [execution-session.ts](src/lib/execution-session.ts),
and `applyOpsAtomic` in [atomic.ts](src/lib/atomic.ts).
Test: [bounded-read.test.ts](tests/integration/bounded-read.test.ts),
[execution-session.test.ts](tests/integration/execution-session.test.ts), and
[atomic.test.ts](tests/integration/atomic.test.ts).

## Entry points

| Import                 | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `@clarvis/tools`       | Toolset, dispatch, registry, configuration and process helpers |
| `@clarvis/tools/shell` | Shell and process helpers without loading the registry         |

Run `bun --filter @clarvis/tools build`, `typecheck`, `test`, `lint` and
`format:check` from the repository root during development. The root
`bun run test` script runs the supported workspace suite.
