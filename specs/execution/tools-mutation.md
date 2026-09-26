# File mutation tools and atomic transactions

## Surface

Four model-facing tools change files: `write_file`, `edit_file`, `apply_patch`
and `remove`. Relative paths resolve from the workspace root; absolute paths
use host filesystem permissions by default. A trusted Sandbox execution port can instead apply
the native filesystem boundary. A `readOnly` run advertises none of them; Sandbox workspace
read-only access is a separate preference and can leave mutation tools available for temporary paths.

Production: `toolDescriptors` in [registry.ts](../../packages/tools/src/tools/registry.ts),
`resolveToolPath` in [paths.ts](../../packages/tools/src/lib/paths.ts), and
`dispatch` in [core.ts](../../packages/tools/src/core.ts).
Test: [tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts)
and [open-authority.test.ts](../../packages/tools/tests/integration/open-authority.test.ts).

## Operations

`write_file` creates or replaces one file verbatim and creates missing parent
directories. It locks the path and stages a durable sibling before renaming it.
When the prior content is readable UTF-8, the result includes a bounded diff;
a binary or oversized prior file can still be replaced. `edit_file` makes
bounded literal text edits, with documented match fallback and `replace_all`
behavior, while retaining the rest of the file.

Production: `writeFile` in [write-file.ts](../../packages/tools/src/tools/write-file.ts)
and `editFile` in [edit-file.ts](../../packages/tools/src/tools/edit-file.ts).
Test: [write-file.test.ts](../../packages/tools/tests/integration/write-file.test.ts)
and [edit-file.test.ts](../../packages/tools/tests/integration/edit-file.test.ts).

`apply_patch` accepts a model patch envelope or unified diff. It parses and
validates all operations before staging, locks affected paths, and commits as
one transaction; a failed hunk changes nothing. Patch operations may create,
update, delete or rename files. `remove` deletes a file or symlink entry, an
empty directory, or a nonempty directory when `recursive: true`. Recursive
removal does not follow a symlink and reports partial durability failures.

Production: `applyPatchTool` in [apply-patch.ts](../../packages/tools/src/tools/apply-patch.ts),
`remove` in [remove.ts](../../packages/tools/src/tools/remove.ts), and
`applyOpsAtomic` in [atomic.ts](../../packages/tools/src/lib/atomic.ts).
Test: [apply-patch.test.ts](../../packages/tools/tests/integration/apply-patch.test.ts),
[remove.test.ts](../../packages/tools/tests/integration/remove.test.ts), and
[atomic.test.ts](../../packages/tools/tests/integration/atomic.test.ts).

## Invariants

The shared atomic writer stages file content in sibling temporary files,
validates targets, and rolls completed operations back on failure where
possible. It preserves permissions when overwriting and refuses symlink
targets. Host permissions still determine access. Path preflight cannot
eliminate a parent-directory replacement race.

`CoordinatedToolExecutor` serializes native file mutations for its run. An
aborted or uncertain mutation is not replayed on Host; later operations are
still admitted so the agent can inspect state and continue. Safe reads may
retry once on Host after a typed policy denial. The worker's process tree is
stopped before its queue releases, and an unconfirmed stop fails close rather
than certifying scratch cleanup.

Production: `CoordinatedToolExecutor.execute` in
`packages/tools/src/execution/coordinator.ts` and `SandboxToolExecutor.stopWorker`
and `close` in `packages/tools/src/execution/sandbox.ts`. Test:
`packages/tools/tests/unit/execution-coordinator.test.ts` and
`packages/tools/tests/integration/native-sandbox.test.ts`.

Production: `FileOp`, `applyOpsAtomic`, `writeAtomic`, `withFileLock` and
`assertNotSymlink` in [atomic.ts](../../packages/tools/src/lib/atomic.ts).
Test: [atomic.test.ts](../../packages/tools/tests/integration/atomic.test.ts)
and [symlink.test.ts](../../packages/tools/tests/integration/symlink.test.ts).
