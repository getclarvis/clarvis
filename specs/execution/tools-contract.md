# The tool contract: dispatch, configuration and advertised surface

## Purpose

`@clarvis/tools` exposes a fixed catalog of coding tools. `dispatch` validates a cloned argument
object against the selected tool's schema, invokes its handler and bounds the result. There is no
command approval or file mutation review gate in this dispatcher. Relative file paths use the
workspace as their base; absolute paths remain absolute. Host filesystem permissions and the
configured native sandbox determine actual access.

Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts), `resolveConfig` in
[config.ts](../../packages/tools/src/config.ts), and `resolveToolPath` in
[paths.ts](../../packages/tools/src/lib/paths.ts).
Test: [core.test.ts](../../packages/tools/tests/component/core.test.ts),
[open-authority.test.ts](../../packages/tools/tests/integration/open-authority.test.ts), and
[sandbox.test.ts](../../packages/tools/tests/integration/sandbox.test.ts).

## Package surface

The [manifest](../../packages/tools/package.json) publishes the root facade, `./shell`,
`./sandbox` and `./package.json`. The root exports `createAgentTools`, `dispatch`, `listTools`,
configuration and result types, the tool registry, shell/process helpers, sandbox configuration
and the warning sink. `./shell` allows hooks and kernel consumers to load shell/process helpers
without loading the registry. `./sandbox` exposes native sandbox policy and probes.

Production: exports in [index.ts](../../packages/tools/src/index.ts),
[shell-entry.ts](../../packages/tools/src/shell-entry.ts), and
[sandbox-entry.ts](../../packages/tools/src/sandbox-entry.ts).
Test: [api.test.ts](../../packages/tools/tests/integration/api.test.ts) and
[tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts).

The ordered `toolDescriptors` table in [registry.ts](../../packages/tools/src/tools/registry.ts)
owns all 20 names. `readOnlyTools` is its nine-tool observing projection:
`read_file`, `read_image`, `read_files`, `list_dir`, `glob`, `grep`, `diff`, `file_stat` and `tree`.
The full projection also contains `write_file`, `edit_file`, `multi_edit`, `apply_patch`, `replace`,
`shell`, `shell_session`, `move`, `copy`, `mkdir` and `remove`. `listTools` advertises the
projection selected by `RuntimeConfig.readOnly`; `dispatch` selects from that same projection.

Production: `toolDescriptors`, `readOnlyTools` and `selectSurface` in
[registry.ts](../../packages/tools/src/tools/registry.ts), and `listTools` in
[core.ts](../../packages/tools/src/core.ts).
Test: [tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts) and
[core.test.ts](../../packages/tools/tests/component/core.test.ts).

## Runtime configuration and results

`resolveConfig` requires an existing directory for `workspaceRoot`, validates numeric ceilings,
probes ripgrep and resolves the filesystem policy. A toolset owns a session manager unless the
host supplies one. `readOnly` defaults to false. Limits cover text and shell output, input file
and image sizes, traversal, mutation bytes, diff input, metadata, shell duration, sessions and
regular-expression scan time. `secretEnvNames` is host supplied and removed from spawned command
environments. `stateRoot` stores run machinery; it is not a separate tool read gate.

Production: `RuntimeConfig`, `AgentToolsOptions` and `resolveConfig` in
[config.ts](../../packages/tools/src/config.ts), and `resolveFilesystemPolicy` in
[sandbox.ts](../../packages/tools/src/sandbox.ts).
Test: [config.test.ts](../../packages/tools/tests/integration/config.test.ts),
[no-isolation.test.ts](../../packages/tools/tests/integration/no-isolation.test.ts), and
[sandbox.test.ts](../../packages/tools/tests/integration/sandbox.test.ts).

`DispatchResult` reports failures in band as `isError: true` with a serialized text part.
Unknown or unavailable tools return `not_found`; invalid arguments return `invalid_input`.
The caller's argument object is not mutated. Text parts from tools that do not self-bound are
clamped to `maxOutputBytes`; metadata is clamped to `maxToolMetaBytes` and retains a bounded
`diff` prefix when possible. File operations use `SandboxAgentFilesystem` only for native
sandbox placement and otherwise execute through the local file handler. `close` releases
run-owned command sessions.

Production: `dispatch`, `boundParts`, `boundMeta` and `localFilesystem` in
[core.ts](../../packages/tools/src/core.ts), `serializeError` in
[errors.ts](../../packages/tools/src/errors.ts), and `createAgentTools` in
[index.ts](../../packages/tools/src/index.ts).
Test: [core.test.ts](../../packages/tools/tests/component/core.test.ts),
[filesystem-service.test.ts](../../packages/tools/tests/integration/filesystem-service.test.ts),
and [api.test.ts](../../packages/tools/tests/integration/api.test.ts).

## Invariants and coupling

- The advertised and dispatchable tool names come from one registry. Production:
  `selectSurface` in [registry.ts](../../packages/tools/src/tools/registry.ts). Test:
  [tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts).
- A validated tool call does not pass through a Shell Guard or Judge. Production: `dispatch` in
  [core.ts](../../packages/tools/src/core.ts). Test:
  [open-authority.test.ts](../../packages/tools/tests/integration/open-authority.test.ts).
- The configured native sandbox remains the filesystem and command isolation boundary.
  Production: `resolveFilesystemPolicy` in [sandbox.ts](../../packages/tools/src/sandbox.ts)
  and `SandboxAgentFilesystem` in
  [filesystem-service.ts](../../packages/tools/src/filesystem-service.ts). Test:
  [sandbox.test.ts](../../packages/tools/tests/integration/sandbox.test.ts).

Read and search behavior belongs to [tools-read-and-search.md](tools-read-and-search.md),
mutations to [tools-mutation.md](tools-mutation.md), shell sessions to
[tools-shell-and-sessions.md](tools-shell-and-sessions.md), and native isolation to
[sandbox.md](sandbox.md).
