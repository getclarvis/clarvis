# Workspace changes

> Implemented at `packages/protocol/src/workspace-changes.ts`,
> `packages/kernel/src/workspace/{changes-provider,git-changes-provider,workspace-changes-service}.ts`,
> and `packages/code/src/views/overlays/{DiffViewer.tsx,workspace-changes-controller.ts}`.
> Open questions are collected in the final section.

## 1. Purpose

`/diff` and `Ctrl+X D` show the current workspace changes according to a VCS-agnostic kernel
service. The inventory is independent of conversation history, tool calls, and sub-agent
selection. Inline transcript diffs remain historical tool output and are owned by
[code-transcript](code-transcript.md).

Protocol owns the public DTOs. Kernel owns adapters and provider selection. The TUI renders
structured paths and a normalized unified patch without branching on provider id.

## 2. Surface

`KernelClient.changes` is `WorkspaceChangesService`:

| Method | Role |
| --- | --- |
| `availability` | Probe whether a provider can serve the bound workspace |
| `list` | Inventory for one opaque comparison |
| `read` | On-demand detail for one inventory entry |

Cancellation is `WorkspaceChangesCallOptions.signal` and is never a wire param.
Production: [workspace-changes.ts](../../packages/protocol/src/workspace-changes.ts).
Test: [public-contract.fixture.ts](../../packages/protocol/tests/contract/public-contract.fixture.ts).

Kernel internals:

| Symbol | Role |
| --- | --- |
| `WorkspaceChangesProvider` | Adapter port: `probe`, `listChanges`, `readChange` |
| `createGitChangesProvider` | First adapter |
| `createWorkspaceChangesService` | Selection façade |

Production: [changes-provider.ts](../../packages/kernel/src/workspace/changes-provider.ts),
[git-changes-provider.ts](../../packages/kernel/src/workspace/git-changes-provider.ts),
[workspace-changes-service.ts](../../packages/kernel/src/workspace/workspace-changes-service.ts).
Test: [git-changes-provider.test.ts](../../packages/kernel/tests/integration/git-changes-provider.test.ts).

Wire methods `changes.availability`, `changes.list`, and `changes.read` are ordinary file-sensitive
reads. Production: `OPERATIONS.changes` in
[operations.ts](../../packages/kernel/src/transport/operations.ts).
Test: [transport-codecs.test.ts](../../packages/kernel/tests/contract/transport-codecs.test.ts).

## 3. Data and formats

Availability is `available` with provider identity, opaque comparisons, and capabilities, or
`not_applicable` / `unavailable` with a safe `reason.code` and message. Operational failure is
never a clean working tree.

Inventory entries carry stable ids, structured `old_path`/`new_path`, operation, optional
staged/unstaged flags, optional binary flag, and optional stats. Untracked files are `added`.
Detail status is `ready`, `empty`, `binary`, `conflict`, `truncated`, `stale`, or `unavailable`.
A `ready` payload is a normalized unified patch. A truncated patch is not fed to a native parser
as a complete file.

Generic types do not name Git commands, the index, or object ids. Presentation labels may mention
HEAD, staged, and unstaged when Git is active.

## 4. Behavior

### 4.1 Provider selection

The service probes every registered adapter. One applicable provider is activated automatically.
Two or more applicable providers yield `unavailable` with `ambiguous_provider` rather than
first-wins. A missing backend does not fall back silently to transcript diffs.

Production: `createWorkspaceChangesService` in
[workspace-changes-service.ts](../../packages/kernel/src/workspace/workspace-changes-service.ts).
Test: `createWorkspaceChangesService` in
[git-changes-provider.test.ts](../../packages/kernel/tests/integration/git-changes-provider.test.ts).

### 4.2 Git adapter

The Git adapter resolves an executable through `executableOnPath` or an injected path. It never
hardcodes `/usr/bin/git`. Probes use argv, disable pager/color/external diff/textconv, set
`GIT_OPTIONAL_LOCKS=0`, and strip repository-routing `GIT_*` variables via
`withoutGitRepositoryEnvironment`. They do not install software or initialize a repository.

Git comparisons:

| Id | Meaning |
| --- | --- |
| `all` (default) | HEAD versus working tree, plus untracked additions |
| `staged` | HEAD versus index; untracked excluded |
| `unstaged` | index versus working tree, plus untracked additions |

`All` is the net effect, not a concatenation of staged and unstaged patches. Without commits, the
base is the empty tree computed with `hash-object -t tree` without `-w`. Untracked patches use
`git diff --no-index` against a controlled empty temp file; exit code 1 means differences.
Headers are rewritten to the real path and `/dev/null`. Ignored files are excluded. A workspace
subdirectory is confined to that prefix. Submodules appear as gitlink changes without recursive
walks. External symlink targets are not read for untracked diffs.

Production: `createGitChangesProvider` in
[git-changes-provider.ts](../../packages/kernel/src/workspace/git-changes-provider.ts).
Test: [git-changes-provider.test.ts](../../packages/kernel/tests/integration/git-changes-provider.test.ts)
and [git-raw-parser.test.ts](../../packages/kernel/tests/unit/git-raw-parser.test.ts).

### 4.3 TUI

Opening `/diff` or `Ctrl+X D` always mounts the overlay, including on an empty conversation. The
controller loads on show, refreshes explicitly, polls only while visible, and cancels in-flight
work when hidden. Unchanged polls must not replace inventory or patch signals, so `StableDiff`
stays mounted and does not hide its highlight. Staging comparison controls appear only when the
provider publishes `staging`.
The tree uses structured paths and A/M/D/R status letters. `StableDiff` renders ready unified
patches. Special states render as hints, never as `Change N` or tool labels.

Production: `createWorkspaceChangesController` in
[workspace-changes-controller.ts](../../packages/code/src/views/overlays/workspace-changes-controller.ts)
and `DiffViewer` in [DiffViewer.tsx](../../packages/code/src/views/overlays/DiffViewer.tsx).
Test: [diff-viewer-render.test.tsx](../../packages/code/tests/integration/diff-viewer-render.test.tsx),
[app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx),
and [workspace-changes-controller.test.ts](../../packages/code/tests/unit/workspace-changes-controller.test.ts).

## 5. Invariants

| Rule | Production | Test |
| --- | --- | --- |
| Public types stay Git-command-free | `WorkspaceChangesService` in workspace-changes.ts | public-contract.fixture.ts |
| Probe failure is not an empty inventory | `createWorkspaceChangesService` / `createGitChangesProvider` | git-changes-provider.test.ts |
| Queries do not mutate HEAD, index, or status | `createGitChangesProvider` | lists all/staged/unstaged without mutating the repository |
| Untracked files are additions; ignored files are absent | `createGitChangesProvider` | same test |
| Net All is not staged+unstaged concatenation | `listComparison` | staged change reverted in the worktree is empty in All |
| TUI does not branch on provider id | `DiffViewer` | fake provider without Git concepts |
| Overlay opens without transcript history | `openDiff` in App.tsx | `/diff` on an empty conversation |
| Unchanged polls keep `StableDiff` mounted | `createWorkspaceChangesController` | an unchanged poll keeps the selected patch object |

## 6. Failure modes and degradation

| Condition | Result |
| --- | --- |
| Git executable missing or unusable | `unavailable` / `executable_missing` |
| Workspace is not a Git worktree | `not_applicable` / `not_a_repository` |
| `safe.directory` refusal | `unavailable` / `safe_directory_refused` |
| Permission denied | `unavailable` / `access_denied` |
| Multiple applicable providers | `unavailable` / `ambiguous_provider` |
| Comparison base changed between list and read | detail `stale` |
| Binary or conflict | detail `binary` / `conflict`, no ordinary patch |
| Patch exceeds the byte budget | detail `truncated` |

The overlay remains discoverable and offers refresh. It never falls back to transcript tool diffs.

## 7. Coupling

- Protocol is the public contract. Kernel implements adapters and transport. Code consumes
  `KernelClient.changes` only.
- `WorkspaceService` (`files`) remains a filesystem walker. Changes are a separate service.
- Git subprocess helpers reuse `ProcessRunner` and `@clarvis/paths` executable/environment
  helpers. They do not use the file-picker walker.

## 8. Open questions

- Explicit provider selection UI is unspecified until a second adapter exists.
- Rename-detection thresholds other than Git's `--find-renames=50%` / `diff.renameLimit=400` are
  not operator-configurable.
- macOS Git probes need their own CI evidence; Linux is the pinned suite here.
