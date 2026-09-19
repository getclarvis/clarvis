# Local storage inventory and housekeeping

## Scope

This contract owns the operator-facing view of Clarvis-managed local storage and the narrow cleanup
surface exposed by the kernel. Physical path construction remains owned by
[`foundations/paths.md`](../foundations/paths.md), trace retention by
[`foundations/trace.md`](../foundations/trace.md), and secret handling by
[`cross-cutting/security.md`](../cross-cutting/security.md).

The inventory is a logical classification of the existing layout. It does not introduce a new
`config/` directory, move files, or rewrite durable records.

## Protocol

`StorageService` has two operations:

| Operation | Contract |
| --- | --- |
| `inspect()` | Returns a bounded metadata-only snapshot containing category file/directory counts, byte totals, reclaimable byte totals, truncation state, and credential permission posture. |
| `cleanup(request)` | Accepts only `temporary` and/or `cache`; `dry_run: true` previews bytes without mutation, while apply returns before/after snapshots and actual removed bytes. |

Production: `StorageService`, `StorageSnapshot`, and `StorageCleanupRequest` in
`packages/protocol/src/storage.ts`; `KernelClient.storage` in `packages/protocol/src/client.ts`.
Test: `storage-service.test.ts` in `packages/kernel/tests/integration/` and the complete client fixture
in `packages/protocol/tests/contract/public-contract.fixture.ts`.

Stable logical categories are `traces`, `sessions`, `workflow_records`, `projects`, `spills`,
`memory`, `plans`, `diagnostics`, `run_scratch`, `workspace_state`, and `cache`. A row
contains no pathname and no persisted content.

Container base/recipe images, artifact/data/mise volumes and disposable Containers are engine-owned
objects rather than paths under the host Clarvis global root. They are absent from this filesystem
inventory and `StorageService.cleanup`; the service must not imply it measured or removed engine
storage. Production: `prepareContainerVolumes` in
`packages/kernel/src/runtime/container-volumes.ts` and inspection roots in
`packages/kernel/src/storage/storage-service.ts`. Test:
`packages/kernel/tests/unit/container-volumes.test.ts`,
`packages/kernel/tests/integration/container-kernel.e2e.test.ts` and
`packages/kernel/tests/integration/storage-service.test.ts`.

Git worktree checkout roots are outside this inventory and cleanup service. Code selects or creates
a checkout before kernel construction and may run explicitly confirmed clean-checkout removal after
the workspace closes; the kernel still has no `worktrees` storage category or cleanup target.
Production: `CATEGORIES` and the inspection roots in
`packages/kernel/src/storage/storage-service.ts`; `bootstrapWorktree` in
`packages/code/src/bootstrap/worktree.ts`. Test:
`packages/kernel/tests/integration/storage-service.test.ts` and
`packages/code/tests/integration/worktree-bootstrap.test.ts`.

Container process registry and host lease live under `containerLaunchPaths(namespace)` and carry only
generation/engine/Container/base/artifact lifecycle identity. Domain state lives in the guest state
volume; the selected workspace is mounted in place and is never copied into host runtime state.
Production: `containerLaunchPaths` in `packages/paths/src/container.ts` and
`launchContainerKernel` in `packages/kernel/src/hosting/container-host-launcher.ts`. Test:
`packages/paths/tests/unit/container.test.ts` and
`packages/kernel/tests/integration/container-launcher.test.ts`.

## Inventory boundaries

The kernel scans only roots built by `globalPaths`. The walk is bounded to 100,000 entries and depth
24, ignores non-file/non-directory entries, and sets `truncated` when a bound is reached. Workspace
state is classified from relative path components; it is not reorganized on disk. A root missing at
open or at a runtime's lazy first directory read is an empty category. Any other open or iteration
failure marks the inventory truncated so an apply fails closed.

Credential reporting is deliberately narrower than ordinary inventory. `keys.json` and
`subscriptions.json` yield only `{ present, owner_only }`. No content, pathname, byte size, provider,
account, token or expiry crosses the service.

Production: `createStorageService`, `workspaceCategory`, and `credentialPosture` in
`packages/kernel/src/storage/storage-service.ts`.
Test: the metadata and credential-posture case in
`packages/kernel/tests/integration/storage-service.test.ts`.

## Cleanup policy

Only two cleanup classes can be named:

- `temporary`: recognized shell/tool-output spills older than 24 hours and stale empty run scratch
  containers. Recent spills, monitor state, occupied run directories and unrecognized files remain.
- `cache`: the rebuildable global cache tree.

The rebuildable cache includes host-local Container runtime artifacts whose admitted payload files
and directories are intentionally published read-only. During explicit cleanup only,
`removeOwnedTree` restores traversal/removal rights on real directories owned by the current POSIX
user and then removes the tree. It never follows a symbolic link, changes ownership, elevates
privileges, or makes content world-writable. A linked root, a directory owned by another user, or an
`EACCES`/`EPERM` refusal fails closed with a path-free conflict; other removal failures likewise use
a path-free Kernel error. Artifact files and directories retain their immutable modes at every other
time. This host-filesystem cleanup does not affect the independently managed artifact volume in the
Container engine.

An empty or unknown category set is `invalid_request`. An apply whose fresh before-snapshot is
`truncated` is refused with `conflict`, because the preview cannot safely describe the deletion
scope; Code likewise stops before confirmation when its dry-run snapshot is incomplete. Durable
traces, sessions, workflow records,
projects, memory, plans, diagnostics, settings, agents, keys and subscriptions cannot be
expressed as cleanup targets. The TUI always calls dry-run first and asks for confirmation before
apply.

Likewise, `cache` cleanup names only the rebuildable global filesystem cache. It does not invoke a
Docker executable, select a Docker context or delete labelled recipe images or mise volumes.
Engine-cache inspection and explicit cleanup remain an advanced Docker operation until Clarvis
exposes a separately reviewed engine-storage contract.

Production: `createStorageService.cleanup` in `packages/kernel/src/storage/storage-service.ts`,
`removeOwnedTree` in `packages/kernel/src/storage/owned-tree.ts`, `cacheRuntimeArtifact` in
`packages/kernel/src/runtime/runtime-artifact.ts`, `sweepGlobalStateArtifacts` in
`packages/paths/src/housekeeping.ts`, and `StorageView` in
`packages/code/src/views/config/StorageView.tsx`.
Test: cleanup preview/apply and accounting, immutable runtime-artifact removal, link boundaries,
unsafe ownership, path-free filesystem failures, truncated-preview refusal, and invalid-category
cases in `packages/kernel/tests/integration/storage-service.test.ts`; Code refusal in
`packages/code/tests/integration/storage-view-render.test.tsx`; command registration in
`packages/code/tests/component/command-composition.test.ts`.

## Automatic housekeeping

File-kernel startup runs bounded housekeeping across every workspace state directory, including
inactive workspaces. Recognized spill files are repaired to `0600` on POSIX and spills older than 24
hours are removed. Empty run containers older than 24 hours are removed only when their descendants
contain no files other than empty `tmp` directories. Normal run teardown removes its temporary root
and prunes the empty execution and `runs/` parents immediately.

Trace retention defaults to 30 days. A cleanup pass receives all execution ids referenced by valid
persisted sessions across owners and skips those traces, so resumption history is protected. The
reference scan is bounded to 10,000 session files and 256 MiB; reaching either bound or encountering
an unreadable catalog makes the result incomplete and skips the entire destructive trace pass.
Raw execution ids are encoded only at the trace-store filename boundary before matching. Setting
`CLARVIS_TRACE_TTL_DAYS=0` disables age cleanup.

Production: `sweepGlobalStateArtifacts` in `packages/paths/src/housekeeping.ts`, the `onRunEnd`
cleanup in `packages/loop/src/runtime/capabilities/tools.ts`, `referencedSessionExecutionIds` in
`packages/kernel/src/sessions/session-service.ts`, and trace cleanup composition in
`packages/kernel/src/file-kernel.ts`.
Test: `packages/paths/tests/integration/housekeeping.test.ts`,
`packages/loop/tests/integration/command-guard-wiring.test.ts`,
`packages/kernel/tests/integration/session-service.test.ts`, and
`packages/trace/tests/component/cleanup.test.ts`.

## Invariants

1. Inventory never exposes credential content, pathname or size.
2. Cleanup cannot name durable categories.
3. Apply is preceded by a dry-run and explicit user confirmation in Code.
4. A truncated inventory is never applied, and an incomplete session-reference scan never permits
   age retention.
5. A session-referenced execution trace is not deleted by age retention, including when its raw id
   requires filename encoding.
6. Housekeeping is bounded and preserves recent, occupied and unrecognized state.
7. Storage maintenance does not read, rewrite or reorder the model message list; prompt-prefix
   stability is unaffected.
8. Filesystem inventory and cleanup never claim visibility or authority over Docker-managed recipe
   images or mise volumes.
