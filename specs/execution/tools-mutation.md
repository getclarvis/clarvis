# Writing, editing, patching and moving files

> Implemented at
> `packages/tools/src/tools/{write-file,edit-file, multi-edit,apply-patch,replace,move,copy,mkdir,remove}.ts`
> and `packages/tools/src/lib/atomic.ts`, plus their integration tests under
> `packages/tools/tests/integration/`. Every claim below is anchored to a file and a named symbol or test. Open
> questions are collected in the final section.

## 1. Purpose

This subsystem is the set of `@clarvis/tools` handlers that mutate the filesystem: `write_file`,
`edit_file`, `multi_edit`, `apply_patch`, `replace`, `move`, `copy`, `mkdir` and `remove`
(`packages/tools/src/tools/registry.ts` aggregates them), plus the
shared staging/locking/rollback machinery in `packages/tools/src/lib/atomic.ts` that every one of them
(except `mkdir`, which has no content to stage) routes through.

The problem it solves is giving a model-driven agent filesystem writes that behave like a database
transaction rather than like raw `fs` calls: a write that either lands whole or leaves nothing
changed, a batch of edits across one or many files that is all-or-nothing, and a locking discipline
that serializes concurrent tool calls on the same path instead of racing them. It also absorbs a
model's characteristic mistakes — pasting `read_file`'s line-number prefixes back into an edit,
missing on whitespace, writing through a symlink — and turns each into a diagnosable, structured
`ToolError` rather than a corrupted file or a silent no-op.

## 2. Surface

### 2.1 Model-facing tools (name, one-line contract, required args)

| Tool | File | Contract | Required args |
| --- | --- | --- | --- |
| `write_file` | `packages/tools/src/tools/write-file.ts` | Create or fully overwrite a file with `content` verbatim, creating missing parents | `path`, `content` |
| `edit_file` | `packages/tools/src/tools/edit-file.ts` | Replace one literal occurrence of `old_string` with `new_string` (or all, with `replace_all`) | `path`, `old_string`, `new_string` |
| `multi_edit` | `packages/tools/src/tools/multi-edit.ts` | Apply an ordered list of `edit_file`-style edits to one file, atomically | `path`, `edits` (≥1) |
| `apply_patch` | `packages/tools/src/tools/apply-patch.ts` | Apply a model-friendly patch envelope or raw unified diff across one or more files (modify/create/delete/rename) atomically | `patch` |
| `replace` | `packages/tools/src/tools/replace.ts` | Regex find-and-replace across a scope, preview-first | `pattern`, `replacement` (plus `path` and/or `glob`) |
| `move` | `packages/tools/src/tools/move.ts` | Atomically move/rename one regular file | `source`, `destination` |
| `copy` | `packages/tools/src/tools/copy.ts` | Atomically copy one regular file, binary-safe, mode-preserving | `source`, `destination` |
| `mkdir` | `packages/tools/src/tools/mkdir.ts` | `mkdir -p`, idempotent | `path` |
| `remove` | `packages/tools/src/tools/remove.ts` | Delete one regular file | `path` |

Each is a `ToolDef` (`name`, `description`, `inputSchema`, `handler`) — the shape itself belongs to
[tools-contract-and-dispatch](tools-contract.md) (`packages/tools/src/tools/types.ts`) and is not re-derived here.

### 2.2 Input schemas (JSON Schema, as declared on each `ToolDef.inputSchema`)

| Tool | Optional fields and defaults |
| --- | --- |
| `write_file` | none beyond the required two |
| `edit_file` | `replace_all: boolean`, default `false` (`packages/tools/src/tools/edit-file.ts`) |
| `multi_edit` | `edits[].replace_all: boolean`, default `false` (`packages/tools/src/tools/multi-edit.ts`) |
| `apply_patch` | none beyond `patch` |
| `replace` | `path`, `glob`, `ignore_case: boolean`, `multiline: boolean`, `dry_run: boolean` default `true` (`packages/tools/src/tools/replace.ts`) |
| `move` | `overwrite: boolean`, default `false` (`packages/tools/src/tools/move.ts`) |
| `copy` | `overwrite: boolean`, default `false` (`packages/tools/src/tools/copy.ts`) |
| `mkdir` | none beyond `path` |
| `remove` | none beyond `path` |

None of these `inputSchema`s declares `additionalProperties: false`, so every one of them silently
accepts and ignores an unrecognized extra property rather than rejecting the call — pinned, one tool
at a time, by `packages/tools/tests/integration/write-file.test.ts`, `packages/tools/tests/integration/edit-file.test.ts`, `packages/tools/tests/integration/apply-patch.test.ts`,
`packages/tools/tests/integration/move.test.ts`, `packages/tools/tests/integration/multi-edit.test.ts`, `packages/tools/tests/integration/copy.test.ts`, `packages/tools/tests/integration/mkdir.test.ts` and
`packages/tools/tests/integration/remove.test.ts` (each titled "ignores out-of-schema extra fields").

Model-facing mutation guidance keeps the actionable constraints next to their inputs. `edit_file`
prefers an exact unique literal, distinguishes `no_match` from `ambiguous_match` recovery, and
acknowledges the reported fuzzy fallback. `replace.glob` is required only when `path` is omitted,
not for every directory path. `apply_patch` includes actual newlines in its copyable model-envelope
example; the example itself is executed in the integration suite. Production: `editFile` in
`packages/tools/src/tools/edit-file.ts`, `replace` in `packages/tools/src/tools/replace.ts` and
`applyPatchTool` in `packages/tools/src/tools/apply-patch.ts`. Test:
`packages/tools/tests/integration/edit-file.test.ts`,
`packages/tools/tests/integration/replace.test.ts` and
`packages/tools/tests/integration/apply-patch.test.ts`. Shared instruction ownership is in
[`model-instructions.md`](../cross-cutting/model-instructions.md).

### 2.3 `packages/tools/src/lib/atomic.ts` exports

Not part of any package `exports` subpath — the file is internal to `@clarvis/tools`'s own `src/`
(the export map reaches none of them: `lib/atomic.ts`
explicitly). Its symbols, as consumed by the tools above:

| Symbol | Kind | File | Used by |
| --- | --- | --- | --- |
| `RM_RETRY` | const | `packages/tools/src/lib/atomic.ts` | every `fs.rm` cleanup call in this file; re-exported for `packages/tools/src/tools/copy.ts` |
| `withFileLock<T>(absPath, fn)` | fn | `packages/tools/src/lib/atomic.ts` | write_file, edit_file (via `editFileLocked`), remove |
| `withFileLocks<T>(paths, fn)` | fn | `packages/tools/src/lib/atomic.ts` | apply_patch, replace, move, copy |
| `assertNotSymlink(target)` | fn | `packages/tools/src/lib/atomic.ts` | write_file (via `writeAtomic`), edit_file (via `writeAtomic`), move, copy, apply_patch (via `validateTargets`), replace (via `applyOpsAtomic`'s `validateTargets`, on a non-dry-run commit), remove (via `applyOpsAtomic`) |
| `writeAtomic(target, content)` | fn | `packages/tools/src/lib/atomic.ts` | write_file, edit_file/multi_edit (via `editFileLocked`) |
| `FileOp` | interface | `packages/tools/src/lib/atomic.ts` | apply_patch, replace, remove |
| `applyOpsAtomic(ops: FileOp[])` | fn | `packages/tools/src/lib/atomic.ts` | apply_patch, replace, remove |

`FileOp.type` is `"create" | "modify" | "delete" | "rename"` (`packages/tools/src/lib/atomic.ts`); `from` is the rename
source (`packages/tools/src/lib/atomic.ts`); `content` is the new body for `create`/`modify` and an optional rewrite
alongside a `rename` (`packages/tools/src/lib/atomic.ts`).

### 2.4 `RuntimeConfig` fields this subsystem reads

Owned by [tools-contract-and-dispatch](tools-contract.md) (`packages/tools/src/config.ts`); listed here only because
every handler above consumes them directly.

| Field | Default | Definition | Consumed at |
| --- | --- | --- | --- |
| `maxFileBytes` | `20_000_000` (`DEFAULT_MAX_FILE_BYTES`, `packages/tools/src/config.ts`) | `packages/tools/src/config.ts` | packages/tools/src/tools/edit-file.ts, apply-patch.ts (`readEditableFile`), packages/tools/src/tools/replace.ts |
| `maxMutationBytes` | `64 * 1024 * 1024` (`DEFAULT_MAX_MUTATION_BYTES`, `packages/tools/src/config.ts`) | `packages/tools/src/config.ts` | packages/tools/src/tools/replace.ts |
| `maxDiffInputBytes` | `8 * 1024 * 1024` (`DEFAULT_MAX_DIFF_INPUT_BYTES`, `packages/tools/src/config.ts`) | `packages/tools/src/config.ts` | packages/tools/src/tools/write-file.ts, packages/tools/src/tools/edit-file.ts, packages/tools/src/tools/replace.ts/263 |
| `maxTraversalEntries` | `50_000` (`DEFAULT_MAX_TRAVERSAL_ENTRIES`, `packages/tools/src/config.ts`) | `packages/tools/src/config.ts` | packages/tools/src/tools/replace.ts (`scopeFiles`) |
| `regexScanBudgetMs` | `5000` (`DEFAULT_REGEX_SCAN_BUDGET_MS`, `packages/tools/src/config.ts`) | `packages/tools/src/config.ts` | packages/tools/src/tools/replace.ts (`createScanBudget`) |
| `confineToWorkspace` | `true` default (`packages/tools/src/config.ts`) | `packages/tools/src/config.ts` | every `resolvePath` call in every handler above |
| `readOnly` | `false` default (`packages/tools/src/config.ts`) | `packages/tools/src/config.ts` | gates tool visibility upstream ([tools-contract-and-dispatch](tools-contract.md)); observed effect: `packages/tools/tests/integration/replace.test.ts` shows `readOnly: true` making `replace` answer `not_found`, as if the tool did not exist |
| `skillExecutionRoots` | `[]` | `RuntimeConfig.skillExecutionRoots` at `packages/tools/src/config.ts`; normalized in `resolveConfig` | the central dispatcher refuses every native source/destination below a selected skill package before any handler runs |

## 3. Data and formats

### 3.1 The `FileOp` batch (in-memory only)

`applyOpsAtomic` never persists a `FileOp[]` to disk; it is an in-process array built by the calling
tool for one call and discarded after commit. Example, from `apply_patch`'s rename-with-content path
(`packages/tools/src/tools/apply-patch.ts`):

```ts
{ type: "rename", path: absTo, from: absFrom, content: reencode(result, decoded) }
```

and from `remove` (`packages/tools/src/tools/remove.ts`):

```ts
[{ type: "delete", path: target }]
```

A `create` op with `content` omitted does not fail: `stageAll` defaults it to the empty string
(`stage(op.path, op.content ?? "")`, `packages/tools/src/lib/atomic.ts`), which produces a real, empty file — pinned by
`packages/tools/tests/integration/atomic.test.ts` ("creates an empty file when a create op omits its content").

### 3.2 Temp file naming (delegated primitive, cited for context)

`tmpPathFor(target)` (owned by [paths-directory-vocabulary](../foundations/paths.md), `packages/paths/src/atomic.ts`)
builds a sibling of `target` named `${TMP_PREFIX}${pid}-${counter}-${uuid}`, so `tools/lib/atomic.ts`
never invents its own temp-name scheme — `stage()` (`packages/tools/src/lib/atomic.ts`), `commitWithRollback`'s backup
paths (`packages/tools/src/lib/atomic.ts`), and `packages/tools/src/tools/copy.ts` all call the same `tmpPathFor`. Its own TSDoc names the
pid+counter+UUID combination as answering two collision hazards at once — the pid separates two
processes, the counter separates two writers inside one process, and the UUID survives even a fork
that inherits the counter — citing a concrete incident: `@clarvis/server` once wrote its signing key to
a bare `<file>.tmp`, so two boots racing that file collided on one temp path
(`packages/paths/src/atomic.ts`). The tests here assert "no orphaned temp file" via their own
local `tmpFiles()` helper (`packages/tools/tests/integration/atomic.test.ts`), which reimplements the `.clarvis-tmp` prefix check
as a literal string match (`f.startsWith(".clarvis-tmp")`) rather than calling `isTmpFile`/`TMP_GLOB`
from `@clarvis/paths` — the shared predicates are not actually exercised by this test file.

### 3.3 Unified diff (`meta.diff`)

`write_file`, `edit_file`/`multi_edit` and `replace` (non-dry-run) attach a unified diff string under
`result.meta.diff` when one is produced (`packages/tools/src/tools/write-file.ts`, `packages/tools/src/tools/edit-file.ts`,
`replace.handler` in `packages/tools/src/tools/replace.ts`); `unifiedDiff(rel, before, after, maxDiffInputBytes)` is owned by
[tools-read-and-search](tools-read-and-search.md). `write_file` omits the diff — not fails the write — for a binary or oversized
prior file (`packages/tools/src/tools/write-file.ts`, pinned by `packages/tools/tests/integration/write-file.test.ts`).

### 3.4 `EditSpec` (shared by `edit_file` and `multi_edit`)

```ts
interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
```
(`packages/tools/src/tools/edit-file.ts`.) `multi_edit` applies an ordered array of these to one file inside a single
transform (`packages/tools/src/tools/multi-edit.ts`).

### 3.5 Accepted patch formats (`apply_patch`)

The recommended model-facing form is the patch envelope models commonly associate with the tool:
`*** Begin Patch`, one or more `*** Update File:` / `*** Add File:` / `*** Delete File:` blocks, and
`*** End Patch`. An update may carry `*** Move to:` immediately after its header. Update hunks begin
with `@@`; they may use no location, a section-line anchor, or conventional numbered unified-diff
coordinates. `*** End of File` constrains a hunk to the file tail. Add content lines require `+`;
delete blocks contain no hunks. For numbered model-envelope hunks, the old-file coordinate is
adjusted by prior hunk deltas and selects the nearest matching context within three lines. A
zero-length old range inserts at its coordinate, and coordinates disambiguate repeated context.

Raw unified diffs remain accepted and are parsed by the `diff` package's
`parsePatch`/`applyPatch`/`StructuredPatch`. A block's `oldFileName`/`newFileName` are cleaned of a
leading `a/`/`b/` and any tab-delimited trailing metadata by `cleanName`; the literal `/dev/null`
marks a create or delete. Both grammars become the same internal `ParsedPatch` shape before path
resolution, locking, validation, and atomic commit. Production:
`parseModelPatch`, `parseModelHunks`, `applyModelHunks`, and `applyParsedPatch` in
`packages/tools/src/tools/apply-patch.ts`. Test: the `model-friendly patch envelope` cases in
`packages/tools/tests/integration/apply-patch.test.ts`.

### 3.6 Error envelope

Not owned here (see [tools-contract-and-dispatch](tools-contract.md)'s `errors.ts`), but every failure mode below is
expressed through it: `ToolError { code: ErrorCode, message, fields }`
(`packages/tools/src/errors.ts`), serialized as `{"error": code, "message": ..., ...fields}`
(`packages/tools/src/errors.ts`). `fsError(err, path)` maps a raw Node `errno` to `not_found` (`ENOENT`),
`not_a_file` (`EISDIR`/`ENOTDIR`), or `io_error` for anything else (`packages/tools/src/errors.ts`).

## 4. Behavior

### 4.1 `write_file` (`packages/tools/src/tools/write-file.ts`)

1. Resolve and confine `path` (`resolvePath`, delegated to [security-confinement-and-redaction](../cross-cutting/security.md)).
2. `withFileLock(target, …)` (`packages/tools/src/lib/atomic.ts`) — serializes against any other call touching the same
   absolute path.
3. `fs.stat(target)`: if it is a directory, throw `not_a_file` (`packages/tools/src/tools/write-file.ts`); if `ENOENT`,
   `existed = false`; any other stat error is mapped through `fsError` (`packages/tools/src/tools/write-file.ts`).
4. If it existed, best-effort read the prior content via `readTextFile` to capture a "before" for the
   diff; an `is_binary`/`too_large` failure here is swallowed (no diff, not a failed write) — any other
   error (in particular a `path_escape`) propagates (`packages/tools/src/tools/write-file.ts`, doc remark at
   `packages/tools/src/tools/write-file.ts`).
5. `writeAtomic(target, content)` (`packages/tools/src/lib/atomic.ts`): reject a symlink target
   (`assertNotSymlink`), `mkdir -p` the parent, capture the existing mode, then delegate to
   `@clarvis/paths`'s `writeFileDurable` with `mode: existingMode ?? 0o666 & ~umask` and
   `dirMode: 0o777 & ~umask`; on any throw, remove a directory this call itself created
   (`removeCreatedDirs`) before rethrowing.
6. Report bytes written and created/overwritten; attach `meta.diff` when step 4 captured a UTF-8
   "before".

Nothing in this handler compares the incoming `content` against the "before" it may have just read:
step 5's `writeAtomic(target, content)` (`packages/tools/src/tools/write-file.ts`) runs unconditionally, so `write_file`
always re-stages and renames even when the new bytes are identical to the existing file — it is
deterministic (the end state is always exactly `content`), but not idempotent in the sense of skipping
a no-op write.

### 4.2 `edit_file` / `multi_edit` — the shared `editFileLocked` core (`packages/tools/src/tools/edit-file.ts`)

1. `withFileLock(target, …)`.
2. `readTextFile` the current content; a non-UTF-8 decode throws `is_binary`
   (`packages/tools/src/tools/edit-file.ts`) — "the file would be rewritten as UTF-8" is the stated reason.
3. Run the caller's `transform` on the decoded (LF-normalized) content.
4. `writeAtomic(target, reencode(newText, decoded))` — `reencode` (owned by [tools-read-and-search](tools-read-and-search.md),
   `packages/tools/src/lib/text.ts`) restores each *unchanged* line's original terminator via a
   line-level diff against the old content, so `edit_file` never rewrites CRLF lines it did not touch
   (pinned by `packages/tools/tests/integration/edit-file.test.ts`, "BUG-07").
5. Build the diff and return.

`edit_file`'s `transform` is one call to `applyEdit` (`packages/tools/src/tools/edit-file.ts`):
- `old_string === new_string` → `invalid_input`.
- Count exact occurrences. Zero and no `replace_all`: try `findCascadeMatch` (whitespace-tolerant,
  owned by [tools-read-and-search](tools-read-and-search.md)); exactly one span → apply it and report `fuzzy: true`; more than
  one span → `ambiguous_match` naming the matched lines; no span → `no_match`, extended by
  `diagnoseNoMatch` which detects a pasted `read_file` line-number prefix or
  points at whitespace-differing candidate lines.
- More than one exact occurrence without `replace_all` → `ambiguous_match` naming up to 20 lines
  (`occurrenceLines`).
- `replace_all` → replace every occurrence via `split`/`join`.
- Otherwise → replace the single occurrence.

`multi_edit`'s `transform` folds `applyEdit` over `edits` in order, threading the previous result's
text forward (`packages/tools/src/tools/multi-edit.ts`); an empty `old_string` at any index throws `invalid_input`
before `applyEdit` runs; any `ToolError` from `applyEdit` is re-thrown with `edit[i]:`
prefixed onto its message and `index: i` merged into its fields — because the whole
`transform` throws inside one `writeAtomic`, no partial edit is ever persisted (pinned by
`packages/tools/tests/integration/multi-edit.test.ts`, "is all-or-nothing"). Within that loop, an `undefined` array slot
(`edits: [undefined]`) is a silent no-op — `if (spec === undefined) continue;` — but is still
counted toward the "Applied N edits" success message, since that count is `edits.length` rather than
the number actually applied (pinned by `packages/tools/tests/integration/multi-edit.test.ts`, "skips an undefined edit slot yet
still counts it as applied" / "continues past an undefined slot and still applies a later real edit").
A `null` slot instead throws an uncaught `TypeError` (`spec.old_string` on `null`) that is never
wrapped as a `ToolError` (pinned by `packages/tools/tests/integration/multi-edit.test.ts`, "surfaces a TypeError when an edit
entry is malformed") — it propagates as the generic non-`ToolError` case in Section 6's failure table.

### 4.3 `apply_patch` (`applyPatchTool` and `applyParsed` in `packages/tools/src/tools/apply-patch.ts`)

1. Detect `*** Begin Patch` after tolerating leading whitespace and parse it with `parseModelPatch`;
   otherwise use
   `parsePatch`. Either parse failure → `invalid_input: "Malformed patch: …"`.
2. Reject an empty parse, or one where no block is "actionable" (has hunks, or is a genuine
   rename whose paths differ) → `invalid_input: "Patch contains no applicable hunks"`.
3. Collect every referenced path (old and new name of every block) and resolve+confine each; lock all
   of them together via `withFileLocks` before any file is touched.
4. For each block, in `applyParsed`:
   - `claim(abs, rel)` refuses a second block naming a path already claimed by this batch
      — "combine them into a single block".
   - **Rename** (`isRename`, old ≠ new, neither `/dev/null`): read+decode the source (rejecting
     non-UTF-8), apply either hunk representation to it; a hunk mismatch → `patch_failed` naming the
     file and first failing hunk. A pure
     rename (no hunks, or the applied result equals the source) becomes `{ type: "rename", path: to,
     from }`; otherwise it carries the re-encoded `content`.
   - **Modify/create/delete**: read the target unless creating; apply the selected representation; a
     mismatch → `patch_failed` the same way. A model-envelope delete explicitly deletes the whole
     named file; a unified delete must still produce an empty result. Create requires the target not
     already exist. Otherwise a `modify` op carries the re-encoded content.
5. `applyOpsAtomic(ops)` in `applyParsed` — all files change or none do; a non-`ToolError` failure here is
   wrapped as `io_error`.
6. Return a summary line per change, tagged `A`/`M`/`D`/`R` with `(+adds -dels)` counts
   (`countChanges`).

A block whose cleaned old and new paths are equal after resolution (e.g. `b/./same.txt` resolving to
the same absolute path as `a/same.txt`) is **not** treated as a rename — although the `isRename` guard
 is satisfied (`cleanName` only strips a leading `a/`/`b/`, so the cleaned strings
`"same.txt"` and `"./same.txt"` still differ), the separate `absFrom !== absTo` check finds
the two paths resolve to the same absolute path, so the `if` body (and its `continue`) is skipped and
execution falls through past the whole `if (isRename)` construct to the modify branch below (pinned:
`packages/tools/tests/integration/apply-patch.test.ts`, "treats a rename whose paths resolve to the same file as a plain
modify").

### 4.4 `replace` (`replace.handler` in `packages/tools/src/tools/replace.ts`)

1. Require `path` or `glob` → else `invalid_input`.
2. Compile the pattern as a global `RegExp` (`buildRegex`); reject a pattern that matches
   the empty string, so it can never insert between every character.
3. `scopeFiles` : a `path` naming a file scans just that file; a directory is walked
   honoring `.gitignore` up to `maxTraversalEntries`, throwing `too_large` on truncation; neither file nor directory → empty scope.
4. Per file, charged against a `regexScanBudgetMs` `ScanBudget` (`createScanBudget`,
   `packages/tools/src/lib/scan-budget.ts`, satisfying the `ScanBudget` interface declared in the
   same module): read (binary/oversized/unreadable files are silently skipped by `readTextBuffer`
   returning falsy), `match`, then `replace`; a file whose content is unchanged is dropped. Exhausting the budget mid-scope throws `timeout` before the next file is read, naming the
   pattern and how many files were scanned — the doc remark explains why: `replace` has no
   ripgrep path in any deployment, so a catastrophically backtracking pattern is applied once per file
   in-process (`packages/tools/src/tools/replace.ts`, `packages/tools/src/lib/scan-budget.ts`). The budget's own TSDoc is explicit that it
   charges *only* the wall-clock time spent inside a `charge()`-wrapped regex application — never a
   `stat`, a read, the directory walk, or delay between applications. Scheduler time during an
   in-flight application is charged, so a `timeout` reports elapsed charged work rather than I/O or
   traversal time (`packages/tools/src/lib/scan-budget.ts`, `createScanBudget`).
5. Accumulate the re-encoded bytes of every changed file; exceeding `maxMutationBytes` throws
   `too_large` before anything is written.
6. No changed file → `"(no matches)"`.
7. `dry_run` (default `true`): return counts plus a unified-diff preview, writing nothing.
8. Otherwise: `withFileLocks` on every changed path, `applyOpsAtomic(ops)` — all files or none; return a per-file summary plus the combined diff.

### 4.5 `move` (`packages/tools/src/tools/move.ts`)

1. Resolve+confine both `source` and `destination`; identical resolved paths → `invalid_input`.
2. `withFileLocks([absSrc, absDst], …)`.
3. Reject either endpoint being a symlink (`assertNotSymlink`).
4. `fs.stat(absSrc)`; a directory source → `not_a_file`; any stat failure →
   `fsError`.
5. `fs.stat(absDst)`; existing directory destination → always `not_a_file`, even with
   `overwrite`; existing file destination without `overwrite` → `invalid_input`.
6. `mkdir -p` the destination's parent, then a single `renameWithRetry(absSrc, absDst)`
   (`@clarvis/paths`) — atomic because it is same-filesystem (doc remark `packages/tools/src/tools/move.ts`); wrap any
   failure via `fsError`.
7. `fsyncDir` both parent directories.
8. Report the move, noting `(overwritten)` when the destination previously existed.

### 4.6 `copy` (`packages/tools/src/tools/copy.ts`)

Steps 1-5 identical in shape to `move`, same error codes. Then, because `fs.rename`
cannot duplicate a file:
6. Copy into a `tmpPathFor(absDst)` sibling in the destination directory via `fs.copyFile`
   (binary-safe), `chmod` the temp file to the source's mode (`& 0o777`), then
   `renameWithRetry(tmp, absDst)`; on any failure in this block, best-effort `fs.rm` the
   temp file before mapping the error through `fsError`.
7. `fsyncDir` the destination directory only — unlike `move` (step 7 above), `copy` never
   fsyncs the source's parent directory, because nothing in that directory's entry changed; report,
   noting `(overwritten)`.

### 4.7 `mkdir` (`packages/tools/src/tools/mkdir.ts`)

Resolve+confine; `fs.mkdir(target, { recursive: true })`. Node's recursive `mkdir` throws `EEXIST`
only when the path exists as a **non**-directory, which this handler maps to `not_a_file`; any other error goes through `fsError`. Node returns the first path segment it
actually created, or `undefined` when the directory already existed — that return value alone
distinguishes "created" from "already existed" in the success message; no separate
existence check is made before the call.

### 4.8 `remove` (`packages/tools/src/tools/remove.ts`)

Resolve+confine; `withFileLock(target, …)`; `fs.lstat` (not followed) — a missing path maps through
`fsError` to `not_found`, a directory throws `not_a_file`. The actual delete is
`applyOpsAtomic([{ type: "delete", path: target }])` — so a symlink target is caught by
`applyOpsAtomic`'s own `assertNotSymlink` inside `validateTargets` (`packages/tools/src/lib/atomic.ts`) even though
`remove.ts` itself only `lstat`s, never symlink-checks directly; a non-`ToolError` failure from the
atomic apply is remapped through `fsError`.

### 4.9 `applyOpsAtomic` — the shared transaction (`packages/tools/src/lib/atomic.ts`)

| Phase | Function | What happens | On failure |
| --- | --- | --- | --- |
| Stage | `stageAll` | For every `create`/`modify` (and a content-carrying `rename`), `mkdir -p` the target's directory and write the new body to a fresh `tmpPathFor` sibling via `stage()`: `open(tmp,"wx")` exclusive-create, write, `fh.sync()`, close | `cleanupStaged` removes every temp file staged so far, then rethrows |
| Validate | `validateTargets` | For each op, reject a symlink target/source (`assertNotSymlink`); for `rename`, require the source exist and not be a directory (`not_found`/`not_a_file`) and the destination *not* exist (`invalid_input`); for others, capture the existing mode or `undefined`, rejecting an existing directory (`not_a_file`) | On throw here, `applyOpsAtomic` itself calls `cleanupStaged` before rethrowing |
| Commit | `commitWithRollback` | In order: for a `rename`, move the *original* aside to a `tmpPathFor` backup (recording it), `chmod` the staged tmp to the captured mode, then rename it into place — or, for a no-content rename, rename the source straight to the destination; for `create`/`modify`/`delete`, move any existing original aside as backup (absence is fine), then for non-delete rename the staged tmp into place | On any throw, walk `committed` **in reverse**, undoing each: restore a from-backup or reverse a plain rename; for others, remove the new file and rename the backup back. An undo that itself fails is *not* fatal by itself — it is recorded in `unrestored`, naming a preserved backup; if `unrestored` is non-empty the whole batch fails with `io_error` naming which originals could not be restored, otherwise the *original* error propagates |
| fsync | — | Every directory touched by any op (destination's, and a rename's source's) is `fsyncDir`ed | n/a |
| Cleanup | — | Every backup and from-backup created during commit is best-effort removed (`bestEffort("atomic_backup_cleanup"/"atomic_source_backup_cleanup", …)`) | best-effort — a cleanup failure does not fail the call |
| Outer catch | `applyOpsAtomic` | Any directory this call created (from staging) is removed | `packages/tools/src/lib/atomic.ts` |

`applyOpsAtomic` itself places no restriction on a batch reusing the same absolute path across two
ops — e.g. a `rename` into a path immediately followed by a `delete` of that same path in one call
succeeds (`packages/tools/tests/integration/atomic.test.ts`, "commits a content-rename followed by a delete of the moved file").
The per-path exclusivity in invariant 7 below is `apply_patch`'s own `claim()` policy, not a property
of this shared primitive.

### 4.10 Locking (`withFileLock`/`withFileLocks`, `packages/tools/src/lib/atomic.ts`)

A per-absolute-path `Map<string, Promise<unknown>>` chains each new call onto the previous one for
that path : `next = prev.then(fn, fn)` so a prior rejection does not wedge later callers,
and the map entry is deleted once the tail settles, so an idle path holds no memory. `withFileLocks`
sorts and de-duplicates the requested paths, then nests `withFileLock` calls in that fixed order
 — a fixed global order for whatever set of paths any two callers request rules out a
lock-ordering deadlock between them.

## 5. Invariants

1. **A locked, atomic write leaves no partial file on failure.** `write_file`/`edit_file` route every
   mutation through `writeAtomic` under `withFileLock`.
   Production: `packages/tools/src/lib/atomic.ts`.
   Test: `packages/tools/tests/integration/write-file.test.ts` ("is atomic: a failed write
   leaves an existing file unchanged").

2. **`writeAtomic` refuses a symlink target before writing anything.**
   Production: `packages/tools/src/lib/atomic.ts`.
   Test: `packages/tools/tests/integration/write-file.test.ts`.

3. **A batch of `FileOp`s is all-or-nothing: any failure during staging, validation or commit restores
   every already-committed op.**
   Production: `packages/tools/src/lib/atomic.ts` (staging cleanup commit rollback).
   Test: `packages/tools/tests/integration/atomic.test.ts` (pure-rename rollback)
   (delete+create rollback) (rename-that-fails-during-its-own-commit rollback).

4. **When rollback itself cannot restore an original, the batch fails `io_error` naming exactly which
   path could not be restored, and says its content is preserved in an adjacent temp/backup file
   rather than lost.**
   Production: `packages/tools/src/lib/atomic.ts`.
   Test: `packages/tools/tests/integration/atomic.test.ts`.

5. **A rename validated against a missing source or an already-existing destination fails before any
   file is touched** (`not_found` / `invalid_input` respectively), a non-rename `create`/`modify`
   target that is an existing directory likewise fails before anything is touched (`not_a_file`), and
   a non-`ENOENT` stat error during validation propagates unmapped (not wrapped as a `ToolError`).
   Production: `packages/tools/src/lib/atomic.ts`.
   Test: `packages/tools/tests/integration/atomic.test.ts`. None of these
   ranges exercises the destination-already-exists half directly — that half is pinned only at the
   `apply_patch` level, by `packages/tools/tests/integration/apply-patch.test.ts` ("refuses a
   rename whose destination already exists and changes nothing").

6. **`multi_edit` is all-or-nothing across its whole edit list**: one failing edit at index *i*
   reverts every earlier edit in the same call (nothing is written) and the error names `edit[i]`.
   Production: `packages/tools/src/tools/multi-edit.ts` (the whole list runs inside one
   `editFileLocked` transform, so the single `writeAtomic` only fires if every edit in the loop
   succeeds).
   Test: `packages/tools/tests/integration/multi-edit.test.ts` ("is all-or-nothing: a failing
   edit reverts everything and reports its index").

7. **`apply_patch` claims each target path at most once per call**; a second block naming a path
   already claimed is refused before any file is written.
   Production: `packages/tools/src/tools/apply-patch.ts`.
   Test: `packages/tools/tests/integration/apply-patch.test.ts` ("refuses multiple blocks
   targeting the same file"), and the rename-chain case ("refuses a rename chain that
   reuses an endpoint").

8. **`apply_patch` never partially applies a multi-file patch**: a hunk failing anywhere in the batch
   changes nothing, in any file.
   Production: `applyParsed` in `packages/tools/src/tools/apply-patch.ts` (single `applyOpsAtomic` call for the
   whole batch).
   Test: `packages/tools/tests/integration/apply-patch.test.ts` (model envelope) (raw unified diff).

9. **Both accepted `apply_patch` grammars expose every source and destination to guard analysis**;
   model-envelope `Move to` destinations cannot bypass the same outside-workspace verdict as unified
   `---`/`+++` headers. Production: `patchPaths` in `packages/tools/src/guard/paths.ts`. Test:
   `packages/tools/tests/unit/guard-context.test.ts` ("extracts every model-envelope source and move
   destination").

10. **`replace` never writes a partial result**: `dry_run` defaults to `true`, and a non-dry run commits
   every changed file through one `applyOpsAtomic` call.
   Production: `packages/tools/src/tools/replace.ts`.
   Test: `packages/tools/tests/integration/replace.test.ts` ("rejects an aggregate mutation …
   before writing anything") (regex-timeout case writes nothing).

11. **`replace`'s regex time budget is charged per file, and exhausting it fails the call before the
    next file is scanned — never applying a partial codemod.**
    Production: `packages/tools/src/tools/replace.ts`; `packages/tools/src/lib/scan-budget.ts`
    (budget mechanism, owned by [tools-read-and-search](tools-read-and-search.md), cited here as consumed).
    Test: `packages/tools/tests/integration/replace.test.ts`.

12. **`edit_file`/`multi_edit` preserve every *unchanged* line's original line terminator**, even in a
    file with mixed CRLF/LF endings — only lines the diff actually rewrites take the file's dominant
    ending — and re-prepend the file's original UTF-8 BOM, even though `transform` ran on BOM-stripped,
    LF-normalized content throughout.
    Production: `packages/tools/src/tools/edit-file.ts` (`reencode`, owned by
    [tools-read-and-search](tools-read-and-search.md), `packages/tools/src/lib/text.ts` — the terminator restoration is a
    `diffArrays` alignment against the pre-edit tokenization, and the BOM re-prepend is
    the unconditional `return decoded.bom ? BOM + out : out;`).
    Test: `packages/tools/tests/integration/edit-file.test.ts` ("BUG-07", line terminators) ("preserves a UTF-8 BOM through an edit").

13. **Selected skill packages and workspace-authored Clarvis configuration are immutable to
    ordinary native mutation tools.** Before guard review or
    handler dispatch, `protectSkillPackages` extracts every path through `buildGuardContext` and
    applies `assertOutsideRoots` to `write_file`, `edit_file`, `multi_edit`, `apply_patch`, `replace`,
    `move`, `copy`, `mkdir`, and `remove`. This applies even if the skill directory is nested under
    the writable workspace. Because `replace` recursively traverses its scope, it additionally
    rejects an ancestor that contains a protected root; a scope such as `.agents` cannot rewrite a
    selected `.agents/skills/<name>` package indirectly. Command execution has the separate posture
    defined by the shell and sandbox contracts. Production: `packages/tools/src/core.ts` and
    `packages/tools/src/lib/paths.ts`. Test: `packages/tools/tests/integration/api.test.ts`.

    `protectWorkspaceConfiguration` applies the same dispatcher boundary to the workspace
    `.clarvis` and `.agents` roots resolved through `configurationRoots`. It rejects every listed
    mutation tool when its target is in those roots. `copy` may read a configuration source when its
    destination is outside configuration. `replace` filters both authored roots from directory
    traversal, while still allowing a project-root replacement over ordinary files. The structured
    error directs the operator to the consent-bearing `/clarvis-configure` route. Command execution
    keeps the separate posture in
    [tools-shell-and-monitor.md](tools-shell-and-monitor.md); the builtin guide prohibits treating
    it as an alternate configuration writer. Production: `protectWorkspaceConfiguration` in
    `packages/tools/src/core.ts`, `assertOutsideRoots` in `packages/tools/src/lib/paths.ts`, and
    `configurationRoots` in `packages/paths/src/configuration.ts`, and `scopeFiles` in
    `packages/tools/src/tools/replace.ts`. Test:
    `packages/tools/tests/integration/api.test.ts` ("requires /clarvis-configure for authored
    workspace configuration mutations").

14. **`move`/`copy` refuse when either endpoint is a symlink**, checked before any stat or filesystem
    mutation; `replace` refuses the same way on a non-dry-run commit, through the shared
    `applyOpsAtomic` → `validateTargets` path rather than its own explicit check.
    Production: `packages/tools/src/tools/move.ts`, `packages/tools/src/tools/copy.ts`
    (both via `packages/tools/src/lib/atomic.ts`); `packages/tools/src/tools/replace.ts`
    → `packages/tools/src/lib/atomic.ts`.
    Test: `packages/tools/tests/integration/move.test.ts`,
    `packages/tools/tests/integration/copy.test.ts`,
    `packages/tools/tests/integration/replace.test.ts` ("refuses to write through a symlink,
    leaving the target intact").

15. **`move`/`copy` refuse an existing destination unless `overwrite: true`; an existing destination
    that is a directory is refused regardless of `overwrite`.**
    Production: `packages/tools/src/tools/move.ts`, `packages/tools/src/tools/copy.ts`.
    Test: `packages/tools/tests/integration/move.test.ts`,
    `packages/tools/tests/integration/copy.test.ts`.

16. **`copy` preserves the source's permission mode (low 9 bits) on the copy**, and is binary-safe
    (byte-identical).
    Production: `packages/tools/src/tools/copy.ts` (`chmod(tmp, srcStat.mode & 0o777)`).
    Test: `packages/tools/tests/integration/copy.test.ts` (binary-safe) (mode preserved, `skipIf(!modeBitsEnforced)`).

17. **`mkdir` is idempotent**: creating an already-existing directory succeeds and reports so, rather
    than erroring.
    Production: `packages/tools/src/tools/mkdir.ts` (Node's recursive `mkdir` returns
    `undefined` when nothing new was created).
    Test: `packages/tools/tests/integration/mkdir.test.ts`.

18. **`remove` operates only on regular files**, never directories, and never through a symlink — the
    symlink guard is enforced by the shared `applyOpsAtomic` path even though `remove.ts` itself only
    `lstat`s.
    Production: `packages/tools/src/tools/remove.ts`; symlink guard at
    `packages/tools/src/lib/atomic.ts` (inside `validateTargets`, reached via
    `applyOpsAtomic` → the generic non-`rename` branch).
    Test: `packages/tools/tests/integration/remove.test.ts` (directory) (symlink).

19. **Concurrent calls against the same absolute path are serialized in call order and never lose an
    update**; a rejection from one holder does not wedge the next.
    Production: `packages/tools/src/lib/atomic.ts`.
    Test: `packages/tools/tests/integration/edit-file.test.ts` ("serializes concurrent edits
    to the same file without lost updates").

20. **`withFileLocks` locks a set of paths in one fixed sorted order**, so two callers requesting
    overlapping path sets can never deadlock against each other by acquiring in opposite orders.
    Production: `packages/tools/src/lib/atomic.ts`.
    Test: ~~unpinned — no test in this document's scope constructs two concurrent multi-path lock acquisitions to
    exercise the ordering directly; the rule is stated only in the function's own TSDoc remark
    (`packages/tools/src/lib/atomic.ts`).~~ **Pinned**:
    `packages/tools/tests/unit/file-locks.test.ts`. Two concurrent calls request the same pair in
    opposite orders; the assertions race a 2 s timer so a regression *fails* rather than hanging to
    the suite's 60 s ceiling. Verified by removing the sort: two of the five tests fail in exactly
    2 s, which is what a real hold-and-wait cycle looks like here — the promise chain never settles
    and nothing else would ever time it out.

21. **A batch commit fsyncs every directory it touched, and best-effort removes every backup/temp file
    it created, on both the success and (for created directories) the failure path.**
    Production: `packages/tools/src/lib/atomic.ts` (success) (failure — created
    dirs only).
    Test: `packages/tools/tests/integration/atomic.test.ts` (all assert
    `tmpFiles(root)` is empty after the operation).

## 6. Failure modes and degradation

| Situation | Code | Where mapped | Degrades or fails hard? |
| --- | --- | --- | --- |
| Target path is a directory (write/edit) | `not_a_file` | `packages/tools/src/tools/write-file.ts`, `packages/tools/src/lib/atomic.ts` (via `applyOpsAtomic`'s `validateTargets`) | fails hard, nothing written |
| File missing (edit/move/copy/remove) | `not_found` | `fsError` (`packages/tools/src/errors.ts`), `packages/tools/src/lib/atomic.ts` (rename source) | fails hard |
| Non-UTF-8 file targeted by edit/patch | `is_binary` | `packages/tools/src/tools/edit-file.ts`, `packages/tools/src/tools/apply-patch.ts` | fails hard — "would be rewritten as UTF-8" |
| Symlink target/source/destination | `invalid_input` | `packages/tools/src/lib/atomic.ts` | fails hard, before any I/O |
| `old_string`/`new_string` identical | `invalid_input` | `packages/tools/src/tools/edit-file.ts` | fails hard |
| `old_string` empty | `invalid_input` | `edit-file.ts` schema `minLength: 1` (edit_file) / `packages/tools/src/tools/multi-edit.ts` (multi_edit, explicit check since the array item schema has no `minLength`) | fails hard |
| No exact/fuzzy match | `no_match` | `packages/tools/src/tools/edit-file.ts` | fails hard, message extended with a diagnosis |
| Multiple matches without `replace_all` | `ambiguous_match` | `packages/tools/src/tools/edit-file.ts` | fails hard |
| Patch hunk does not apply | `patch_failed` | `packages/tools/src/tools/apply-patch.ts` | fails hard, names file (+hunk when identifiable) |
| Patch malformed / no applicable hunks / duplicate block / missing path | `invalid_input` | `packages/tools/src/tools/apply-patch.ts` | fails hard |
| Rename source is directory | `not_a_file` | `packages/tools/src/lib/atomic.ts` | fails hard |
| Rename destination already exists | `invalid_input` | `packages/tools/src/lib/atomic.ts` | fails hard |
| File over `maxFileBytes` | `too_large` | delegated to `readTextFile`/`readEditableFile` (owned by [tools-read-and-search](tools-read-and-search.md)) | fails hard |
| Native mutation targets a selected skill package | `path_escape` | `protectSkillPackages` in `packages/tools/src/core.ts` | fails before guard/handler; nothing is changed |
| `replace` scope exceeds `maxTraversalEntries` | `too_large` | `packages/tools/src/tools/replace.ts` | fails hard, nothing written |
| `replace` aggregate mutation exceeds `maxMutationBytes` | `too_large` | `packages/tools/src/tools/replace.ts` | fails hard, nothing written |
| `replace` regex budget exhausted | `timeout` | `packages/tools/src/tools/replace.ts` | fails hard rather than applying a partial codemod (explicit design choice per `packages/tools/src/tools/replace.ts`) |
| Unmapped filesystem errno | `io_error` | `fsError` fallback (`packages/tools/src/errors.ts`), logged at `debug` via the warn sink | degrades to a generic code, but the real errno reaches the log channel, not the model |
| Non-`ToolError` throw anywhere in a handler | `internal` | `serializeError` (`packages/tools/src/errors.ts`) | degrades — real detail goes to the warn sink at `error` level, caller sees only `"internal error"` |
| Rollback itself cannot restore an original | `io_error`, message names the unrestored path(s) | `packages/tools/src/lib/atomic.ts` | fails hard, but is explicit about data loss risk rather than silent |
| Best-effort cleanup (temp/backup removal) fails | *(not returned to the caller)* | `bestEffort(operation, run)` (`packages/tools/src/lib/tasks.ts`), called at `packages/tools/src/lib/atomic.ts` | reaches the log channel, not the model: `bestEffort` catches, logs through the package's `warn` sink at `debug` with `event: "tools.best_effort_failed"` and `fields.operation` naming the call site, then resolves — the same not-surfaced-to-the-model/reaches-the-log-channel distinction the `io_error` row above draws, not silence |
| `remove`'s own `lstat` fails for a reason other than missing/directory | mapped via `fsError` | `packages/tools/src/tools/remove.ts` | fails hard |

## 7. Coupling

**Depends on (runtime, static imports):**
- `@clarvis/paths` — `tmpPathFor`, `renameWithRetry`, `fsyncDir`, `writeFileDurable`, `TMP_GLOB`
  (`packages/tools/src/lib/atomic.ts`; also directly in `packages/tools/src/tools/move.ts`, `packages/tools/src/tools/copy.ts`). This is a hard, static import; the
  temp-naming and rename-retry *policy* is that package's, not re-implemented here — confirmed by
  `renameForTools` (`packages/tools/src/lib/atomic.ts`) being a thin bind of `renameWithRetry` to this module's own
  `fs.rename`, kept as a live function reference specifically so a test can inject a failing rename
  "without duplicating `@clarvis/paths`' retry algorithm" (doc remark, `packages/tools/src/lib/atomic.ts`).
- `../errors.ts` (`ToolError`, `fsError`) — every handler and `atomic.ts` itself construct or rethrow
  through this type; owned by [tools-contract-and-dispatch](tools-contract.md).
- `../lib/paths.ts` (`resolvePath`, `displayPath`) — every handler resolves and confines its path
  argument here before touching the filesystem; owned by [security-confinement-and-redaction](../cross-cutting/security.md)
  (the check itself is `resolvePath`'s `confine` branch, `packages/tools/src/lib/paths.ts`,
  which delegates to `assertWithinWorkspace`). This subsystem consumes but does not define workspace
  confinement.
- `../lib/textfile.ts`, `../lib/text.ts`, `../lib/unified-diff.ts`, `../lib/scan-budget.ts`,
  `../lib/files.ts` — decode/encode/diff/budget/listing primitives, owned by [tools-read-and-search](tools-read-and-search.md).
- `diff` (npm) — `packages/tools/src/tools/apply-patch.ts` (`applyPatch`, `parsePatch`, `StructuredPatch`) is the only
  mutation tool with a third-party parsing dependency.

**What forces the direction:** every mutation handler is registered into
`packages/tools/src/tools/registry.ts` (owned by [tools-contract-and-dispatch](tools-contract.md)) as a `ToolDef`, so
nothing outside `@clarvis/tools` can call `writeAtomic`/`applyOpsAtomic` directly — they are not
re-exported from any of the package's four public entrypoints (`.`, `./guard`, `./shell`,
`./sandbox`), each of them an internal-only `lib/*.ts` module
including `lib/atomic.ts`. A host (`@clarvis/loop`, `@clarvis/kernel`) reaches these tools only by
their wire names through dispatch; which of those names a host UI renders as a "mutation" is
`@clarvis/code`'s `MUTATION_TOOLS` set (`packages/code/src/adapters/tool-identity.ts`, whose
twelve members are pinned name by name at `packages/code/tests/unit/tool-identity.test.ts`).
That set is a transcript-rendering concern and not a grant boundary — its only two readers collapse
an oversize diff behind a chip (`packages/code/src/views/tools/mutation-gate.ts`) and stop a
mutation call folding into a run of reads (`packages/code/src/views/tool-groups.ts`) — so the
consuming set is owned by [code-transcript](../hosts/code-transcript.md), not here.

**Depends on this (nothing further downstream):** no other package in the monorepo
imports `packages/tools/src/lib/atomic.ts` or the individual tool modules directly — they are reached
exclusively through the registry and tool dispatch, which is [tools-contract-and-dispatch](tools-contract.md)'s contract.

## 8. Open questions

- ~~**Why `withFileLocks`'s deadlock-freedom has no dedicated test.** The mechanism (fixed sorted lock
  order) is stated in the function's own TSDoc (`packages/tools/src/lib/atomic.ts`) and is used by every multi-path
  mutation tool (`apply_patch`, `replace`, `move`, `copy`), but no test in this document's scope constructs two
  concurrent calls with overlapping, oppositely-ordered path sets to prove the property empirically —
  see invariant 20.~~ **Resolved**, see invariant 20: the deadlock is real and reproducible,
  and the guard now fails loudly instead of hanging. This was a gap to flag, not fill: the parent-directory TOCTOU threat model this
  locking discipline does *not* address is explicitly delegated to [security-confinement-and-redaction](../cross-cutting/security.md),
  and is out of bounds here. **Recorded**: that threat model is
  now written at `resolvePath` (`packages/tools/src/lib/paths.ts`), naming this document's five
  mutating tools as the exposed set — `mkdir`, `remove`, `move`, `copy` and a `write_file` creating a
  new file — and stating why the read path is not exposed the same way. The defect is unchanged.
- **The Windows errno for `apply_patch` creating a file beneath a path that is itself a file** is
  explicitly unidentified in the fixtures: `packages/tools/tests/integration/apply-patch.test.ts`'s comment states "Windows
  raises some other code for the same mistake … and which one has not been identified", and the test
  itself is `skipIf(!posixShell)`. This mirrors (but is a distinct instance of) the Windows gap named
  in the project-level known-issues list for `fsError`'s `io_error` fallback; no source or test file
  in the monorepo names the missing errno — `ENOTDIR` is the only code `fsError` maps to `not_a_file`
  alongside `EISDIR` (`packages/tools/src/errors.ts`).
  - `posixShell` (`packages/tools/tests/helpers/fixtures.ts`) and `modeBitsEnforced`
    (`packages/tools/tests/helpers/fixtures.ts`) are the two predicates this subsystem's own tests use to suppress
    platform-specific assertions: `modeBitsEnforced` is `false` on `win32` or when running as root
    (mode bits are either not enforced or ignored), and gates every "preserves mode"/"reports io_error
    under read-only …" test across write_file, edit_file, apply_patch, move, copy, mkdir and remove;
    `posixShell` is `false` on `win32` and gates only the one `apply_patch` ENOTDIR-mapping test above.
    Both predicates and their rationale are documented in the fixtures file itself
    (`packages/tools/tests/helpers/fixtures.ts`), not derived independently here.
- **Whether a `rename`'s `fromBackup` restoration path in `commitWithRollback` can itself partially
  succeed** (i.e. the `to` removal in the reverse-order undo at `packages/tools/src/lib/atomic.ts` succeeds but the
  `renameForTools(rec.fromBackup, from)` on the same line-group fails) is exercised by the test suite
  (`packages/tools/tests/integration/atomic.test.ts`) only for the case where *both* renames in the undo fail; a scenario where
  the first sub-step of one undo succeeds and the second fails independently is not separately pinned.
- **`replace`'s interaction with `readOnly: true`** is observed behaviorally (`packages/tools/tests/integration/replace.test.ts`
  — the tool answers as if it does not exist, code `not_found`) but the mechanism that hides a mutation
  tool under `readOnly` belongs to the registry/dispatch layer ([tools-contract-and-dispatch](tools-contract.md)) and is
  not re-derived here.
- **The consuming `MUTATION_TOOLS` name set** (which of these nine names a host UI renders as a
  mutation) is owned by [code-transcript](../hosts/code-transcript.md), and is only cited above
  (Section 7) as a pointer, not described.
