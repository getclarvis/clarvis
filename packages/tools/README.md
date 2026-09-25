# `@clarvis/tools`

Coding tools for Clarvis agents and standalone TypeScript callers. This is a private workspace
package; the root manifest owns the product version. Its only internal dependency is
`@clarvis/paths`.

The authoritative contracts are [tool dispatch](../../specs/execution/tools-contract.md),
[reads and search](../../specs/execution/tools-read-and-search.md),
[mutations](../../specs/execution/tools-mutation.md),
[shell and sessions](../../specs/execution/tools-shell-and-sessions.md).

## Tools and authority

The full registry has 20 tools. The nine observing tools are `read_file`, `read_image`,
`read_files`, `list_dir`, `glob`, `grep`, `diff`, `file_stat` and `tree`. The mutating tools are
`write_file`, `edit_file`, `multi_edit`, `apply_patch`, `replace`, `shell`, `shell_session`,
`move`, `copy`, `mkdir` and `remove`. `readOnly: true` advertises and dispatches only the
observing projection.

Commands and file calls do not pass through a Shell Guard, Judge, command allowlist, path
classification gate or configuration mutation review. Relative file paths resolve from
`workspaceRoot`; absolute paths remain absolute. Host calls use the process's filesystem
permissions. `secretEnvNames` keeps host-supplied credential variables out of
spawned command environments.

Production: `dispatch` in [core.ts](src/core.ts), `resolveToolPath` in
[paths.ts](src/lib/paths.ts).
Test: [open-authority.test.ts](tests/integration/open-authority.test.ts),
and [host-access.test.ts](tests/integration/host-access.test.ts).

## Usage

```ts
import { createAgentTools } from "@clarvis/tools";

const agentTools = createAgentTools({ workspaceRoot: process.cwd() });
const available = agentTools.listTools();
const result = await agentTools.callTool("read_file", { path: "package.json" });
await agentTools.close();
```

`workspaceRoot` must be an existing directory. `createAgentTools` resolves numeric limits,
probes ripgrep and owns a session manager unless
the host supplies one. Call `close()` after the final tool call so run-owned shell sessions exit.
The lower-level `resolveConfig`, `listTools` and `dispatch` exports support host integrations.
Callers that use `resolveConfig` directly close its session manager themselves.

```ts
const readOnly = createAgentTools({ workspaceRoot: process.cwd(), readOnly: true });
await readOnly.close();
```

The standalone library has no temporary roots by default; the Clarvis loop supplies run-owned
scratch followed by discovered system temporary roots. The first root becomes `TMPDIR`, `TEMP`
and `TMP` for commands.

## Execution and limits

`shell` can return a live `session_id` when `yield_time_ms` expires. `shell_session` polls,
stops or lists only sessions owned by the same run and agent. Shell output uses bounded in-memory
capture, per-stream cursors and omitted-byte counts. Generic oversized text results can spill to
the workspace's machine-state root. File tools can read a state path when the effective OS or
host OS permissions allow it; the dispatcher has no state-artifact special gate.

Text reads use a bounded descriptor read and reject non-regular files. `read_image` recognizes
PNG, JPEG, GIF and WebP by bytes and verifies a PNG's chunk stream. `readRawFile` exports the same
bounded descriptor primitive for trusted host consumers without adding a model tool. A single-file
ripgrep search uses a bounded snapshot on stdin; directory searches use the in-process scanner.
The regular-expression scan budget applies to in-process grep, replace and shell readiness
matching. Default limits include 50,000 traversal entries, 64 MiB mutation payload, 8 MiB
combined diff input and 256 KiB metadata. All can be overridden through `createAgentTools`.

`apply_patch` accepts the `*** Begin Patch` envelope and unified diffs. It stages a complete
multi-file transaction, checks UTF-8 and hunks, and commits atomically; a failed hunk changes
nothing. `copy`, `move`, `replace` and other mutations use the shared atomic machinery where
applicable. Access is still subject to host filesystem permissions.

Production: `readRawFile` in [files.ts](src/lib/files.ts), `ExecutionSessionManager` in
[execution-session.ts](src/lib/execution-session.ts), and `applyOpsAtomic` in
[atomic.ts](src/lib/atomic.ts). Test: [bounded-read.test.ts](tests/integration/bounded-read.test.ts),
[api.test.ts](tests/integration/api.test.ts), and [atomic.test.ts](tests/integration/atomic.test.ts).

## Entry points

| Import                 | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `@clarvis/tools`       | Toolset, dispatch, registry, configuration and shell/process helpers |
| `@clarvis/tools/shell` | Shell and process helpers without loading the tool registry          |

## Development

Run from the repository root:

```bash
bun --filter @clarvis/tools build
bun --filter @clarvis/tools typecheck
bun --filter @clarvis/tools test
bun --filter @clarvis/tools lint
bun --filter @clarvis/tools format:check
```

The package has component, contract, integration and architecture tests. The root `bun run test`
script runs the supported workspace suite.
