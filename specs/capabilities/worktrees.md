# Launch worktrees

## 1. Scope

Clarvis supports Git worktrees as a launch-time workspace choice. A process owns one canonical
workspace for its entire lifetime. Worktrees are not a runtime capability, model tool, protocol
service, TUI hub, registry, or lease system. Code owns one narrow cleanup path: explicitly
confirmed removal of its clean managed checkout during interactive exit.

The operator surface is `clarvis --worktree [name]`. Without the flag, Clarvis opens the
checkout from which it was launched. With the flag, bootstrap completes before the kernel, session
catalog, or TUI starts.

Production: `packages/code/src/cli-args.ts` (`FlagSpec.optionalValue`, `parseCli`);
`packages/code/src/index.tsx` (`main`);
`packages/code/src/runtime.tsx` (`runApp`, `runHeadlessMode`).

Test: `packages/code/tests/unit/cli-args.test.ts`;
`packages/code/tests/integration/worktree-bootstrap.test.ts`.

## 2. Location and naming

A newly created named checkout lives at:

```text
<primary-worktree>/.clarvis/worktrees/<name>
```

The first record in Git's registered worktree list is the primary checkout and remains the anchor
even when Clarvis starts from a linked checkout. Before creation, Code ensures
`<primary-worktree>/.clarvis/.gitignore` contains `worktrees/`; it refuses to create the checkout if
that protection cannot be verified. Existing file content is preserved and a missing exclusion is
appended atomically. Code also asks Git to check the intended destination, so a later custom negation
cannot silently expose checkout contents.

`project-id` is the SHA-256 identity of Git's canonical common directory. A supplied name is
1–80 ASCII letters, digits, dots, underscores, or hyphens, must start alphanumerically, and must also
be a valid Git branch segment (so `..`, `@{`, trailing dots, and `.lock` suffixes are refused). Omitting
the name generates a timestamp plus random suffix. Clarvis creates branch `clarvis/<name>`.

Production: `packages/code/src/bootstrap/worktree.ts` (`validateName`, `generatedName`,
`bootstrapWorktree`).

Test: `packages/code/tests/integration/worktree-bootstrap.test.ts`.

## 3. Git is the authority

Bootstrap reads `git worktree list --porcelain -z`. A destination already registered by Git is
reopened, as is a registered checkout of `clarvis/<name>` at an earlier location. A destination
that exists on disk but is not registered is refused. Clarvis stores no parallel worktree registry,
operation log, tombstone, preview, or occupancy lease.

Reopening a registered checkout at an earlier external location performs no nested-path setup and
does not require the primary checkout to be writable. The primary `.clarvis/.gitignore` protection
is required only when Clarvis is about to create its canonical nested destination.

An existing `clarvis/<name>` branch is reused. Otherwise bootstrap tries to refresh `origin`, then
reads the existing `origin/HEAD` symbolic ref whether or not that best-effort fetch succeeded. It
falls back to local `HEAD` only when the remote default ref is unavailable or unreadable, and creates
the branch and checkout through `git worktree add`. Git runs argv-only with prompts disabled, a
15-second bound, and a 1 MiB output bound.

On interactive user exit, Code offers checkout removal only when the selected Clarvis worktree is
clean. `y` first closes the workspace and completes removal before entering the platform's bounded
shutdown path; `n` exits and keeps it; Escape cancels exit. Cleanup repeats the cleanliness check,
changes cwd to the primary checkout, and executes `git worktree remove` without `--force`. It never
removes the branch. Only the canonical managed location permits cleanup of its now-empty
`.clarvis/worktrees/` parent; an external checkout's parent is never removed. Dirty worktrees,
ordinary checkouts, headless modes, signals and panic shutdown never receive or imply removal.

Production: `packages/code/src/bootstrap/worktree.ts` (`runBootstrapGit`, `preferredBaseRef`,
`bootstrapWorktree`).

Test: `packages/code/tests/integration/worktree-bootstrap.test.ts`;
`packages/code/tests/integration/app-shell-render.test.tsx`.

## 4. Immutable process scope

Once selected, the canonical checkout becomes `CLARVIS_WORKSPACE_ROOT` and is used to construct the
single file kernel. Sessions, settings, tools, plans, tasks, and traces are scoped to that workspace.
The Code host does not list or switch to other workspaces, and session resume/list/delete never
searches sibling worktrees.

Git-derived identity replaces the deleted registry: project identity hashes the common Git
directory and workspace identity hashes the per-worktree Git directory. Outside Git, both identities
fall back to the canonical workspace path.

Production: `packages/code/src/runtime.tsx` (`runApp`, `createWorkspaceRuntime`);
`packages/code/src/adapters/workspace-client-manager.ts` (`WorkspaceClientManager.create`);
`packages/kernel/src/git-workspace.ts` (`discoverGitWorkspace`);
`packages/kernel/src/file-kernel.ts` (`createFileKernel`).

Test: `packages/code/tests/component/workspace-client-manager.test.ts`;
`packages/code/tests/unit/workspace-runtime.test.ts`;
`packages/kernel/tests/integration/file-kernel.test.ts`.

## 5. Sandbox and host fallback

A linked checkout's `.git` is a pointer into the primary repository. The command sandbox therefore
validates its worktree target and reciprocal backlink once while configuring the toolset, then pins
the canonical common Git directory. Commands mount that pinned directory read-write for
workspace-write mode and read-only for workspace-read-only mode without re-reading mutable metadata.
It does not mount the operator's home directory, credential files, or keyring.

When the sandbox lacks a required host environment variable, credential channel, runtime, or
service, the model retries the same `shell` or `monitor_start` command with
`sandbox_permissions: "require_escalated"` and a short `justification`. Isolation Sandbox then
spawns that one command on the host after a human `ask`. Isolation Host already runs unsandboxed.
Isolated container runs reject the field. Mode `off` proceeds without a reviewer. Executable Git
options (`--upload-pack`, `--receive-pack`, and `--exec`), custom transport-helper URLs,
`git credential`, and `gh auth token` remain denied independently of command review.

Production: `packages/tools/src/config.ts` (`resolveConfig`);
`packages/tools/src/sandbox.ts` (`discoverLinkedGitMetadataPaths`, `sandboxCommand`);
`packages/tools/src/lib/sandbox-permissions.ts` (`resolveSandboxEscalation`);
`packages/tools/src/lib/sensitive-commands.ts`;
`packages/tools/src/core.ts` (`applyGuard`);
`packages/kernel/src/guard/shell-guard.ts` (`createShellGuard`).

Test: `packages/tools/tests/integration/sandbox.test.ts`;
`packages/tools/tests/integration/shell-escalation.test.ts`;
`packages/tools/tests/unit/guard-context.test.ts`;
`packages/kernel/tests/unit/guard.test.ts`.

## 6. Invariants

1. **One process owns one canonical workspace for its entire lifetime.**
   Production: `packages/code/src/runtime.tsx`; `packages/code/src/adapters/workspace-client-manager.ts`.
   Test: `packages/code/tests/component/workspace-client-manager.test.ts`.

2. **Git's registered worktree list is the only worktree authority.**
   Production: `packages/code/src/bootstrap/worktree.ts` (`bootstrapWorktree`).
   Test: `packages/code/tests/integration/worktree-bootstrap.test.ts`.

3. **Clarvis removes a managed checkout only after an explicit clean-exit confirmation and never
   removes its branch.**
   Production: `WorktreeExitPrompt` in `packages/code/src/views/overlays/WorktreeExitPrompt.tsx`;
   `worktreeIsClean` and `removeWorktreeCheckout` in
   `packages/code/src/bootstrap/worktree.ts`; pre-shutdown wiring in `packages/code/src/runtime.tsx`.
   Test: `packages/code/tests/integration/app-shell-render.test.tsx`;
   `packages/code/tests/integration/worktree-bootstrap.test.ts`.

4. **A linked checkout remains functional inside the sandbox without exposing host credentials.**
   Production: `packages/tools/src/config.ts` (`resolveConfig`);
   `packages/tools/src/sandbox.ts` (`discoverLinkedGitMetadataPaths`).
   Test: `packages/tools/tests/integration/sandbox.test.ts`.

5. **Host fallback is the same command text with `sandbox_permissions: "require_escalated"` and
   follows the operator-selected command-review mode.** Mode `off` proceeds without review; Isolation
   Sandbox with mode `on` or `auto` asks a human. Isolated containers refuse the field.
   Production: `packages/tools/src/lib/sandbox-permissions.ts`;
   `packages/kernel/src/guard/shell-guard.ts`.
   Test: `packages/tools/tests/integration/shell-escalation.test.ts`;
   `packages/kernel/tests/unit/guard-audit.test.ts`;
   `packages/kernel/tests/integration/local-docker-runtime.e2e.test.ts`.

6. **Every newly created checkout is nested under the primary worktree's ignored
   `.clarvis/worktrees/` root.**
   Production: `ensureWorktreeIgnore` and `bootstrapWorktree` in
   `packages/code/src/bootstrap/worktree.ts`; `worktreeCheckoutRoot` and `ensureWorkspaceDir` in
   `@clarvis/paths`.
   Test: `packages/code/tests/integration/worktree-bootstrap.test.ts`;
   `packages/paths/tests/integration/ensure.test.ts`.

## 7. Failure behavior

| Failure | Result |
| --- | --- |
| Launch directory is not a Git top level | startup fails before kernel/TUI boot |
| Name is invalid | startup fails with the bounded naming rule |
| Destination exists but Git does not register it | startup refuses to overwrite or adopt it |
| Primary `.clarvis/.gitignore` cannot be protected with `worktrees/` | startup refuses before `git worktree add` |
| Git command times out or exceeds output bound | startup fails; the ignore entry, parent directory, or Git branch/worktree metadata created by an earlier step may remain, but Clarvis writes no parallel registry |
| `origin` fetch fails | bootstrap still uses an existing readable `origin/HEAD`; otherwise it bases the new branch on local `HEAD` |
| Sandbox cannot validate linked Git metadata | no extra metadata mount is added |
| Linked Git metadata changes after toolset configuration | commands retain the originally validated pinned mount |
| `require_escalated` has no guard because command review is `off` | that one command proceeds on the host |
| `shell` requests direct token output or hidden Git helper execution | call is denied without execution |
| Exit cleanup observes pending changes or Git refuses removal | checkout and branch remain; a diagnostic records failure |

## 8. Dependency seams

There is no `@clarvis/worktrees` package. Launch and confirmed-exit cleanup orchestration belong to
Code, durable identity to Kernel, paths and ignore protection to `@clarvis/paths`, and process
confinement and per-call host escalation to `@clarvis/tools`. Protocol carries only project/workspace
identity already needed by sessions and runs; it exposes no worktree lifecycle API.
