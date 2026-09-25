# File mutation tools and atomic transactions

## Purpose and surface

Nine model-facing tools mutate files: `write_file`, `edit_file`, `multi_edit`, `apply_patch`,
`replace`, `move`, `copy`, `mkdir` and `remove`. They accept relative paths based at the workspace
or absolute paths. The tools do not classify configuration or external paths for application
approval. Host process permissions determine access.

Production: tool definitions in [registry.ts](../../packages/tools/src/tools/registry.ts),
`resolveToolPath` in [paths.ts](../../packages/tools/src/lib/paths.ts), and `dispatch` in
[core.ts](../../packages/tools/src/core.ts). Test:
[tool-surface.test.ts](../../packages/tools/tests/component/tool-surface.test.ts),
[open-authority.test.ts](../../packages/tools/tests/integration/open-authority.test.ts).

## Operations

`write_file` creates or replaces one file verbatim and creates missing parent directories.
It locks the path, stages a durable sibling and renames it into place. It returns a diff when
the previous file is readable UTF-8; a binary or oversized previous file can still be replaced.
`edit_file` and `multi_edit` apply bounded textual edits while preserving the rest of the file.

Production: `writeFile` in [write-file.ts](../../packages/tools/src/tools/write-file.ts),
`editFile` in [edit-file.ts](../../packages/tools/src/tools/edit-file.ts), and `multiEdit` in
[multi-edit.ts](../../packages/tools/src/tools/multi-edit.ts). Test:
[write-file.test.ts](../../packages/tools/tests/integration/write-file.test.ts),
[edit-file.test.ts](../../packages/tools/tests/integration/edit-file.test.ts), and
[multi-edit.test.ts](../../packages/tools/tests/integration/multi-edit.test.ts).

`apply_patch` accepts a `*** Begin Patch` model envelope and unified diffs. It parses all file
operations before staging and locks all affected paths; a failed hunk changes nothing.
`replace` scans a bounded scope and defaults to a dry-run diff preview. Committing a replacement
uses the same atomic batch machinery.

Production: `applyPatchTool` in [apply-patch.ts](../../packages/tools/src/tools/apply-patch.ts),
`replace` in [replace.ts](../../packages/tools/src/tools/replace.ts), and `applyOpsAtomic` in
[atomic.ts](../../packages/tools/src/lib/atomic.ts). Test:
[apply-patch.test.ts](../../packages/tools/tests/integration/apply-patch.test.ts),
[replace.test.ts](../../packages/tools/tests/integration/replace.test.ts), and
[atomic.test.ts](../../packages/tools/tests/integration/atomic.test.ts).

`copy` and `move` act on one regular file, refuse the same source and destination, and require
`overwrite: true` to replace a destination. `copy` stages a sibling, preserves the source's
permission mode and fsyncs the destination directory. `move` uses a same-filesystem rename when
possible and a bounded staged copy on `EXDEV`; failure to remove the source after the destination
lands is reported as `commit_partial`. `mkdir` creates a directory. `remove` deletes a file or
symlink entry, an empty directory, or a nonempty tree when `recursive: true`. Recursive removal
does not follow a symlink and reports `commit_partial` if deletion lands but durability cannot
be confirmed.

Production: `copy` in [copy.ts](../../packages/tools/src/tools/copy.ts), `move` in
[move.ts](../../packages/tools/src/tools/move.ts), `mkdir` in
[mkdir.ts](../../packages/tools/src/tools/mkdir.ts), and `remove` in
[remove.ts](../../packages/tools/src/tools/remove.ts). Test:
[copy.test.ts](../../packages/tools/tests/integration/copy.test.ts),
[move.test.ts](../../packages/tools/tests/integration/move.test.ts), and
[remove.test.ts](../../packages/tools/tests/integration/remove.test.ts).

## Atomic machinery and limits

`FileOp` is an in-memory create, modify, delete or rename operation. `applyOpsAtomic` validates
all targets, stages new bytes in destination sibling files, commits the operations and rolls back
completed operations on failure where possible. `withFileLock` and `withFileLocks` serialize
conflicting calls in one process. `writeAtomic` stages one file and renames it into place. The
transaction respects `maxMutationBytes`, file size and traversal ceilings. A symlink target is
refused by the atomic writer; recursive removal removes the entry named without following a
symlink destination. Path-based preflight does not eliminate a parent-directory replacement race.

Production: `FileOp`, `applyOpsAtomic`, `writeAtomic`, `withFileLock`, `withFileLocks` and
`assertNotSymlink` in [atomic.ts](../../packages/tools/src/lib/atomic.ts), and limits in
[config.ts](../../packages/tools/src/config.ts). Test:
[atomic.test.ts](../../packages/tools/tests/integration/atomic.test.ts),
[symlink.test.ts](../../packages/tools/tests/integration/symlink.test.ts), and
[remove.test.ts](../../packages/tools/tests/integration/remove.test.ts).

## Invariants and coupling

- The dispatcher validates each request before the handler receives it, and reports failures in
  band. Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts). Test:
  [core.test.ts](../../packages/tools/tests/component/core.test.ts).
- File mutation has no Shell Guard, Judge, configuration review or protected-path admission step.
  Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts) and `resolveToolPath`
  in [paths.ts](../../packages/tools/src/lib/paths.ts). Test:
  [open-authority.test.ts](../../packages/tools/tests/integration/open-authority.test.ts).

Read tools are specified in [tools-read-and-search.md](tools-read-and-search.md).
