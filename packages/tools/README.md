# `@clarvis/tools`

Coding tools for Clarvis agents and standalone TypeScript callers. This private
workspace package depends on `@clarvis/paths`. Its contracts are
[dispatch](../../specs/execution/tools-contract.md),
[reading and listing](../../specs/execution/tools-read.md),
[mutations](../../specs/execution/tools-mutation.md), and
[shell sessions](../../specs/execution/tools-shell-and-sessions.md).

## Tools and authority

The registry exposes nine tools. `read_file`, `read_image` and `list_dir` are
observing tools. `write_file`, `edit_file`, `apply_patch`, `remove`, `shell` and
`shell_session` can change state. `readOnly: true` advertises and dispatches only
the three observing tools. Relative file paths resolve from `workspaceRoot`;
absolute paths remain absolute. Host filesystem permissions determine access.
`secretEnvNames` filters credential variables from command environments.

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

## Execution and limits

`shell` can return a live `session_id` when `yield_time_ms` expires.
`shell_session` polls, stops or lists only sessions owned by the same run and
agent. Output capture uses bounded per-stream windows. Text reads use bounded
descriptor reads and reject non-regular files. `read_image` recognizes PNG,
JPEG, GIF and WebP from bytes. `apply_patch` stages a complete multi-file
transaction and commits atomically. The file and command tools use host
permissions; the dispatcher applies no extra path approval gate.

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
