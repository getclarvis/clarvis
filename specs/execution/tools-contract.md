# The tool contract: dispatch, configuration and advertised surface

## Purpose

`@clarvis/tools` exposes a fixed catalog of coding tools. `dispatch` validates a cloned argument
object against the selected tool's schema, invokes its configured execution port and bounds the result.
The standalone default port invokes the handler on Host. A Kernel-bound toolset uses a structural authorization port after schema validation and before execution. Relative file paths
use the workspace as their base; absolute paths remain absolute. Host filesystem permissions
determine actual access.
If steering or a host policy edit changes the authorization revision during review, `dispatch`
reissues the same final action with current authorization and policy revisions before launch; a result
whose identity remains stale cannot execute. Production: `dispatch` in
[core.ts](../../packages/tools/src/core.ts). Test: `steering during review
requires a fresh authorization before execution` in
[action-authorization.test.ts](../../packages/tools/tests/unit/action-authorization.test.ts).

Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts), `resolveConfig` in
[config.ts](../../packages/tools/src/config.ts), and `resolveToolPath` in
[paths.ts](../../packages/tools/src/lib/paths.ts). Test:
[core.test.ts](../../packages/tools/tests/component/core.test.ts) and
[open-authority.test.ts](../../packages/tools/tests/integration/open-authority.test.ts).

## Package surface

The [manifest](../../packages/tools/package.json) publishes the root facade, `./shell` and
`./package.json`. The root exports `createAgentTools`, `dispatch`, `listTools`, configuration and
result types, the tool registry, shell/process helpers and the warning sink. `./shell` allows
hooks and kernel consumers to load shell/process helpers without loading the registry.

Production: exports in [index.ts](../../packages/tools/src/index.ts) and
[shell-entry.ts](../../packages/tools/src/shell-entry.ts). Test:
[api.test.ts](../../packages/tools/tests/integration/api.test.ts) and
[tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts).

The ordered `toolDescriptors` table in [registry.ts](../../packages/tools/src/tools/registry.ts)
owns all nine names. `readOnlyTools` is its three-tool observing projection:
`read_file`, `read_image` and `list_dir`. The full projection also contains
`write_file`, `edit_file`, `apply_patch`, `shell`, `shell_session` and `remove`. `listTools` advertises the
projection selected by `RuntimeConfig.readOnly`; `dispatch` selects from that same projection.

Production: `toolDescriptors`, `readOnlyTools` and `selectSurface` in
[registry.ts](../../packages/tools/src/tools/registry.ts), and `listTools` in
[core.ts](../../packages/tools/src/core.ts). Test:
[tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts) and
[core.test.ts](../../packages/tools/tests/component/core.test.ts).

## Runtime configuration and results

`resolveConfig` requires an existing directory for `workspaceRoot`, validates numeric ceilings. A toolset owns a session manager unless the host supplies one. `readOnly` defaults
to false. Limits cover text and shell output, input file and image sizes, traversal, mutation
bytes, diff input, metadata, shell duration, sessions and regular-expression scan time.
`secretEnvNames` is host supplied and removed from spawned command environments. A Sandbox policy
requires an execution port and backend; workspace filesystem access is separate from `readOnly`,
which selects the advertised tool surface. `stateRoot`
stores run machinery; it is not a separate tool read gate.

Production: `RuntimeConfig`, `AgentToolsOptions` and `resolveConfig` in
[config.ts](../../packages/tools/src/config.ts). Test:
[config.test.ts](../../packages/tools/tests/integration/config.test.ts) and
[host-access.test.ts](../../packages/tools/tests/integration/host-access.test.ts).

`DispatchResult` reports failures in band as `isError: true` with a serialized text part.
Unknown or unavailable tools return `not_found`; invalid arguments return `invalid_input`.
The caller's argument object is not mutated. Text parts from tools that do not self-bound are
clamped to `maxOutputBytes`; metadata is clamped to `maxToolMetaBytes` and retains a bounded
`diff` prefix when possible. When a diff exceeds the metadata budget, the actual
execution mode, backend, policy and typed diagnostic take priority over its preview.
Sandbox failures with an issued policy retain structured execution identity in
the error result metadata as well as the serialized error text. Error metadata
uses the same byte budget; oversized attempt detail is dropped before policy
identity.
File operations invoke local handlers. `close` releases run-owned
command sessions.

Production: `dispatch`, `boundParts` and `boundMeta` in
[core.ts](../../packages/tools/src/core.ts), `serializeError` in
[errors.ts](../../packages/tools/src/errors.ts), and `createAgentTools` in
[index.ts](../../packages/tools/src/index.ts). Test:
[core.test.ts](../../packages/tools/tests/component/core.test.ts),
[native-sandbox.test.ts](../../packages/tools/tests/integration/native-sandbox.test.ts), and
[api.test.ts](../../packages/tools/tests/integration/api.test.ts).

## Invariants and coupling

- The advertised and dispatchable tool names come from one registry. Production:
  `selectSurface` in [registry.ts](../../packages/tools/src/tools/registry.ts). Test:
  [tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts).
- A Kernel-bound call is authorized against its final validated arguments, paths and trusted actor/call identity; standalone callers retain the Host default. Production: `prepareToolAction` in [action.ts](../../packages/tools/src/execution/action.ts) and `dispatch` in
  [core.ts](../../packages/tools/src/core.ts). Test:
  [action-authorization.test.ts](../../packages/tools/tests/unit/action-authorization.test.ts) and [open-authority.test.ts](../../packages/tools/tests/integration/open-authority.test.ts).
- An injected Sandbox port and backend wrap file handlers and new shell
  sessions. Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts),
  `SandboxToolExecutor` in [sandbox.ts](../../packages/tools/src/execution/sandbox.ts), and
  `ExecutionSessionManager.launch` in
  [execution-session.ts](../../packages/tools/src/lib/execution-session.ts). Test:
  [core.test.ts](../../packages/tools/tests/component/core.test.ts) and
  [native-sandbox.test.ts](../../packages/tools/tests/integration/native-sandbox.test.ts).

Read behavior belongs to [tools-read.md](tools-read.md),
mutations to [tools-mutation.md](tools-mutation.md), and shell sessions to
[tools-shell-and-sessions.md](tools-shell-and-sessions.md).
Native launch policy belongs to [sandbox.md](sandbox.md).
