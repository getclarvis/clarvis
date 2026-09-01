# Kernel composition and file bootstrap

## 1. Purpose

`@clarvis/kernel` composes the loop and optional capabilities behind the transport-agnostic
`KernelClient` contract. `createFileKernel` is the sole local bootstrap: one call owns one canonical
workspace, one Git-derived identity, one configuration tree, and one lifecycle.

Production: `packages/kernel/src/kernel.ts` (`createInProcessKernel`);
`packages/kernel/src/file-kernel.ts` (`createFileKernel`).

Test: `packages/kernel/tests/integration/file-kernel.test.ts`;
`packages/kernel/tests/integration/owner-isolation.test.ts`.

## 2. Construction

`createFileKernel(options)` resolves process environment and paths, discovers the workspace identity,
creates the extension Environment manager, opens configuration and secrets, builds
planning/memory/task/workflow dependencies, constructs the
in-process kernel, recovers persisted runs, and installs workspace housekeeping. A construction
failure unwinds already-created resources before rethrowing. It does not start durable memory-index
recovery; the host releases that background inference through `startMemoryRecovery()` after its
first-paint or readiness boundary.

The file host always supplies the loop's remote-MCP authorization coordinator with
`globalPaths(globalDir).mcpOAuthFile`. `openMcpAuthorizationUrl` is the separate host-authority seam:
a local UI may open a validated authorization URL, while an intentionally headless embedder omits the
callback and receives an explicit interactive-authorization failure only when a remote server actually
challenges. OAuth credentials never enter settings, run requests, protocol DTOs or model context.

Production: `packages/kernel/src/file-kernel.ts:99-153`, `:702-723`;
`packages/paths/src/global.ts:109-123`.

Test of the composed coordinator/store behavior:
`packages/mcp-client/tests/integration/oauth-transport.test.ts:230-488` and
`packages/mcp-client/tests/integration/oauth-store.test.ts:29-162`. The Code host's browser authority
is documented and tested in [code-bootstrap.md](code-bootstrap.md).

The `builtins` switchboard names `tools`, `skills`, `hooks`, and `tasks`. Memory and planning have
their own explicit options. Worktrees are not a runtime builtin: Code selects a checkout before this
function runs.

`CreateFileKernelOptions.environmentSelector` is the process-local Environment selector. The manager
resolves the installed inventory before the config store is constructed, then supplies the store's
exact active-plugin selector and workspace executable trust surface. The resulting snapshot is
pinned for the lifetime of this file kernel; selection changes require reconstruction.

Production: `packages/kernel/src/file-kernel.ts:362-383`, `:613`, `:834`, `:878`;
`packages/kernel/src/environments/environment-manager.ts` (`resolveActive`).

Test: `packages/kernel/tests/integration/environment-manager.test.ts`.

Production: `packages/kernel/src/file-kernel.ts` (`CreateFileKernelOptions`, `createFileKernel`);
`packages/kernel/src/application/lifecycle.ts`.

Test: `packages/kernel/tests/integration/file-kernel.test.ts`.

## 3. Workspace and owner identity

`discoverGitWorkspace` requires the configured workspace to be Git's top level when it is in a
repository. It hashes the canonical common Git directory into `ProjectRef.id`, hashes the
per-worktree Git directory into `WorkspaceRef.id`, labels from the branch (or directory), and marks
the first `git worktree list` entry `primary`; other entries are `external_worktree`. Outside Git,
the canonical workspace path is the deterministic fallback for both identities.

Git executes without a shell, with repository-control environment variables removed, prompts
disabled, a 15-second timeout, and a 1 MiB output bound.

Owner-persisted state uses `workspaceScopeKey(owner, projectId, workspaceId)`. This keeps two linked
worktrees in one project distinct while every service in one kernel agrees on the same scope.

Production: `packages/kernel/src/git-workspace.ts` (`discoverGitWorkspace`);
`packages/paths/src/roots.ts` (`workspaceScopeKey`);
`packages/kernel/src/kernel.ts` (`buildOwner`).

Test: `packages/kernel/tests/integration/git-workspace.test.ts`;
`packages/kernel/tests/integration/owner-isolation.test.ts`.

## 4. Kernel services

The in-process kernel exposes project/workspace identity and owner-scoped services for runs,
configuration, plugins, Environments, secrets, model catalogs, provider authentication, workspace
files, memory, plans, workflows, skills, sessions, tasks, and storage. These are control-plane services; model tool
surfaces are composed separately by the loop capabilities.

An owner handle is acquired lazily and cached only within this one kernel. Closing the kernel stops
new acquisitions, settles owners/resources, and attempts every close even when one fails.

Production: `packages/kernel/src/kernel.ts` (`InProcessKernel`, `createInProcessKernel`);
`packages/kernel/src/application/scope-policy.ts`.

Test: `packages/kernel/tests/integration/owner-isolation.test.ts`;
`packages/kernel/tests/unit/lifecycle.test.ts`.

## 5. Capability composition

The file kernel registers settings and grants before reading configuration. The loop receives tools,
skills, hooks, memory, planning, workflows, and tasks only when their owning policy enables them.
Optional package values do not enter the eager settings/import path contrary to the capability
composition boundary.

The Environment manager narrows plugin contributions before settings, agents, MCP servers, hooks,
capability executables, and plugin skill roots are composed. Standalone skill selection is passed as
resolved `SkillRootInput` entries with exact `include` lists. The loop receives those roots and the
opaque `{ id, fingerprint }` run metadata; it does not import Environment policy.

The tools capability receives the selected workspace, sandbox policy, guard resolver, run-owned
temporary roots, and secret environment names. The kernel guard makes `host_vcs` an ordinary ask:
mode `on` uses the human channel, while a configured mode `auto` judge may answer it.

Workflow leaders are separate auxiliary runs. `auxiliaryWorkflowRunDeps` removes the memory
capability and leader assembly forces `memory: "off"`; the primary manager remains the workflow's
single memory-producing run.

Foreground runs and every physical memory-indexer pass share one Environment admission function.
The file host injects a memory executor that acquires the immutable snapshot lease immediately
before calling `executeRun` and releases it in `finally`; durable retries therefore revalidate even
when no foreground handle remains. Production: `acquireEnvironmentRunLease` and
`executeEnvironmentRun` in `packages/kernel/src/file-kernel.ts`, plus `withRunLease` in
`packages/kernel/src/runs/run-lease.ts`. Test: `packages/kernel/tests/unit/run-lease.test.ts` and
`packages/memory/tests/component/factory.test.ts`.

Production: `packages/kernel/src/config/capability-registry.ts`;
`packages/kernel/src/file-kernel.ts`; `packages/kernel/src/environments/environment-manager.ts`;
`packages/kernel/src/guard/resolver.ts`.

Test: `packages/kernel/tests/integration/file-kernel.test.ts`;
`packages/kernel/tests/integration/builtin-fleet.test.ts`.

## 6. Persistence and recovery

Human-authored plans and memory remain in workspace/global content trees; machine state uses
`@clarvis/paths` global state roots. Run journals are recovered before the kernel reports ready.
Durable memory jobs begin draining only after the host calls `startMemoryRecovery()`. Workspace
housekeeping sweeps temporary spill/monitor artifacts without deleting Git checkouts.

Remote MCP OAuth is the deliberate credential exception to run-scoped state: its bounded,
schema-validated document lives at `<global>/state/mcp-oauth.json`, is private to the local host, and is
reused across runs. The loop owns the live callback coordinator and closes it with the run dependency
lifecycle; the kernel owns the file location and browser-opening authority.

Production: `packages/kernel/src/owner-scoped-file-stores.ts`;
`packages/kernel/src/application/workspace-housekeeping.ts`;
`packages/kernel/src/file-kernel.ts:702-724`;
`packages/loop/src/runtime/build-run-deps.ts:410-451`, `:621-638`;
`packages/paths/src/global.ts:109-125`.

Test: `packages/kernel/tests/integration/file-kernel.test.ts`.

## 7. Invariants

1. **One file kernel is permanently bound to one canonical workspace.**
   Production: `packages/kernel/src/file-kernel.ts`; `packages/kernel/src/git-workspace.ts`.
   Test: `packages/kernel/tests/integration/git-workspace.test.ts`.

2. **Every owner-scoped durable service uses the same project/workspace-qualified owner key.**
   Production: `packages/kernel/src/kernel.ts` (`buildOwner`).
   Test: `packages/kernel/tests/integration/owner-isolation.test.ts`.

3. **Git-derived project identity is shared across linked worktrees while workspace identity is not.**
   Production: `packages/kernel/src/git-workspace.ts`.
   Test: `packages/kernel/tests/integration/git-workspace.test.ts`.

4. **Closing attempts all resources and never admits a new owner afterward.**
   Production: `packages/kernel/src/kernel.ts`; `packages/kernel/src/application/lifecycle.ts`.
   Test: `packages/kernel/tests/unit/lifecycle.test.ts`.

5. **The kernel exposes no worktree lifecycle service or cross-workspace kernel cache.**
   Production: `packages/protocol/src/client.ts`; `packages/kernel/src/bootstrap.ts`.
   Test: protocol contract tests and `packages/code/tests/component/workspace-client-manager.test.ts`.

6. **Kernel construction starts no memory-index inference; explicit recovery start is idempotent and
   applies once to resident owners plus every later owner generation.**
   Production: `InProcessKernel.startMemoryRecovery`, `buildOwner`, and `residentOwner` in
   `packages/kernel/src/kernel.ts`; host calls in `packages/code/src/runtime.tsx`,
   `packages/kernel/src/serve.ts`, and `packages/server/src/bin.ts`.
   Test: `packages/kernel/tests/integration/owner-isolation.test.ts` (`starts durable memory recovery
   only after the host releases boot`).

7. **One file kernel composes one immutable resolved extension Environment.** Mutating a definition
   or persisted selection cannot change its active plugins, skill roots, run metadata, or
   fingerprint; a host must reconnect. Production: `createEnvironmentManager` and `resolveActive` in
   `packages/kernel/src/environments/environment-manager.ts`; composition in
   `packages/kernel/src/file-kernel.ts`. Test:
   `packages/kernel/tests/integration/environment-manager.test.ts` (`pins the active snapshot until
   reconnect`). The full contract is [Extension Environments](environments.md#5-invariants).

8. **Every physical run owned by the file kernel, including a delayed memory-indexer continuation,
   acquires the same immutable Environment lease.** Admission validates before execution and release
   runs after success or failure. Production: `acquireEnvironmentRunLease` and
   `executeEnvironmentRun` in `packages/kernel/src/file-kernel.ts`; `withRunLease` in
   `packages/kernel/src/runs/run-lease.ts`. Test:
   `packages/kernel/tests/unit/run-lease.test.ts` and
   `packages/memory/tests/component/factory.test.ts`.

## 8. Failure behavior

| Failure | Result |
| --- | --- |
| Git discovery is unavailable | deterministic canonical-path identity fallback |
| Config/plugin scope is invalid | rejected scope is reported; valid scopes continue |
| Environment selection or definition is invalid | kernel remains fail-closed on that invalid Environment; no builtin fallback is activated |
| Selected Environment inventory is missing or untrusted | kernel boots with a `degraded` resolved snapshot and only healthy, trusted selected contributions activate |
| A remote MCP server requires interactive OAuth and the host supplied no browser opener | explicit `MCPInteractiveAuthorizationUnavailableError`; the URL is not opened implicitly and no credential is moved through the protocol |
| OAuth callback, state, authorization URL or persisted store is invalid | authorization fails with a bounded typed error; unrelated plugin contributions and local MCP transports remain available |
| Orphan recovery fails | warning and degraded recovery count; kernel continues booting |
| A lifecycle resource fails to close | remaining resources still close; aggregate failure returned |
| Owner cache is exhausted | `resource_exhausted` |
| Workspace file escapes or is unreadable | `invalid_request` or `not_found` through the workspace service |

## 9. Dependency seams

Kernel depends on the foundation/engine packages it composes and imports `@clarvis/protocol` as
types. Code and Server consume the kernel entrypoints; neither imports the loop. There is no
`@clarvis/worktrees` dependency. The loop constructs `@clarvis/mcp-client`'s authorization
coordinator from the host options; Code supplies the operating-system browser opener, while Server and
other headless hosts can omit it without changing the wire contract.
