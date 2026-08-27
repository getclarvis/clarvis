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

`createFileKernel(options)` resolves environment and paths, discovers the workspace identity, opens
configuration and secrets, builds planning/memory/task/workflow dependencies, constructs the
in-process kernel, recovers persisted runs, and installs workspace housekeeping. A construction
failure unwinds already-created resources before rethrowing. It does not start durable memory-index
recovery; the host releases that background inference through `startMemoryRecovery()` after its
first-paint or readiness boundary.

The `builtins` switchboard names `tools`, `skills`, `hooks`, and `tasks`. Memory and planning have
their own explicit options. Worktrees are not a runtime builtin: Code selects a checkout before this
function runs.

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
configuration, plugins, secrets, model catalogs, provider authentication, workspace files, memory,
plans, workflows, skills, sessions, tasks, and storage. These are control-plane services; model tool
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

The tools capability receives the selected workspace, sandbox policy, guard resolver, run-owned
temporary roots, and secret environment names. The kernel guard makes `host_vcs` an ordinary ask:
mode `on` uses the human channel, while a configured mode `auto` judge may answer it.

Workflow leaders are separate auxiliary runs. `auxiliaryWorkflowRunDeps` removes the memory
capability and leader assembly forces `memory: "off"`; the primary manager remains the workflow's
single memory-producing run.

Production: `packages/kernel/src/config/capability-registry.ts`;
`packages/kernel/src/file-kernel.ts`; `packages/kernel/src/guard/resolver.ts`.

Test: `packages/kernel/tests/integration/file-kernel.test.ts`;
`packages/kernel/tests/integration/builtin-fleet.test.ts`.

## 6. Persistence and recovery

Human-authored plans and memory remain in workspace/global content trees; machine state uses
`@clarvis/paths` global state roots. Run journals are recovered before the kernel reports ready.
Durable memory jobs begin draining only after the host calls `startMemoryRecovery()`. Workspace
housekeeping sweeps temporary spill/monitor artifacts without deleting Git checkouts.

Production: `packages/kernel/src/owner-scoped-file-stores.ts`;
`packages/kernel/src/application/workspace-housekeeping.ts`;
`packages/kernel/src/file-kernel.ts`.

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
   `packages/kernel/src/kernel.ts`; host calls in `packages/code/src/index.tsx`,
   `packages/kernel/src/serve.ts`, and `packages/server/src/bin.ts`.
   Test: `packages/kernel/tests/integration/owner-isolation.test.ts` (`starts durable memory recovery
   only after the host releases boot`).

## 8. Failure behavior

| Failure | Result |
| --- | --- |
| Git discovery is unavailable | deterministic canonical-path identity fallback |
| Config/plugin scope is invalid | rejected scope is reported; valid scopes continue |
| Orphan recovery fails | warning and degraded recovery count; kernel continues booting |
| A lifecycle resource fails to close | remaining resources still close; aggregate failure returned |
| Owner cache is exhausted | `resource_exhausted` |
| Workspace file escapes or is unreadable | `invalid_request` or `not_found` through the workspace service |

## 9. Dependency seams

Kernel depends on the foundation/engine packages it composes and imports `@clarvis/protocol` as
types. Code and Server consume the kernel entrypoints; neither imports the loop. There is no
`@clarvis/worktrees` dependency.
