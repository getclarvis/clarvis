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
absolute paths remain absolute. The selected execution policy and host filesystem permissions
determine access.
File-tool paths reject `~` shorthand; use absolute paths or workspace-relative paths.
Recursive filename and content searches use `shell` when that tool is available; the catalog has
no dedicated `glob` or `grep` tool.
`secretEnvNames` filters credential variables from command environments.
Trusted callers may provide a Sandbox policy, native backend and execution port.
Sandbox shell children receive `HOME` and `CLARVIS_HOME` from that policy.
They retain the host `PATH`; native backends admit host reads with private-path
denies and restrict writes to policy grants. Installed tools need no registration.
Mutable caches must use an admitted writable directory such as `TMPDIR`.
When the host explicitly authorizes recovery, a file mutation denied by a
read-only workspace can retry on Host; mandatory read-only and explicit deny paths cannot use that retry.
`shell_session` observes or stops an owned command through the Host session
manager and does not claim a new sandboxed launch.
`readOnly` controls the advertised tool surface independently of the Sandbox
workspace access preference.

Production: `toolDescriptors` in [registry.ts](src/tools/registry.ts),
`dispatch` in [core.ts](src/core.ts), and `resolveFileToolPath` in
[paths.ts](src/lib/paths.ts). Test: [tool-surface.test.ts](tests/integration/common/tool-surface.test.ts)
and [open-authority.test.ts](tests/integration/common/open-authority.test.ts).

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
File mutations already covered by `executionPolicy.additionalWriteRoots` request no new permission;
read-only paths retain precedence. Production: `prepareToolAction` in
[action.ts](src/execution/action.ts). Test:
[action-authorization.test.ts](tests/integration/common/action-authorization.test.ts).

## Execution and limits

`shell` can return a live `session_id` when `yield_time_ms` expires.
`shell_session` polls, stops or lists only sessions owned by the same run and
agent. Output capture uses bounded per-stream windows. Text reads use bounded
descriptor reads and reject non-regular files. An omitted or empty cursor
starts a `shell_session` read at the first retained output page.
The session manager owns one clock, timer scheduler and tree-ownership adapter;
its shell handler uses that same clock for yield and duration. Defaults probe and
signal the real owned process tree. Controlled tests deliver child events and
advance time without running commands; physical integration tests retain signal,
pipe and process-group evidence. Production: `ExecutionSessionManager`,
`stopOwnedProcess` and `runCommand` in `src/lib/execution-session.ts`,
`src/lib/process-owner.ts` and `src/tools/shell.ts`. Test:
`tests/unit/execution-session-policy.test.ts`,
`tests/unit/process-owner-policy.test.ts` and
`tests/integration/common/process-owner.test.ts`.
`list` ignores session, cursor and wait fields; `stop` ignores cursor and wait
fields while still requiring a run-owned session ID.
`read_image` recognizes PNG, JPEG, GIF and WebP from bytes. `apply_patch` stages a complete multi-file
transaction and commits atomically. Standalone callers default to Host. The file Kernel defaults
to Sandbox and binds its action-authorization port after argument validation. The file worker and
each new shell command use the selected native launch boundary; writes outside admitted roots
require an eligible permission decision before execution.
If steering or a mode edit changes authorization during review, the dispatcher
requests a fresh decision with current authorization and policy revisions for the same final
action before launch. The Kernel's
inspection runner uses this toolset behind a read-only native Sandbox and exposes
only read, list, image and shell tools to its reviewer. Production: `dispatch` in
`src/core.ts` and `createJudgeRunner` in
`packages/kernel/src/execution/judge-runner.ts`. Test:
`tests/integration/common/action-authorization.test.ts` and
`packages/kernel/tests/integration/judge-runner.test.ts`.

Production: `readRawFile` in [files.ts](src/lib/files.ts),
`ExecutionSessionManager` in [execution-session.ts](src/lib/execution-session.ts),
and `applyOpsAtomic` in [atomic.ts](src/lib/atomic.ts).
Test: [bounded-read.test.ts](tests/integration/common/bounded-read.test.ts),
[execution-session.test.ts](tests/integration/common/execution-session.test.ts), and
[atomic.test.ts](tests/integration/common/atomic.test.ts).

## Entry points

| Import                 | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `@clarvis/tools`       | Toolset, dispatch, registry, configuration and process helpers |
| `@clarvis/tools/shell` | Shell and process helpers without loading the registry         |

Run `bun --filter @clarvis/tools build`, `typecheck`, `test`, `lint` and
`format:check` from the repository root during development. The root
`bun run test` script runs the supported workspace suite.

## Test suites

`bun --filter @clarvis/tools test:fast` runs the in-memory unit cases. `bun --filter @clarvis/tools test:integration` runs this package's common physical test cases. `bun --filter @clarvis/tools test` runs the full package suite; `test:coverage` remains the consolidated coverage entrypoint.

The script definitions are in [`package.json`](package.json); test levels and resource ownership are
defined in [test architecture](../../specs/cross-cutting/test-architecture.md).

## Private source imports

This package owns the `#src/*.ts` mapping in [`package.json`](package.json). Long imports within its
`src`, and package tests or tooling that access its implementation, use `#src/...ts`. Nearby
relatives keep their actual source extension; other workspaces use public `@clarvis/tools`
exports. Bun tests and the development typecheck select source without a prior build. The build profile
clears the `bun` condition and emits its own JavaScript and declarations under `dist`.
See [package architecture](../../specs/cross-cutting/package-architecture.md) for ownership and
[build and CI](../../specs/cross-cutting/build-and-ci.md) for resolution and emit checks.
