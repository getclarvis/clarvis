# The memory wiki: documents, tree, reindex, revisions, batches and search

> Implemented at `packages/memory/src/**` and `packages/memory/tests/**`. Every claim below is
> anchored to a file and a named symbol or test. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/memory`'s store layer persists a workspace's execution memory as a **navigable Markdown
wiki**. The module header states the shape directly: `PROFILE.md` (workspace compilation) →
`<topic>/TOPIC.md` (domain compilation) → `<topic>/<sub>/MEMORY.md` (detail leaf)
(`packages/memory/src/types.ts`). Every document is a small frontmatter block plus freeform
markdown; nothing else about the knowledge is persisted — no vectors, no embeddings, no derived
index (`packages/memory/src/query.ts`).

The subsystem this document covers is everything under that model that is *not* a model-facing tool
and not the indexing job pipeline: the `MemoryStore` port and its two shipped adapters (file-backed
and in-memory), the atomic batch engine with its crash journal and recovery matrix, the revision
history, the deterministic navigation reindex, the frontmatter (de)serializer, the run digest, the
storage-limit and bounded-I/O layer, the content/machinery split, and the lexical search layer
(BM25F ranking plus the bounded grep scanner).

Two problems drive the design as written. First, one indexer response can rewrite a leaf, its
ancestor topics and the profile at once, and applying those one at a time leaves a `PROFILE` that
describes a change which never reached its leaf — so mutation is staged, journaled, applied and
committed as a unit (`packages/memory/src/journal.ts`). Second, a human is expected to hand-edit
the tree in an editor, so parsing never throws, the reindex is stateless and regenerated from the
tree, and history records when the tree was edited behind the store's back rather than refusing the
edit (`packages/memory/src/frontmatter.ts`, `packages/memory/src/reindex.ts`,
`packages/memory/src/revisions.ts`).

**Delegated to siblings.** The durable index-job queue's conformance and policy belong to
*memory-indexer-and-jobs* (`packages/memory/src/file-store/jobs.ts`, `src/jobs.ts`, `src/drain.ts`,
`src/worker.ts`, and conformance cases at `packages/memory/src/testing.ts`). The write
policy and the seven model-facing tools belong to *memory-capability-and-tools*
(`packages/memory/src/policy.ts`, `src/tools.ts`, `src/capability.ts`). Substitutable memory
providers belong to *capability-provider-executables* (`packages/memory/src/provider-registry.ts`
and friends). This document names those seams where they touch the store and does not re-describe
them.

---

## 2. Surface

### 2.1 Ports (types only)

| Type | Declared at | What it is |
| --- | --- | --- |
| `MemoryTx` | `packages/memory/src/types.ts` | read / readBounded? / write / delete / list / grep / wasIndexed / markIndexed / version |
| `MemoryBatch` | `packages/memory/src/types.ts` | staging handle: `id`, read, list, `write(rel, content, {derived?})`, delete |
| `MemoryBatchInput` | `packages/memory/src/types.ts` | `{ source: MemoryRevisionSource; commit?: MemoryBatchCommit }` |
| `MemoryRevisionReader` | `packages/memory/src/types.ts` | `list(relPath)`, `read(relPath, revisionId)` |
| `MemoryUnitOfWork` | `packages/memory/src/types.ts` | `MemoryTx` + `revisions` + `jobs` + `batch<T>()` |
| `MemoryStore` | `packages/memory/src/types.ts` | `MemoryTx` + `exclusive<T>()` + `revisions` + `jobs` + `recover()` |
| `MemoryMutationFence` | `packages/memory/src/types.ts` | `before(tx)` / `after(tx)` lease fence around a protected mutation |
| `MemoryClock` | `packages/memory/src/clock.ts` | `now()` and `after(ms, fn) => cancel` |

`MemoryUnitOfWork.batch` is the **only** route to recoverable mutation; the doc comment states the
consequence — "a batch and the reindex that follows it share one exclusive handle" is enforced by
the type system rather than by convention (`packages/memory/src/types.ts`).

### 2.2 Constructors and functions

| Function / constructor | Signature (abridged) | Source |
| --- | --- | --- |
| `createFileMemoryStore` | `(opts: CreateFileMemoryStoreOptions) => MemoryStore` | `packages/memory/src/file-store.ts` |
| `createInMemoryMemoryStore` | `(opts?: {clock?}) => MemoryStore` | `packages/memory/src/testing.ts` |
| `memoryStoreConformance` | `() => readonly ConformanceCase[]` | `packages/memory/src/testing.ts` |
| `createTestClock` | `(start?) => TestClock` | `packages/memory/src/testing.ts` |
| `createMemory` | `(opts: CreateMemoryOptions) => Memory` | `packages/memory/src/memory.ts` |
| `createFileMemory` | `(opts & {root}) => Memory` | `packages/memory/src/memory.ts` |
| `normalizeMemoryPath` | `(relPath: string) => string` | `packages/memory/src/paths.ts` |
| `compareMemoryPaths` | `(a, b) => number` | `packages/memory/src/paths.ts` |
| `memoryDocKind` | `(relPath) => DocKind` | `packages/memory/src/paths.ts` |
| `parseFrontmatter` | `(markdown) => ParsedDoc` | `packages/memory/src/frontmatter.ts` |
| `serializeDoc` | `(Partial<DocFrontmatter>, body) => string` | `packages/memory/src/frontmatter.ts` |
| `readDescription` | `(markdown) => string` | `packages/memory/src/frontmatter.ts` |
| `reindex` | `(store: TreeStore, logger?) => Promise<string[]>` | `packages/memory/src/reindex.ts` |
| `planReindex` | `(store: TreeReader, logger?) => Promise<ReindexChange[]>` | `packages/memory/src/reindex.ts` |
| `reindexView` | `(bx: MemoryBatch) => Pick<MemoryTx,"read"\|"write"\|"list">` | `packages/memory/src/batch.ts` |
| `runBatch` | `(prims, input, fn) => Promise<T>` (internal; not barrel-exported) | `packages/memory/src/batch.ts` |
| `decideRecovery` | `({markers, record, current}) => {outcome, reason?}` | `packages/memory/src/journal.ts` |
| `digestBody` | `(content) => string` (sha256 hex) | `packages/memory/src/revisions.ts` |
| `newRevisionId` | `(at) => string` | `packages/memory/src/revisions.ts` |
| `compareRevisionsNewestFirst` | `(a, b) => number` | `packages/memory/src/revisions.ts` |
| `queryMemory` | `({tx, input, config?}) => Promise<MemoryQueryResult>` | `packages/memory/src/query.ts` |
| `scoreDoc` / `buildStats` | BM25F scoring primitives | `packages/memory/src/text/bm25.ts` |
| `tokenList` / `tokenCounts` / `tokenize` / `tokenizeQuery` / `overlapScore` | `packages/memory/src/text/tokenize.ts` |
| `isBoundedPattern` / `createGrepScanner` / `matchWindowed` / `grepHitText` | `packages/memory/src/text/grep.ts` |
| `rankByOverlap` | `(items, query, keyOf, limit) => T[]` — **no production caller** | `packages/memory/src/similar.ts` |
| `buildDigest` / `renderDigest` | `packages/memory/src/digest.ts` |
| `extractTitle` / `isIndexFile` | `packages/memory/src/tree.ts` |
| `captureWorkspaceState` | `(cwd, logger?) => Promise<WorkspaceState \| undefined>` | `packages/memory/src/workspace-state.ts` |
| `readUtf8FileBounded` / `readUtf8PrefixSync` / `scanDirectoryBounded` | `packages/memory/src/bounded-io.ts` |
| `assertMemoryPayloadBytes` / `assertMemoryStorageCount` | `packages/memory/src/storage-limits.ts` |
| `bestEffortFileStore` / `detachFileStoreTask` | `packages/memory/src/file-store/tasks.ts` |
| `truncate` | `(text: string, max: number) => string` (internal; not barrel-exported) — prefix + trailing `…` when over `max`, unchanged otherwise | `packages/memory/src/text.ts` |

### 2.3 `CreateFileMemoryStoreOptions`

| Field | Type | Default | Source |
| --- | --- | --- | --- |
| `root` | `string` | required — "the wiki's Markdown, and nothing else" | `packages/memory/src/file-store.ts` |
| `machineryRoot` | `string?` | defaults to `root` | `packages/memory/src/file-store.ts`, `packages/memory/src/file-store/layout.ts` |
| `workspaceRoot` | `string?` | when given, root is created via `ensureWorkspaceSubdir` so the `.gitignore` seed has one owner | `packages/memory/src/file-store.ts`, `packages/memory/src/file-store/layout.ts` |
| `clock` | `() => number` | `Date.now` | `packages/memory/src/file-store.ts` |
| `lock` | `{staleMs?, heartbeatMs?, timeoutMs?, warnMs?}` | `60_000 / 15_000 / 180_000 / 5_000` | `packages/memory/src/file-store.ts`, `packages/memory/src/file-store/lock.ts` |
| `logger` | `Logger?` | `NOOP_LOGGER` | `packages/memory/src/file-store.ts` |

### 2.4 Errors

| Class | `code` | Thrown when | Source |
| --- | --- | --- | --- |
| `MemoryPathError` | `memory_path_invalid` | path absolute, escapes root, or not `.md` | `packages/memory/src/paths.ts` |
| `MemoryStorageLimitError` | `memory_storage_limit` | a byte or count budget is exceeded; carries `kind`, `identifier`, `actual`, `maximum` | `packages/memory/src/storage-limits.ts` |
| `MemoryRecoveryRequiredError` | `memory_recovery_required` | an interrupted batch awaits an operator decision; carries `batchId` | `packages/memory/src/journal.ts` |

### 2.5 Search input/output

`MemoryQueryInput` = `{ query, limit?, prefix?, kinds?, include_snippets? }`
(`packages/memory/src/query.ts`). `MemoryQueryHit` carries `path`, `kind`, `title`, `description`,
`tags`, `score`, `matched_fields`, `snippet`, `snippet_line`, `updated_at`, `pinned`, `authority`
(`packages/memory/src/query.ts`). `MemoryQueryResult` adds `scanned`, `listed`, `terms`, `truncated`, and an
optional `truncation_reasons` (`packages/memory/src/query.ts`). The `score` doc comment states it
is comparable only within one result set and must never be rendered as a percentage
(`packages/memory/src/query.ts`).

### 2.6 The `Memory` facade contract (`memory-contract.ts`)

`packages/memory/src/memory-contract.ts` is the type-only module `createMemory` (§4.11) builds
against; nothing in it executes. `CreateMemoryOptions` is `{ store: MemoryStore; indexer?:
IndexerRuntimeResolver; budgets?: Partial<MemoryBudgets>; clock?: MemoryClock; logger?: Logger }` —
its doc comment on `logger` states the option is "Threaded on to the drain, the index pass and the
deterministic reindex. Absent, each resolves to `NOOP_LOGGER`, so the behaviour is byte-identical to
before it existed". `IndexReport` is `{ run_id, skipped, note?, written: string[],
deleted: string[], reindexed, indexer_run_id?, continuation_blocker?: string | null }` — the return
shape of `Memory.index()`, produced by `packages/memory/src/memory.ts` (see §4.11); its
`indexer_run_id`/`continuation_blocker` fields are the sibling **memory-indexer-and-jobs** document's
(`indexRun`, `packages/memory/src/indexer/run.ts`). `ReviewDigest` is `{ totals: {documents,
topics, memories}; recent: {path, description, updated_at}[]; undescribed: string[] }`, produced by
`reviewDigest` (§4.11).

The `Memory` interface itself is the complete host-facing surface — every member
`createMemory` (`packages/memory/src/memory.ts`) must implement:

| Member | Signature | Implemented at | Owner of its behaviour |
| --- | --- | --- | --- |
| `index(run)` | `(run: RunSnapshot) => Promise<IndexReport>` | `packages/memory/src/memory.ts` | this document (dispatch) / **memory-indexer-and-jobs** (`indexRun`) |
| `reindex(tx?)` | reindexes through the supplied transaction when present; otherwise takes `store.exclusive` | `memory-contract.ts`, `packages/memory/src/memory.ts` | this document — §4.11 |
| `review()` | `() => Promise<ReviewDigest>` | `packages/memory/src/memory.ts` | this document — §4.11 |
| `seed(task?)` | `(task?: string) => Promise<string \| null>` | `packages/memory/src/memory.ts` | this document (`buildSeed`, `packages/memory/src/seed.ts`) |
| `query(input)` | `(input: MemoryQueryInput) => Promise<MemoryQueryResult>` | `packages/memory/src/memory.ts` | this document — §4.9 |
| `health()` | `() => Promise<MemoryHealthReport>` | `packages/memory/src/memory.ts` | **memory-indexer-and-jobs** (`health.ts`) |
| `enqueue(run, opts?)` | `(run, {providerKey?}) => Promise<MemoryIndexJob>` | `packages/memory/src/memory.ts` | **memory-indexer-and-jobs** (durable job queue) |
| `drain(opts?)` | `({limit?, signal?, clock?}) => Promise<MemoryDrainReport>` | `packages/memory/src/memory.ts` | **memory-indexer-and-jobs** (`drainIndexJobs`) — §4.11 constructs the shared `admitBlocked` rate limiter this delegates through |
| `jobs(filter?)` | `({state?, limit?}) => Promise<MemoryIndexJob[]>` | `packages/memory/src/memory.ts` | **memory-indexer-and-jobs** |
| `retryJob(runId)` | `(runId: string) => Promise<MemoryIndexJob \| null>` | `packages/memory/src/memory.ts` | **memory-indexer-and-jobs** |
| `tools` | `MemoryToolDef[]` | `packages/memory/src/memory.ts` | **memory-capability-and-tools** (`createMemoryTools`) |
| `store` | `MemoryStore` | `packages/memory/src/memory.ts` | this document — the injected port, re-exposed verbatim |

The optional transaction on `Memory.reindex` prevents nested locking: a caller already inside a
store unit of work passes that handle through to `reindexTree`; an ordinary caller omits it and the
facade takes `store.exclusive`. Mutation tools use the same transaction-aware rule through their
callback (`packages/memory/src/memory.ts`, `reindex` and `createMemoryTools`).

`index()`'s dispatch is this document's own logic even though the pass it delegates to is not: with no
`opts.indexer` resolver it returns `{skipped: true, note: "no-indexer", written: [], deleted: [],
reindexed: false}` rather than throwing (`packages/memory/src/memory.ts`), and a thrown `MemoryIndexError` from
`indexRun` is caught and folded into the same shape with `skipped: false` and the error's message as
`note` (`packages/memory/src/memory.ts`); any other thrown error propagates (`packages/memory/src/memory.ts`).

---

## 3. Data and formats

### 3.1 Document format

A document is `---` frontmatter, `---`, then the markdown body. `serializeDoc` emits keys in a fixed
order — `description`, `tags` (inline, only when non-empty), `authority`, `pinned`, then unrecognized
lines verbatim — and always emits `description`, flattened to one line
(`packages/memory/src/frontmatter.ts`). Real example, from the conformance fixture
(`packages/memory/src/testing.ts`):

```
---
description: bun facts
tags: [bun]
---
Bun is pinned to 1.3.14 via mise
```

`DocFrontmatter` is `{ description, tags, authority?, pinned?, extra? }`
(`packages/memory/src/types.ts`). `extra` is a `string[]` of unrecognized frontmatter lines kept
verbatim and in order, deliberately not a key/value map, "because it round-trips block scalars,
nested maps and duplicate keys that a map would silently destroy"
(`packages/memory/src/types.ts`).

`DocKind` is derived from the basename alone: `PROFILE.md` → `profile`, `TOPIC.md` → `topic`,
anything else → `memory` (`packages/memory/src/paths.ts`).

### 3.2 Navigation block

`reindex` manages exactly one region per index file, delimited by
`<!-- reindex:begin -->` … `<!-- reindex:end -->` (`packages/memory/src/reindex.ts`), under a
`## Contents` heading (`packages/memory/src/reindex.ts`). An empty block renders
`_(no entries yet)_` (`packages/memory/src/reindex.ts`). Each entry is
`- [<childBasename>](<rel>) — <description>`, where `<rel>` is the child's path relative to the
index file's own directory (`packages/memory/src/reindex.ts`), with the ` — <description>` suffix omitted
when the target's description is blank (`packages/memory/src/reindex.ts`). The scaffolded body
for a newly created index file is `# <Title>` + intro + `## Contents` + links
(`packages/memory/src/reindex.ts`). Intro text is fixed per level: at the root, "Durable
workspace knowledge, organized by topic. Follow the links below to drill down."; elsewhere "Durable
knowledge about `<dir>`." (`packages/memory/src/reindex.ts`). The root profile's description is
the fixed constant `"Index of durable operational knowledge for this workspace"`
(`packages/memory/src/tree.ts`), and generated descriptions are capped at 120 characters
(`packages/memory/src/tree.ts`, `packages/memory/src/reindex.ts`).

### 3.3 On-disk layout — the content/machinery split

`createFileStoreLayout` derives two roots and one lock directory
(`packages/memory/src/file-store/layout.ts`):

| Path | Holds | Source |
| --- | --- | --- |
| `<root>/**/*.md` | the wiki, and nothing else | `packages/memory/src/file-store.ts` |
| `<machineryRoot>/.history/<doc path>/<rev>.md` | a revision's pre-image body | `packages/memory/src/file-store/revisions.ts` |
| `<machineryRoot>/.history/<doc path>/<rev>.json` | that revision's metadata | `packages/memory/src/file-store/revisions.ts` |
| `<machineryRoot>/.journal/<batch id>/prepare.json` | the batch's declared intent | `packages/memory/src/file-store/journal.ts` |
| `<machineryRoot>/.journal/<batch id>/applied` | zero-byte "all writes landed" marker | `packages/memory/src/file-store/journal.ts` |
| `<machineryRoot>/.journal/<batch id>/commit` | zero-byte "batch finished" marker | `packages/memory/src/file-store/journal.ts` |
| `<machineryRoot>/.state/indexed/<encoded run id>` | run-dedup ledger; content is the epoch ms as a string | `packages/memory/src/file-store/jobs.ts` |
| `<machineryRoot>/.state/jobs/<encoded run id>.json` | the durable index queue (**sibling document**) | `packages/memory/src/file-store/jobs.ts` |
| `<machineryRoot>/.lock/` + `.lock/holder` | the mkdir-based tree lock and its `<pid>.<random>` token | `packages/memory/src/file-store/layout.ts`, `packages/memory/src/file-store/lock.ts` |

Note the `.history` directory is *literally named after the document*: a directory called
`infra/bun/MEMORY.md` holding `<rev>.md` / `<rev>.json` pairs
(`packages/memory/src/file-store.ts`, `packages/memory/src/file-store/revisions.ts`).
Every machinery directory is dot-prefixed, and `walk` skips any entry whose name starts with `.`,
which is what keeps them out of `list`, `grep` and `version`
(`packages/memory/src/file-store/documents.ts`).

In the product the two roots are `workspacePaths(ws).memoryRoot` = `<ws>/.clarvis/memory`
(`packages/paths/src/workspace.ts`) and
`workspaceStatePaths(ws).memoryMachineryRoot` = `<global state>/workspaces/<segment>/memory`
(`packages/paths/src/workspace-state.ts`), wired together by the factory
(`packages/memory/src/factory.ts`) and, per owner, by the kernel
(`packages/kernel/src/owner-scoped-file-stores.ts`).

Permissions: directories `0o700`, files `0o600`, verified on disk
(`packages/memory/src/file-store/layout.ts`, `packages/memory/tests/integration/file-store.test.ts`).

### 3.4 Journal record

```ts
interface MemoryJournalRecord {
  version: number;        // JOURNAL_VERSION === 1
  batch_id: string;
  at: number;
  source: MemoryRevisionSource;
  ops: MemoryJournalOp[];
  commit: MemoryBatchCommit;   // { mark_indexed?: string }
}
```
(`packages/memory/src/journal.ts`.) Each op is
`{ op: "write"|"delete", path, expected_digest: string|null, next_digest: string|null,
revision_id: string|null, previous_body?: string }` (`packages/memory/src/journal.ts`).
`previous_body` carries the pre-image inline for an op that records **no** revision — a derived
(navigation-restitch) write — so rollback stays exact without polluting visible history
(`packages/memory/src/journal.ts`). A concrete record, as a test plants one:
`{version:1, batch_id:"b1", at:1_700_000_000_000, source:{kind:"indexer",run_id:"run-1"}, ops:[], commit:{}}`
(`packages/memory/tests/integration/journal-recovery.test.ts`).

### 3.5 Revision record

```ts
interface MemoryRevision {
  id; path; at; op: "write"|"delete";
  digest?;           // of the body this change INSTALLED; absent for a delete
  previous_digest?;  // of the stored pre-image
  bytes;             // byte length of the stored pre-image
  source: { kind:"indexer"; run_id } | { kind:"tool"; tool };
  batch_id;
  external_edit?;    // true when the replaced body ≠ what the previous revision installed
}
```
(`packages/memory/src/revisions.ts`.) The module header states the storage rule: a revision
records **the body a change replaced**, not the body it installed, which keeps one copy of every
superseded byte and makes a `delete` revision self-sufficient — its stored body *is* the deleted
document, "which is why there is no separate trash area" (`packages/memory/src/revisions.ts`).

### 3.6 Identifiers

| Identifier | Generation | Source |
| --- | --- | --- |
| Batch id | `${clock().toString(36)}-${randomBytes(6).toString("hex")}` | `packages/memory/src/file-store.ts` |
| Revision id | base-36 timestamp zero-padded to 9 chars + `-` + 4 random bytes hex, so lexicographic order matches chronological | `packages/memory/src/revisions.ts` |
| Ledger / job filename | `encodeRunId`: run id with non-`[A-Za-z0-9_-]` replaced by `_`, truncated to 48 chars, plus `-` and the first 12 hex of its sha256 | `packages/memory/src/file-store/jobs.ts` |
| Lock holder token | `${process.pid}.${Math.random().toString(36).slice(2)}` | `packages/memory/src/file-store/lock.ts` |
| `version()` token | sha256 over, per document in path order, `rel \0 size \0 bytes \0` | `packages/memory/src/file-store/documents.ts` |

`encodeRunId` is pinned to distinguish `a/b` from `a\b`
(`packages/memory/tests/integration/file-store-internals.test.ts`).

### 3.7 Storage limits (`MEMORY_STORAGE_LIMITS`)

| Key | Value | Source |
| --- | --- | --- |
| `documentBytes` | 2 MiB | `packages/memory/src/storage-limits.ts` |
| `revisionBodyBytes` | 2 MiB | `packages/memory/src/storage-limits.ts` |
| `metadataBytes` | 1 MiB | `packages/memory/src/storage-limits.ts` |
| `prefixBytes` | 64 KiB | `packages/memory/src/storage-limits.ts` |
| `scanEntries` | 10 000 | `packages/memory/src/storage-limits.ts` |
| `batchOperations` | 256 | `packages/memory/src/storage-limits.ts` |
| `corpusBytes` | 32 MiB | `packages/memory/src/storage-limits.ts` |

`MemoryStorageKind` is one of `document | revision body | metadata | corpus | entries | batch operations`
(`packages/memory/src/storage-limits.ts`).

### 3.8 History retention

`MEMORY_DEFAULTS.history` = `{ keep_revisions: 20, keep_days: 90, min_revisions: 3 }`
(`packages/memory/src/config.ts`). The comment states `min_revisions` is a floor that
outranks both other bounds (`packages/memory/src/config.ts`), and the prune predicate is
`index >= min_revisions && (index >= keep_revisions || revision.at < cutoff)`
(`packages/memory/src/file-store/revisions.ts`).

### 3.9 Search configuration

`DEFAULT_QUERY_CONFIG` = `{ limit: 5, maxLimit: 20, snippetChars: 400, snippetLines: 5,
maxDocuments: 1_000, maxCorpusBytes: 32 MiB, maxDocumentBytes: 512 KiB }`
(`packages/memory/src/query.ts`). BM25F field parameters:

| Field | weight `w` | length norm `b` |
| --- | --- | --- |
| `title` | 3.0 | 0.4 |
| `description` | 2.2 | 0.4 |
| `tags` | 2.0 | 0.3 |
| `path` | 1.4 | 0.3 |
| `body` | 1.0 | 0.75 |

(`packages/memory/src/text/bm25.ts`; saturation `K1 = 1.2`.)

Tokenizer caps: `DEFAULT_MIN_LENGTH = 2`, `QUERY_MAX_CHARS = 512`, `QUERY_MAX_TOKENS = 64`,
`DOC_MAX_CHARS = 200_000`, `DOC_MAX_TOKENS = 20_000`
(`packages/memory/src/text/tokenize.ts`). Grep caps: `GREP_LINE_MAX = 200`,
`GREP_WINDOW_OVERLAP = 64`, `GREP_QUERY_MAX_CHARS = 200`, `GREP_SCAN_MAX_LINES = 200_000`,
`GREP_SCAN_MAX_MS = 2_000`, `GREP_AMBIGUITY_MAX = 3`
(`packages/memory/src/text/grep.ts`).

### 3.10 Run digest

`RunDigest` = `{ commands, files_touched, errors, retries, steering, stats }`
(`packages/memory/src/digest.ts`). Fixed vocabularies: bash-family tool names are
`shell, bash, exec, execute, run_command, execute_command`
(`packages/memory/src/digest.ts`), and file-path argument keys are
`path, file_path, file, target, source, destination` (`packages/memory/src/digest.ts`). Field
truncations: command 300 chars, error 400, args excerpt 200 (500 for the retry signature), steering
400 (`packages/memory/src/digest.ts`). `renderDigest` emits
sections in priority order — Stats, Errors, User steering, Commands, Repeated identical calls, Files
touched — so truncation drops the least valuable content first
(`packages/memory/src/digest.ts`).

### 3.11 `WorkspaceState`

`captureWorkspaceState` runs `rev-parse --abbrev-ref HEAD`, `rev-parse HEAD` and
`status --porcelain` in parallel with a 1500 ms timeout, returning
`{ vcs: "git", branch, commit, dirty }` or `undefined`
(`packages/memory/src/workspace-state.ts`). Absence is a valid outcome, never an
error (`packages/memory/src/workspace-state.ts`).

---

## 4. Behavior

### 4.1 Path normalization

`normalizeMemoryPath` (`packages/memory/src/paths.ts`) runs, in order:

1. replace every `\` with `/`;
2. reject a leading `/` — "path must be relative";
3. `path.posix.normalize`, then reject `..`, `../…` and any absolute result — "path escapes the
   memory root";
4. reject anything not ending in `.md` — "only.md documents are allowed".

`compareMemoryPaths` compares by UTF-16 code unit and *deliberately not* `localeCompare`: the doc
comment states listing order is part of the port's contract because it drives the generated
navigation blocks, and must not vary with the host's locale
(`packages/memory/src/paths.ts`).

### 4.2 `createFileMemoryStore` wiring

`createFileMemoryStore` builds the layout, then five collaborators over it — revisions, jobs,
journal, documents, tree lock — and composes `tx` (documents + ledger), `unitOfWork`
(`tx` + revisions + jobs.tx + `batch`) and the returned store
(`packages/memory/src/file-store.ts`). Lazy `init()` is memoized per store instance
(`packages/memory/src/file-store/layout.ts`), pinned by a test that calls `init()` three times
concurrently (`packages/memory/tests/integration/file-store-internals.test.ts`).

`init()` performs the split-store safety check **before** creating anything:

1. `wikiVanished = split && !existsAsDirectory(root)` — evaluated first, so it observes the state the
   user left (`packages/memory/src/file-store/layout.ts`);
2. create `root` (via `ensureWorkspaceSubdir` when `workspaceRoot` is given, else `mkdir 0700`);
3. create `machineryRoot` when split;
4. if `wikiVanished`, best-effort `rm -rf` of `<machineryRoot>/.state/indexed` and
   `<machineryRoot>/.journal`.

`.history` is deliberately *not* in that discard list, and a test asserts it survives
(`packages/memory/tests/integration/file-store-internals.test.ts`).

The run-dedup ledger's two `MemoryTx` members are simple: `wasIndexed(runId)` stats the ledger marker
for that run id and returns whether it exists, defaulting to `false` on any stat failure;
`markIndexed(runId, at)` writes the marker unconditionally
(`packages/memory/src/file-store/jobs.ts`). Marking the same run id twice is safe — a
second `markIndexed` call is an ordinary overwrite, and `wasIndexed` reports `true` for that id
independent of every other id, pinned by "records a run in the ledger at most once"
(`packages/memory/src/testing.ts`).

### 4.3 `exclusive` and the tree lock

```
exclusive(fn):
  if treeLock.nested()  -> fn(unitOfWork)                     // no re-acquire
  else                  -> treeLock.run(async () => { await recovery.recoverOnce(); return fn(unitOfWork) })
```
(`packages/memory/src/file-store.ts`.)

Acquisition (`packages/memory/src/file-store/lock.ts`):

| Step | Effect |
| --- | --- |
| `mkdir(lockDir, {mode:0o700})` | exclusive create; `EEXIST` means contention |
| write `holder` = `<pid>.<rand>` | on failure, best-effort remove the lock dir and rethrow |
| on `EEXIST`: `stealable()` | true only when the dir's mtime is older than `staleMs`, the recorded pid is not alive, **and** a second `stat` still shows it stale |
| steal | best-effort `rm -rf` |
| deadline check | past `timeoutMs`, throw `memory: timed out waiting for tree lock <dir>` |
| back-off | `setTimeout(…, 25)` between attempts |
| heartbeat | `setInterval(utimes(lockDir))` every `heartbeatMs`, `unref`'d |
| release | `clearInterval`, then remove the dir **only if `holder` still holds this token** |

`holderAlive` treats `process.kill(pid, 0)` throwing `EPERM` as alive
(`packages/memory/src/file-store/lock.ts`). Nesting is tracked with an `AsyncLocalStorage`; a nested hold takes `NO_RELEASE`, whose comment states why: `mkdir` would fail
`EEXIST` against the caller's own hold and the wait would run to its timeout
(`packages/memory/src/file-store/lock.ts`).

Every hold whose duration exceeds `warnMs` logs `memory.lock.held_long` with `nested`, `held_ms`,
`threshold_ms` and `lock_dir` (`packages/memory/src/file-store/lock.ts`). The constant's
doc comment names the rule it enforces: "never start an index pass from inside `store.exclusive`" —
the lock is re-entrant, so breaking that rule does not deadlock, it silently holds the tree for a
whole inference (`packages/memory/src/file-store/lock.ts`).

### 4.4 `runBatch` — the ordered mutation sequence

The order is called out as load-bearing in the function's own doc comment
(`packages/memory/src/batch.ts`), and the implementation runs:

| # | Step | Code |
| --- | --- | --- |
| 0 | `recovery.assertWritable()` — refuse if a batch is blocked | `packages/memory/src/file-store.ts` |
| 1 | run `fn(handle)`, staging only; the tree is untouched | `packages/memory/src/batch.ts` |
| 1a | if nothing staged: run `commit` and return — no journal | `packages/memory/src/batch.ts` |
| 2 | for each staged op in path order: read the current body, compute `expected`/`next` digests, drop no-op writes and deletes of absent documents, mint a revision when eligible | `packages/memory/src/batch.ts` |
| 2a | if every op collapsed: run `commit` and return | `packages/memory/src/batch.ts` |
| 3 | validate the serialized record against `metadataBytes` **before** the first revision byte is persisted | `packages/memory/src/batch.ts` |
| 4 | `putRevision` each revision (body first, metadata second) | `packages/memory/src/batch.ts`, `packages/memory/src/file-store/revisions.ts` |
| 5 | `writeJournal(record)` — intent is now durable | `packages/memory/src/batch.ts` |
| 6 | apply every op to the tree | `packages/memory/src/batch.ts` |
| 7 | `markApplied` — past this point recovery rolls *forward* | `packages/memory/src/batch.ts` |
| 8 | `runCommit(record.commit)` | `packages/memory/src/batch.ts` |
| 9 | `markCommitted`, then `sweepJournal` | `packages/memory/src/batch.ts` |
| 10 | `pruneHistory` for the touched paths | `packages/memory/src/batch.ts` |

A revision is minted only when `!op.derived && before !== null && expected !== null` — i.e. never for
a first creation and never for a derived navigation write
(`packages/memory/src/batch.ts`). `external_edit: true` is set exactly when
`lastInstalledDigest(path)` is defined and differs from the current body's digest
(`packages/memory/src/batch.ts`). When no revision is recorded but a prior body existed, that
body rides inline as `previous_body` on the journal op (`packages/memory/src/batch.ts`).

The staged handle merges its own state into reads and listings: `read` returns the staged content
(or `null` for a staged delete) before touching the tree (`packages/memory/src/batch.ts`),
and `list` overlays staged creations and removes staged deletions
(`packages/memory/src/batch.ts`). The doc comment states why: the deterministic reindex
runs inside the batch and lists the tree to decide what to link, so a leaf staged moments earlier
would otherwise never be wired into navigation (`packages/memory/src/batch.ts`).

`reindexView(bx)` wraps a batch so every write it makes is `{ derived: true }`
(`packages/memory/src/batch.ts`); `tools.ts` is its only production caller
(`packages/memory/src/tools.ts` — sibling document).

### 4.5 Recovery — the state machine

`decideRecovery` (`packages/memory/src/journal.ts`) is pure. Read as (marker state, tree state) →
(outcome, effect):

| Condition (checked in this order) | Outcome | Effect at `packages/memory/src/file-store/recovery.ts` |
| --- | --- | --- |
| `record.version > JOURNAL_VERSION` | `required` — "journal written by a newer version (N)" | freeze; entry retained |
| `markers.committed` | `swept` | journal dir removed |
| `markers.applied` | `rolled_forward` | `runCommit(record.commit)` then sweep |
| any op's current digest ∉ {`expected_digest`, `next_digest`} | `required` — "`<path>` was modified outside the store while a batch was interrupted" | freeze; the human's bytes untouched |
| an op off its expected digest with `expected_digest !== null`, `revision_id === null` and no `previous_body` | `required` — "`<path>` has no stored pre-image to restore" | freeze; the generic required handler at `packages/memory/src/file-store/recovery.ts`, reason string produced at `packages/memory/src/journal.ts` |
| otherwise | `rolled_back` | restore each off-expected op (delete when `expected_digest === null`, else write the pre-image) then sweep |

The relaxation in the fourth row is deliberate and documented: accepting the *next* digest as well as
the expected one is "deliberately weaker than 'everything still matches expected' — which would be a
no-op precisely in the mid-apply case recovery exists for" (`packages/memory/src/journal.ts`).
That case is pinned by name — "rolls back mid-apply, which is the case it exists for"
(`packages/memory/tests/unit/journal-recovery.test.ts`).

Rollback additionally re-verifies each restored body: if the retrieved pre-image is `null` or its
digest does not equal `expected_digest`, the batch becomes `required` with
"`<path>` has no valid bounded pre-image to restore" and **no** partial restoration is applied,
because the whole restoration list is built before any write happens
(`packages/memory/src/file-store/recovery.ts`).

Around that, the coordinator adds three tolerances of its own (all `MemoryStorageLimitError`-only;
anything else rethrows):

- a journal scan over the entry budget → one synthetic entry `batch_id: "<journal-scan>"`,
  `required: true` (`packages/memory/src/file-store/recovery.ts`);
- an over-limit journal record → `required`, record retained as evidence, pinned at
  `packages/memory/tests/integration/storage-limits.test.ts`;
- an unreadable (oversized) tree document → `required`.

An **unparsable or absent** `prepare.json` reads as `null` and the batch is swept
(`packages/memory/src/file-store/recovery.ts`), pinned by "a journal that never landed
leaves nothing to undo" (`packages/memory/tests/integration/journal-recovery.test.ts`).

`recoverOnce` sets its `recovered` flag *before* awaiting, so two concurrent callers produce one pass
(`packages/memory/src/file-store/recovery.ts`), pinned at
`packages/memory/tests/integration/file-store-internals.test.ts`. `blocked` is sticky for the
lifetime of the store instance, and `assertWritable` throws `MemoryRecoveryRequiredError` from it.

### 4.6 `planReindex` / `reindex`

`planReindex` (`packages/memory/src/reindex.ts`):

1. `list()` the tree, `analyze()` it into a `TreeShape` (paths, descriptions, directory hierarchy
   including intermediate directories that hold no file of their own)
   (`packages/memory/src/tree.ts`);
2. collect `dirsNeedingIndex` = the root plus every directory with at least one child directory
   (`packages/memory/src/reindex.ts`);
3. pre-compute each one's derived description and write it back into the shape, so later links read
   the upgraded value;
4. per directory: build the link list from its sorted immediate children, each linked through
   `selfFileFor` (`packages/memory/src/tree.ts`) — a directory with subdirectories links its
   `TOPIC.md`, otherwise its `MEMORY.md` if present, else `TOPIC.md`;
5. read the index file. If absent, scaffold it whole. If present but its frontmatter
   block is unclosed, **skip the directory entirely** and log
   `memory.document.skipped { reason: "open_frontmatter" }`;
6. otherwise rewrite in three composed passes — `writeContents`, then `ensureIntro`, then
   `ensureDescription`;
7. emit a `ReindexChange` only when the result actually differs.

`planReindex` is bound by the same storage-limit machinery as an ordinary batch: its `charge()`
helper throws `MemoryStorageLimitError` for an index file's current or next body exceeding
`documentBytes`, or for the pass's running corpus total exceeding `corpusBytes`
(`packages/memory/src/reindex.ts`), and the emitted change
list is itself charged against `batchOperations` via `assertMemoryStorageCount("batch operations",
"reindex", changes.length + 1, …)` — a pass needing more than 256 index-file
rewrites throws.

`ensureDescription`'s own doc comment states it also "repairs the blank description emitted by the
first wiki implementation" (`packages/memory/src/reindex.ts`), and `ensureIntro` likewise
"upgrade[s] the old empty scaffold (`# title` immediately followed by `## Contents`) without
disturbing a human-written introduction" — both are a permanent migration path for
that earlier implementation's own defects, not purely forward-looking scaffolding.

`writeContents` prefers an existing `reindex:begin`/`end` block; failing that, fills an existing
`## Contents` heading up to the next `##`; failing that, appends a new `## Contents` section at the
end (`packages/memory/src/reindex.ts`). Prose outside the managed region is never touched
— pinned by "preserves prose outside the managed block and refreshes links on a new leaf"
(`packages/memory/tests/integration/reindex.test.ts`).

`derivedDescription` (`packages/memory/src/reindex.ts`) only descends into a directory whose
current description is a *generated placeholder* — blank, the bare directory name, or exactly the
synthesized default (`packages/memory/src/tree.ts`). A hand-written description wins and
stops the recursion. One child → inherit its description; several → `"<Title>: a; b; c"`, capped. The comparison is by exact (case-insensitive, trimmed) string match, so a human who
types a description that happens to coincide with one of those three shapes is treated identically to
one who never wrote a description at all — `isGeneratedPlaceholder` has no way to tell the two apart
(`packages/memory/src/tree.ts`).

`reindex` is `planReindex` followed by a write of each change
(`packages/memory/src/reindex.ts`). It is stateless — no checksum, no cache — which is
what lets hand edits survive as long as the frontmatter `description:` is present
(`packages/memory/src/reindex.ts`), pinned as idempotent at
`packages/memory/tests/integration/reindex.test.ts`.

`health` reuses `planReindex` to detect stale navigation
(`packages/memory/src/health.ts`), which the reindex module's own header names as the reason for
the plan/apply split (`packages/memory/src/reindex.ts`).

### 4.7 Document repository reads and scans

`walk()` is an explicit stack DFS with a shared entry budget: each directory is scanned with the
*remaining* budget, and the loop breaks on the first truncated scan
(`packages/memory/src/file-store/documents.ts`). The comment explains the zero-remainder
case: passing a zero remainder still lets `scanDirectoryBounded` perform one look-ahead, so an empty
pending subtree completes without a false positive while its first real entry proves the catalog
incomplete. Both halves are pinned — "an exact document scan boundary drains an empty
pending subtree" (`packages/memory/tests/integration/storage-limits.test.ts`) and "list and grep
reject a non-empty subtree beyond the exact scan boundary".

Per operation:

- `read` → strict bounded read: an oversized on-disk document **throws** rather than reading as
  absent (`packages/memory/src/file-store/documents.ts`, `packages/memory/src/types.ts`);
- `readBounded(rel, maxBytes)` → prefix + `truncated` flag, clamped to `documentBytes`
  (`packages/memory/src/file-store/documents.ts`);
- `write` → refuse over `documentBytes`, then `writeFileAtomic` (temp sibling + rename)
  (`packages/paths/src/atomic.ts`);
- `delete` → returns a **boolean**, not `void`: `true` when the document existed and was removed,
  `false` on `ENOENT`; any other error rethrows (`packages/memory/src/file-store/documents.ts`). `MemoryBatch.delete` on the staged handle mirrors this, computing `existed` from the
  merged staged+tree read before staging the delete (`packages/memory/src/batch.ts`);
- `list` → per document read only the first `prefixBytes`, charge the corpus budget, stat for
  `mtimeMs` (falling back to the injected clock when the stat fails), parse frontmatter;
- `grep` → open each file, skip anything not a regular file or over `documentBytes`, stream lines
  through the shared `GrepScanner`, stopping at `limit` or when the scanner's budget is spent;
- `version` → sha256 over `rel \0 size \0 content \0` per document, with a post-read re-`stat` that
  throws "memory: file changed while it was being hashed" on a size or byte-count mismatch. An `ENOENT` mid-hash contributes zero bytes rather than failing.

The `.md`-only, non-dot, non-tmp filter lives in one place and is pinned by "list
ignores the lock dir, the ledger, dot-files and non-markdown files"
(`packages/memory/tests/integration/file-store.test.ts`).

### 4.8 Bounded I/O

`readUtf8FileBounded` (`packages/memory/src/bounded-io.ts`) opens a descriptor, stats it, refuses
a non-regular file, refuses an oversized read *before allocating* unless `truncate` is set, allocates
`min(size, max) + 1` bytes (the extra byte is the growth probe), reads, re-stats, and distinguishes
three outcomes: over-limit → `MemoryStorageLimitError`; changed but within limit → "memory: file
changed while it was being read"; otherwise the bounded text with a `truncated` flag. The one-byte probe is pinned by "descriptor-backed reads detect growth after stat
without following it" (`packages/memory/tests/integration/storage-limits.test.ts`), which uses
the `afterStat` injection seam (`packages/memory/src/bounded-io.ts`).

`scanDirectoryBounded` returns `{inspected, truncated}` where `inspected` counts one past
the budget when truncation occurred, treats a missing directory as an empty scan, and tolerates Bun
deferring `ENOENT` from `opendir` to the first iterator read. A visitor
returning `false` stops the scan. The off-by-one look-ahead is pinned exactly:
`scanDirectoryBounded(root, 3, …)` over five entries yields `{inspected: 4, truncated: true}` with
three visits (`packages/memory/tests/integration/storage-limits.test.ts`).

### 4.9 Ranked query

`queryMemory` (`packages/memory/src/query.ts`):

1. clamp every configuration knob against `MEMORY_STORAGE_LIMITS`;
2. tokenize the query under the query caps;
3. `list()`, filter by `prefix` and `kinds`, slice to `maxDocuments`, recording a `documents`
   truncation reason if anything was dropped;
4. if no terms survive, return **no hits** rather than everything — the doc comment: "'the of and' is
   not a request for the whole wiki";
5. per document, read through `readBounded` when the adapter offers it, else `read` + `capUtf8`;
   accumulate the corpus budget and `break` when it would be exceeded;
6. build per-field term counts for `title` (from `extractTitle` over the parsed body, scanning only
   the first `TITLE_SCAN_LINES = 20` lines for an ATX `#` heading before falling back to the
   humanized directory name — `packages/memory/src/tree.ts`), `description`,
   `tags`, `path` (with `/` and `.` replaced by spaces) and `body`;
7. `buildStats` then `scoreDoc`, multiply by `metadataBoost`, drop zero scores.
   A document's authority defaults to `"observed"` when its frontmatter carries none
   (`authority: parsed.frontmatter.authority ?? "observed"`, `packages/memory/src/query.ts`),
   which feeds both `metadataBoost`'s neutral case and the `authorityRank` tie-break;
8. sort by score rounded to 4 decimals, then pinned, then authority rank, then `updated_at`
   descending, then kind rank (detail leaf over compilation), then path;
9. take `limit`, attach the best snippet unless `include_snippets === false`.

`scoreDoc` (`packages/memory/src/text/bm25.ts`) pools a term's frequency **across every field
before saturation**, rather than scoring each field and summing: for each query term it accumulates
`(w * tf) / (1 - b + b * len/avgLen)` over all five fields into one `pooled` value, then applies the
BM25 saturation `pooled / (K1 + pooled)` once. The doc comment states why: summing
per-field scores would let a term repeated many times in a short field (e.g. `tags`) out-score a
document matching strongly across title, description and body together. `idf` uses a
`1 + …` form specifically to stay positive when a term appears in more than half the corpus — the
textbook formula goes negative there, which the doc comment calls "nonsense" for a small wiki where
the workspace's own name appears on most pages.

`metadataBoost` is multiplicative and clamped to `[0.8, 1.25]` (`packages/memory/src/query.ts`). Its doc comment names two consequences and both are tested: a non-matching document
scores zero and zero times any multiplier is still zero
(`packages/memory/tests/component/query.test.ts`), and a document wins on metadata alone only
when its lexical score is at least `BOOST_MIN / BOOST_MAX` = 64 % of its rival's
(`packages/memory/tests/component/query.test.ts`).

`bestSnippet` picks the window of up to `snippetLines` consecutive lines containing the most distinct
query terms, prefixing `…` when the window does not start at the first line
(`packages/memory/src/query.ts`), pinned by "excerpts the part of the body that matched,
not the opening" (`packages/memory/tests/component/query.test.ts`).

### 4.10 Tokenization and grep bounding

`normalizeForTokens` is: slice to `maxChars`, NFKC, `toLowerCase`, NFD, strip Latin combining marks,
NFC (`packages/memory/src/text/tokenize.ts`). The mark-stripping regex uses a lookbehind
so only marks sitting on an ASCII letter or digit are removed — the comment states that stripping
every `\p{M}` would destroy scripts where marks are phonemic
(`packages/memory/src/text/tokenize.ts`). `\p{M}` is *in* the token class so a decomposed
dotted `i` stays one token, pinned at
`packages/memory/tests/unit/tokenize.test.ts`. Stopwords are stored already folded (`nao`, `sao`,
`ja`) because the pipeline folds before lookup (`packages/memory/src/text/tokenize.ts`),
pinned at `packages/memory/tests/unit/tokenize.test.ts`.

`createGrepScanner` (`packages/memory/src/text/grep.ts`) compiles a regex only when all three of
`opts.regex === true`, `query.length <= GREP_QUERY_MAX_CHARS` and `isBoundedPattern(query)` hold, and
falls back to the keyword path on any compile failure. The keyword path matches when
the line shares at least one significant token with the query; a query that tokenizes to nothing
never matches. `ok()` is false once `GREP_SCAN_MAX_LINES` lines have been tested or
`GREP_SCAN_MAX_MS` of the injected clock has elapsed.

`isBoundedPattern` (`packages/memory/src/text/grep.ts`) is a single left-to-right syntactic pass
refusing four families:

| Family | Example | Rejection site |
| --- | --- | --- |
| quantifier applied to a group | `(a+)+$`, `(a\|a)*$`, `(?:a*)*b` | (`prev === "close"`) |
| backreference | `\1`…`\9`, `\k<name>` | `packages/memory/src/text/grep.ts` |
| lookaround (four forms) | `(?=`, `(?!`, `(?<=`, `(?<!` | `packages/memory/src/text/grep.ts` |
| more than `GREP_AMBIGUITY_MAX` markers | a 4th of `* + ? { \|` | `packages/memory/src/text/grep.ts` |

`(?<name>` is read as a named group and admitted (pinned at
`packages/memory/tests/unit/tokenize.test.ts`); `?` immediately after `(` is a group modifier and
is not counted; metacharacters inside `[…]` or behind a backslash are literals.

`matchWindowed` tests a line up to one window whole; longer lines are walked in
`GREP_LINE_MAX`-wide windows stepping by `GREP_LINE_MAX - GREP_WINDOW_OVERLAP`, checking the budget
predicate after each window and reporting a **false negative** when it fires. The doc comment names
the precision cost explicitly: each window is its own string, so `^`/`$` anchor to the window and an
anchored pattern can over-report at a boundary the line does not have.

### 4.11 The `Memory` facade over the store

`createMemory` (`packages/memory/src/memory.ts`) composes the store into the host-facing facade.
The store-relevant members:

| Member | Behaviour | Source |
| --- | --- | --- |
| `reindex(tx?)` | uses the supplied transaction directly, or wraps `reindexTree` in `store.exclusive` when omitted | `packages/memory/src/memory-contract.ts`, `packages/memory/src/memory.ts` |
| `review()` | one `store.list()` into `reviewDigest` (totals by kind, 10 most recent, undescribed paths) | `packages/memory/src/memory.ts`, `packages/memory/src/review.ts` |
| `query(input)` | `queryMemory({tx: store, input})` — no config override | `packages/memory/src/memory.ts` |
| `store` | the injected port, re-exposed verbatim | `packages/memory/src/memory.ts` |

`createFileMemory` is the convenience composition over `createFileMemoryStore`, accepting either a
`MemoryClock` or a bare `() => number` and adapting it for both the durable timestamps and the live
lease timing (`packages/memory/src/memory.ts`), pinned by "uses one injected clock for
durable queue timestamps and live lease timing"
(`packages/memory/tests/integration/memory.test.ts`).

`createMemory` also constructs one `admitBlocked` rate limiter for the life of the `Memory` instance,
beside `owner`, rather than one per `drain()` call — its doc comment states why: a job the drain
reports `blocked` stays `pending` and is due again on the very next tick for the same reason, so the
suppression only means anything if the state deciding it outlives the pass
(`packages/memory/src/memory.ts`). The rate limiter itself is consumed by `drainIndexJobs`,
which is the sibling *memory-indexer-and-jobs* document's.

### 4.12 The store conformance table

`memoryStoreConformance()` returns 31 cases as **data** rather than `describe`/`test` calls,
asserting through `node:assert/strict`, so an adapter in another package or runner can drive them
(`packages/memory/src/testing.ts`). A case needing a capability the harness lacks
(`poke`) returns early rather than failing. The harness contract is
`{ store, poke?, cleanup }` (`packages/memory/src/testing.ts`). A 32nd case asserted rollback on
"an adapter that declares itself atomic", gated on an `atomic` harness flag no driver ever set; both
it and the flag are gone, because neither shipped adapter rolls back and none was ever going to —
`packages/memory/src/file-store.ts` states "exclusion only, not rollback".

`packages/memory/tests/contract/store.test.ts` drives every case against both shipped backends:
the file store over a fresh temp root (with `poke` writing straight to disk) and the in-memory store
(with `poke` writing through the store itself).

Case groups:

| Group | Source | Owner |
| --- | --- | --- |
| documents, keys, listing, grep | `packages/memory/src/testing.ts` | this document |
| exclusive-section serialization and visibility | `packages/memory/src/testing.ts` | this document |
| the indexed ledger | `packages/memory/src/testing.ts` | this document |
| the durable job queue | `packages/memory/src/testing.ts` | **memory-indexer-and-jobs** |
| `version()` | `packages/memory/src/testing.ts` | this document |
| out-of-band edits, batches, revisions, recovery | `packages/memory/src/testing.ts` | this document |

---

## 5. Invariants

Each rule below carries its production site and the test that pins it, or `unpinned`.

**MS-01 (INV-120).** A document key that traverses out of the tree (`../escape.md`), is absolute
(`/etc/passwd.md`), or is not `.md` (`a/b.txt`) is rejected with a `MemoryPathError` whose `code` is
`memory_path_invalid`.
Production: `packages/memory/src/paths.ts`.
Test: `packages/memory/src/testing.ts`, driven at `packages/memory/tests/contract/store.test.ts`
against both backends.

**MS-02 (INV-121).** `./infra/bun/MEMORY.md`, `infra//bun/MEMORY.md` and `infra\bun\MEMORY.md` all
address one document, and the tree lists exactly one entry for them.
Production: `packages/memory/src/paths.ts`.
Test: `packages/memory/src/testing.ts`.

**MS-03 (INV-122).** Two concurrent `store.exclusive()` sections never interleave — one's `end`
immediately precedes the other's completion — and a write made through the exclusive handle is
visible on the plain store afterwards.
Production: `packages/memory/src/file-store.ts` over `packages/memory/src/file-store/lock.ts`;
in-memory equivalent at `packages/memory/src/testing.ts`.
Test: `packages/memory/src/testing.ts`.

**MS-04 (INV-132).** `version()` is stable across repeated reads with no writes, changes on any
document write or delete, and returns to its original empty-tree value once every document is
deleted.
Production: `packages/memory/src/file-store/documents.ts`.
Test: `packages/memory/src/testing.ts`.

**MS-05 (INV-133).** A batch is all-or-nothing: a throw inside the body leaves no write applied and
`version()` unchanged; staged writes *are* visible to reads made inside the same batch before it
commits.
Production: `packages/memory/src/batch.ts` (nothing is applied until step 6), staging
reads.
Test: `packages/memory/src/testing.ts`.

**MS-06 (INV-134).** Replacing a document records exactly one revision, carrying `previous_digest`,
`digest` and the tool provenance; the *first* creation of a document records **no** revision.
Production: `packages/memory/src/batch.ts`.
Test: `packages/memory/src/testing.ts`.

**MS-07 (INV-135).** Revision history is ordered newest-first, and a deleted document's prior body is
kept as a reversible revision whose own record carries no `digest`.
Production: `packages/memory/src/revisions.ts`, `packages/memory/src/batch.ts` (`digest`
omitted when `next === null`), `packages/memory/src/file-store/revisions.ts`.
Test: `packages/memory/src/testing.ts`.

**MS-08 (INV-136).** A revision whose predecessor content was hand-edited outside the store carries
`external_edit: true`; one made through the normal path does not.
Production: `packages/memory/src/batch.ts`.
Test: `packages/memory/src/testing.ts` (requires the harness's `poke`).

**MS-09 (INV-137).** A batch's declared `commit` work runs even when the batch body stages nothing.
Production: `packages/memory/src/batch.ts` and the second early return.
Test: `packages/memory/src/testing.ts`.

**MS-10 (INV-138).** `recover()` reports `required: false` on an untouched tree and is idempotent — a
second call reports the identical report.
Production: `packages/memory/src/file-store/recovery.ts` (an empty `listBatchIds` yields no
entries) and the sweep.
Test: `packages/memory/src/testing.ts`; the file-backed variant at
`packages/memory/tests/integration/journal-recovery.test.ts`.

**MS-12 (INV-140).** A split store puts only markdown in the working tree: after driving a batch
write, a second revision and `markIndexed`, `<ws>/.clarvis/memory` contains only `.md` files and
`<ws>/.clarvis` only `.gitignore` plus `.md`, while `.history`, `.state`, `.journal` and the lock land
under the machinery root.
Production: `packages/memory/src/file-store/layout.ts` (every machinery path is derived from
`machineryRoot`).
Test: `packages/memory/tests/integration/machinery-split.test.ts`, ("a document
still round-trips, and its revisions are readable" — ordinary read/write and `revisions.list`/`read`
work end-to-end across a split root, including across two sequential batches to the same path); the
kernel-side equivalent at `packages/kernel/tests/architecture/workspace-surface.test.ts`.

**MS-13 (INV-141).** Omitting `machineryRoot` defaults it to `root`, keeping a self-contained tree.
Production: `packages/memory/src/file-store/layout.ts`.
Test: `packages/memory/tests/integration/machinery-split.test.ts`.

**MS-14 (INV-142).** Deleting the wiki directory out from under a split store clears the indexed
ledger on the next open, so learning resumes; finding the wiki merely *empty* does not.
Production: `packages/memory/src/file-store/layout.ts` (the existence probe runs before the
directory is recreated).
Test: `packages/memory/tests/integration/machinery-split.test.ts`.

**MS-15 (INV-143).** A prepared-but-uncommitted journal entry is never replayed into a wiki the user
has since deleted; reopening clears the stale journal instead.
Production: `packages/memory/src/file-store/layout.ts` (the discard covers `.journal` as well
as `.state/indexed`).
Test: `packages/memory/tests/integration/machinery-split.test.ts`.

**MS-16 (INV-144).** An unsplit store is exempt from MS-14/MS-15: its ledger dies with its tree
anyway, because there is no separate machinery root to diverge from it.
Production: `packages/memory/src/file-store/layout.ts` (`split` is false, so the discard never
runs).
Test: `packages/memory/tests/integration/machinery-split.test.ts`.

**MS-17 (INV-093).** The package facade re-exports `createFileMemoryStore` **by identity** and exposes
neither `createJobRepository` nor `createTreeLock`.
Production: `packages/memory/src/index.ts`.
Test: `packages/memory/tests/architecture/file-store-exports.test.ts`.

**MS-18.** The run-dedup ledger never appears in the document listing.
Production: `packages/memory/src/file-store/jobs.ts` (it lives under `.state/`) and
`packages/memory/src/file-store/documents.ts` (dot-prefixed entries are skipped).
Test: `packages/memory/src/testing.ts`; the file-specific form at
`packages/memory/tests/integration/file-store.test.ts`.

**MS-19.** `.history` and `.journal` are invisible to `list`, `grep` and `version` even after real
tool writes have populated them, but a write still moves `version()`.
Production: `packages/memory/src/file-store/documents.ts`.
Test: `packages/memory/tests/integration/journal-recovery.test.ts`.

**MS-20.** Documents are written atomically (temp sibling + rename), directories `0700`, files
`0600`, and no `.clarvis-tmp-*` file survives a write.
Production: `packages/memory/src/file-store/documents.ts` →
`packages/paths/src/atomic.ts`; directory mode at `packages/memory/src/file-store/layout.ts`.
Test: `packages/memory/tests/integration/file-store.test.ts`.

**MS-21.** Journal records, markers and revision metadata are written with `writeFileDurable`
(fsync-of-payload + fsync-of-directory), not the ordinary atomic write.
Production: `packages/memory/src/file-store/journal.ts`;
`packages/memory/src/file-store/revisions.ts`;
`packages/memory/src/file-store/jobs.ts`. The durability distinction is stated at
`packages/paths/src/atomic.ts`.
Test: unpinned as such — no test asserts the `fsync`; the *ordering* consequence is pinned instead
(MS-22).

**MS-22.** A revision's metadata `.json` is the commit point: a `<rev>.md` body with no matching
`.json` is invisible to both `revisions.list` and `revisions.read`.
Production: `packages/memory/src/file-store/revisions.ts` (only `.json` entries are collected) (a `read` first requires the id to appear in `list`).
Test: `packages/memory/tests/integration/journal-recovery.test.ts`;
`packages/memory/tests/integration/file-store-internals.test.ts` adds the mirror case — a `.json`
whose body is missing is listed but reads `null`.

**MS-23.** A tree lock is stolen only when the lock directory's mtime is older than `staleMs`, the
recorded holder pid is not alive, and a re-`stat` still shows it stale; a lock held by a *live* pid
that stopped heartbeating is waited for and then times out rather than being stolen or spun on.
Production: `packages/memory/src/file-store/lock.ts`.
Test: `packages/memory/tests/integration/file-store.test.ts` (steal) (live holder times
out) (each attempt sleeps 25 ms, so reaching a 200 ms deadline cannot be instant).

**MS-24.** A lock is released only by the holder that owns the current token.
Production: `packages/memory/src/file-store/lock.ts`.
Test: unpinned.

**MS-25.** A hold longer than `warnMs` logs `memory.lock.held_long`, and a nested hold is reported as
`nested: true` so a re-entrant caller is not read as a slow one. `DEFAULT_LOCK_WARN_MS` is 5 000 ms.
Production: `packages/memory/src/file-store/lock.ts`.
Test: `packages/memory/tests/integration/file-store-observability.test.ts`.

**MS-26.** An interrupted batch recovered on open is reported once, as a `warn`, with counts and —
when the tree is frozen — the blocking batch id. A clean tree reports nothing.
Production: `packages/memory/src/file-store/recovery.ts`, called only from `recoverOnce`.
Test: `packages/memory/tests/integration/file-store-observability.test.ts`.

**MS-27.** While a batch is blocked, reads keep working and only mutation is refused, with
`MemoryRecoveryRequiredError` (message contains "recovery required").
Production: `packages/memory/src/journal.ts`,
`packages/memory/src/file-store/recovery.ts`, gate at `packages/memory/src/file-store.ts`.
Test: `packages/memory/tests/integration/journal-recovery.test.ts` (reads and `list` still work;
`write_memory` returns `isError` with "recovery required").

**MS-28.** Recovery never overwrites bytes a human wrote: a touched path sitting at a third digest
yields `required`, not a rollback.
Production: `packages/memory/src/journal.ts`.
Test: `packages/memory/tests/unit/journal-recovery.test.ts`;
`packages/memory/tests/integration/journal-recovery.test.ts` asserts the bytes survive.

**MS-29.** A journal record whose `version` exceeds `JOURNAL_VERSION` is never acted on.
Production: `packages/memory/src/journal.ts`.
Test: `packages/memory/tests/unit/journal-recovery.test.ts`;
`packages/memory/tests/integration/file-store-internals.test.ts`.

**MS-30.** A batch past its `applied` marker rolls forward and replays its declared commit work,
rather than discarding a good result.
Production: `packages/memory/src/journal.ts`, `packages/memory/src/file-store/recovery.ts`.
Test: `packages/memory/tests/unit/journal-recovery.test.ts`;
`packages/memory/tests/integration/journal-recovery.test.ts`.

**MS-31.** A rollback op with no recoverable pre-image (`expected_digest !== null`,
`revision_id === null`, no `previous_body`) yields `required`, and a derived op whose pre-image rides
inline in the journal is accepted.
Production: `packages/memory/src/journal.ts`.
Test: `packages/memory/tests/unit/journal-recovery.test.ts`.

**MS-32.** An unreadable or absent `prepare.json` is swept, not treated as a fatal condition.
Production: `packages/memory/src/file-store/journal.ts` (JSON parse failure and shape
mismatch both return `null`), `packages/memory/src/file-store/recovery.ts`.
Test: `packages/memory/tests/integration/journal-recovery.test.ts`.

**MS-33.** A journal record that is *valid but oversized* — over `metadataBytes` or over
`batchOperations` — is retained as operator-visible evidence and freezes recovery, rather than being
swept as corrupt.
Production: `packages/memory/src/file-store/journal.ts` (the comment states the intent
verbatim), `packages/memory/src/file-store/recovery.ts`.
Test: `packages/memory/tests/integration/storage-limits.test.ts`.

**MS-34.** An oversized on-disk document is reported explicitly on a direct read; `grep` skips it
outright, while `list` truncates it to a `prefixBytes` read instead of skipping it. It is never
mistaken for absence.
Production: `packages/memory/src/bounded-io.ts`, `packages/memory/src/types.ts`,
`packages/memory/src/file-store/documents.ts` (grep) (list).
Test: `packages/memory/tests/integration/storage-limits.test.ts` (asserts `grep` resolves `[]` and
`list` resolves length 1 for the same oversized document).

**MS-35.** A batch cannot delete an out-of-band oversized document, and the refusal happens before
any journal directory is created.
Production: `packages/memory/src/batch.ts` (`delete` reads first).
Test: `packages/memory/tests/integration/storage-limits.test.ts`.

**MS-36.** An oversized document write is refused before the file is created or replaced.
Production: `packages/memory/src/file-store/documents.ts` (the assertion precedes
`writeFileAtomic`).
Test: `packages/memory/tests/integration/storage-limits.test.ts`.

**MS-37.** Batch cardinality (`batchOperations`) and the batch's aggregate body budget
(`corpusBytes`) both fail while every write is still staged, so the tree is untouched. The
`batchOperations` budget is charged per **distinct staged path** (`if (!staged.has(key))`), not per
write/delete call: a batch may call `write()` on the same path an unbounded number of times without
tripping the 256-operation ceiling, while touching 257 distinct paths trips it on the first write to
the 257th path.
Production: `packages/memory/src/batch.ts` (checked in `handle.write`, before step 4), (`handle.delete`'s identical guard).
Test: `packages/memory/tests/integration/storage-limits.test.ts` — both exercise 257
distinct paths; the same-key-repeated case is untested.

**MS-38.** A directory scan proves truncation with exactly one look-ahead entry, so an empty pending
subtree does not produce a false positive while its first real entry does.
Production: `packages/memory/src/bounded-io.ts`,
`packages/memory/src/file-store/documents.ts`.
Test: `packages/memory/tests/integration/storage-limits.test.ts`.

**MS-39.** `list`, `grep` and `version` all reject a catalog past the entry or corpus budget with the
same typed error, rather than silently searching a prefix.
Production: `packages/memory/src/file-store/documents.ts`.
Test: `packages/memory/tests/integration/storage-limits.test.ts`.

**MS-40.** Frontmatter parsing never throws. A file with no `---` opener yields empty defaults and the
whole trimmed input as body; a file whose block never closes does the same but sets `unparsable`.
Production: `packages/memory/src/frontmatter.ts`.
Test: `packages/memory/tests/unit/frontmatter.test.ts`.

**MS-41.** An unrecognized frontmatter key survives a parse/serialize round trip, in its original
order, and re-serialization is byte-stable.
Production: `packages/memory/src/frontmatter.ts` (unknown line pushed to `extra`)
(re-emitted in place at a fixed position).
Test: `packages/memory/tests/unit/frontmatter.test.ts`; the practical consequence —
a user's `owner:` key surviving a placeholder-description repair — at
`packages/memory/tests/integration/reindex.test.ts`.

**MS-42.** An `authority:` value outside `observed|confirmed|contested`, and a `pinned:` value that is
not boolean-ish, are preserved verbatim in `extra` rather than coerced; and `serializeDoc` emits
`authority`/`pinned` only when the parser saw them.
Production: `packages/memory/src/frontmatter.ts`.
Test: `packages/memory/tests/unit/frontmatter.test.ts`.

**MS-43.** A `description` containing newlines is flattened to one line on write, so the reindex can
always find it.
Production: `packages/memory/src/frontmatter.ts`.
Test: `packages/memory/tests/unit/frontmatter.test.ts`.

**MS-44.** `reindex` is idempotent: a second pass over a settled tree reports no changes, because a
file is written only when its content actually differs.
Production: `packages/memory/src/reindex.ts`.
Test: `packages/memory/tests/integration/reindex.test.ts`.

**MS-45.** An index file whose frontmatter block is unclosed is left byte-identical and excluded from
the change list; its directory's navigation stays stale.
Production: `packages/memory/src/reindex.ts`.
Test: `packages/memory/tests/integration/reindex.test.ts`.

**MS-46.** Prose outside the managed Contents block is never touched, and a hand-written description
outranks a derived one.
Production: `packages/memory/src/reindex.ts`.
Test: `packages/memory/tests/integration/reindex.test.ts`.

**MS-47.** A child with no description is linked as a bare link, with no ` — ` separator.
Production: `packages/memory/src/reindex.ts`.
Test: `packages/memory/tests/integration/reindex.test.ts`.

**MS-48.** A hand-created leaf carrying a `description:` is wired into navigation on the next pass,
with the ancestor `TOPIC.md` and root `PROFILE.md` scaffolded as needed.
Production: `packages/memory/src/reindex.ts`.
Test: `packages/memory/tests/integration/reindex.test.ts`.

**MS-49.** A query that reduces to no significant terms returns no hits, not the whole wiki.
Production: `packages/memory/src/query.ts`.
Test: `packages/memory/tests/component/query.test.ts`.

**MS-50.** Ranking is a total order and independent of write order: the same corpus and query rank
identically every time.
Production: `packages/memory/src/query.ts` (final tiebreak on path).
Test: `packages/memory/tests/component/query.test.ts`.

**MS-51.** Metadata can never surface a document that did not match lexically, and can only reorder
near-equals (≥ 64 % of the rival's score).
Production: `packages/memory/src/query.ts`.
Test: `packages/memory/tests/component/query.test.ts`.

**MS-52.** A regex whose worst-case cost cannot be bounded is never handed to the engine; it degrades
to a keyword scan, and the caller is not told which of the three refusal reasons applied.
Production: `packages/memory/src/text/grep.ts` (all three gates share one fallback).
Test: `packages/memory/tests/unit/tokenize.test.ts` (behavioural: `(build+)+$` matches
`the build is broken` as a keyword search, which the compiled regex would not have).

**MS-53.** A long line is windowed rather than truncated, so a match past `GREP_LINE_MAX` is still a
match; the excerpt remains capped at one window.
Production: `packages/memory/src/text/grep.ts`.
Test: `packages/memory/tests/unit/tokenize.test.ts`; the runtime bound at
`packages/memory/tests/integration/grep-runtime-bound.test.ts`.

**MS-54.** The window step is strictly less than the window width, so a boundary cannot hide a match
shorter than the overlap.
Production: `packages/memory/src/text/grep.ts`.
Test: `packages/memory/tests/unit/tokenize.test.ts`.

**MS-55.** Both scan budgets are consulted between lines and windows: `ok()` goes false at
`GREP_SCAN_MAX_LINES` lines or `GREP_SCAN_MAX_MS` of clock, and a long line's window loop stops on
the same predicate after exactly one window when the budget is already spent.
Production: `packages/memory/src/text/grep.ts`.
Test: `packages/memory/tests/unit/tokenize.test.ts`.

**MS-56.** Diacritic folding is normalization, never stemming, and never user-visible: tokens are only
scored, and snippets come from the original body.
Production: `packages/memory/src/text/tokenize.ts`; snippet from `parsed.body` at
`packages/memory/src/query.ts`.
Test: `packages/memory/tests/unit/tokenize.test.ts`;
`packages/memory/tests/component/query.test.ts`.

**MS-57.** `captureWorkspaceState` reports absence rather than failing when the directory is not a
repo, git is missing, or a probe exceeds 1500 ms, and logs `memory.workspace_state.unavailable` at
debug. All three parallel Git probes settle before it reports that absence, so no sibling process can
retain the workspace as its current directory after the caller resumes.
Production: `packages/memory/src/workspace-state.ts` (`captureWorkspaceState`).
Test: `packages/memory/tests/integration/workspace-state.test.ts` (`workspace state capture`; the
non-repository case removes its workspace immediately after capture returns).

**MS-58.** `systemClock.after` unrefs its timer defensively, so a pending drain never keeps a process
alive on its own.
Production: `packages/memory/src/clock.ts`.
Test: unpinned.

**MS-59.** `MEMORY_DEFAULTS.history.min_revisions` is a floor that outranks both the count and the age
bound: the prune predicate never drops a revision at index `< min_revisions`.
Production: `packages/memory/src/file-store/revisions.ts`, constants at
`packages/memory/src/config.ts`.
Test: `packages/memory/tests/integration/file-store-internals.test.ts` calls `prune` directly
and asserts that the absolute floor of three revisions, including both artifacts, survives.

**MS-60.** `delete` returns a boolean, not `void`: `true` when the document existed and was removed,
`false` when it was already absent. The staged batch handle's `delete` mirrors this, computing
`existed` from the merged staged+tree read.
Production: `packages/memory/src/file-store/documents.ts`,
`packages/memory/src/batch.ts`.
Test: `packages/memory/src/testing.ts` ("reports an absent document as null and delete as
false"), driven at `packages/memory/tests/contract/store.test.ts` against both backends.

**MS-61.** The run-dedup ledger is independent per run id and idempotent: `wasIndexed(runId)` is
`false` before `markIndexed(runId, …)` and `true` after, marking the same run id a second time is
safe, and a different run id is unaffected.
Production: `packages/memory/src/file-store/jobs.ts`.
Test: `packages/memory/src/testing.ts` ("records a run in the ledger at most once").

**MS-62.** `truncate(text, max)` guarantees the *output* is `text` verbatim only when `text.length <=
max`; once truncation applies, the returned string is `text.slice(0, max - 1) + "…"`, which is exactly
`max` characters for any `max >= 1` but is the one-character string `"…"` (length 1) when `max` is `0`
— `Math.max(0, max - 1)` floors the slice at `0` rather than yielding an empty result, so the "at most
`max` characters" contract is not held at `max = 0`.
Production: `packages/memory/src/text.ts`.
Test: `packages/memory/tests/unit/text.test.ts` ("never exceeds the cap, including at zero" —
asserting `truncate("abcdef", 0)` is `"…"`, i.e. the test pins the one-character overrun rather than a
strict cap).

**MS-63.** `Memory.reindex(tx)` never takes a second exclusive lock: a supplied transaction is used
directly, while an omitted transaction is the only path that calls `store.exclusive`.
Production: `packages/memory/src/memory.ts`.
Test: `packages/memory/tests/integration/memory.test.ts` ("reindexes through a caller-supplied
transaction without taking a nested exclusive lock").

---

## 6. Failure modes and degradation

| Condition | Behaviour | Handler |
| --- | --- | --- |
| Bad document key | throws `MemoryPathError` synchronously inside an async method (so it surfaces as a rejected promise) | `packages/memory/src/paths.ts` |
| On-disk document over `documentBytes` | strict `read` throws `MemoryStorageLimitError`; `grep` skips it outright; `list` instead truncates it to a `prefixBytes` read (`truncate: true`), same as `readBounded`, and never observes the oversize; `readBounded` itself returns a truncated prefix | `packages/memory/src/bounded-io.ts`, `packages/memory/src/file-store/documents.ts` (list) (grep) |
| File grew between stat and read | `MemoryStorageLimitError` when it crossed the limit, otherwise `Error("memory: file changed while it was being read")` | `packages/memory/src/bounded-io.ts` |
| File changed during `version()` hashing | `Error("memory: file changed while it was being hashed")` | `packages/memory/src/file-store/documents.ts` |
| File vanished mid-`version()` | contributes 0 bytes, no error | `packages/memory/src/file-store/documents.ts` |
| File vanished mid-`grep` | swallowed if `ENOENT`, rethrown otherwise | `packages/memory/src/file-store/documents.ts` |
| `stat` fails while listing | `updated_at` falls back to the injected clock | `packages/memory/src/file-store/documents.ts` |
| Missing directory in a scan | reported as an empty scan | `packages/memory/src/bounded-io.ts` |
| Lock contention | poll every 25 ms until `timeoutMs`, then `Error("memory: timed out waiting for tree lock <dir>")`; a debug `memory.lock.wait` records `waited_ms` and `stolen` | `packages/memory/src/file-store/lock.ts` |
| Lock cleanup / steal / release / heartbeat failure | best-effort, routed through one observation seam rather than `process.emitWarning` | `packages/memory/src/file-store/tasks.ts` |
| Interrupted batch, `committed` | swept | `packages/memory/src/journal.ts` |
| Interrupted batch, `applied` | commit work replayed, then swept | `packages/memory/src/file-store/recovery.ts` |
| Interrupted batch, neither marker, tree consistent | rolled back to the pre-batch bytes | `packages/memory/src/file-store/recovery.ts` |
| Interrupted batch, third-party edit / newer version / missing pre-image / over-limit record / over-limit document / over-limit journal scan | `required`; the store keeps serving reads and refuses every `batch` with `MemoryRecoveryRequiredError` | `packages/memory/src/journal.ts`, `packages/memory/src/file-store/recovery.ts` |
| Corrupt `prepare.json` | read as `null`, batch swept | `packages/memory/src/file-store/journal.ts` |
| Corrupt revision `.json` | skipped silently by `list` (the `try` around `JSON.parse` has an empty catch) | `packages/memory/src/file-store/revisions.ts` |
| Revision `.json` truncated or over `metadataBytes` | skipped; the read is `truncate: true` and a truncated result returns early | `packages/memory/src/file-store/revisions.ts` |
| Revision list past `corpusBytes` | the visitor returns `false`, stopping the scan, without an error | `packages/memory/src/file-store/revisions.ts` |
| Revision pruning failure | best-effort per file, never rejects | `packages/memory/src/file-store/revisions.ts` |
| Revision pruning interrupted between its two deletes | `prune()` removes a revision's `.json` metadata first, then its `.md` body, in two separate best-effort calls; since `list()` (and `read()`, per MS-22) only enumerates `.json` files, a crash between the two permanently orphans the `.md` body — it no longer appears in any future `list()`, so a later `prune()` pass can never target it. Untested: no test in `packages/memory/tests` exercises an interrupted `prune()` | `packages/memory/src/file-store/revisions.ts` |
| Unclosed frontmatter in an index file | that directory is skipped for the whole pass; `memory.document.skipped` at debug | `packages/memory/src/reindex.ts` |
| Child document with no description | linked without a description, `memory.document.skipped { reason: "no_description" }` at debug | `packages/memory/src/reindex.ts` |
| Regex refused / over-long / uncompilable | degrades to keyword scan, silently | `packages/memory/src/text/grep.ts` |
| Grep budget exhausted | returns whatever was found; the module states this is silent by design | `packages/memory/src/text/grep.ts` |
| Query over its caps | still answers, flagging `truncated` plus a `truncation_reasons` list of `query` / `documents` / `document_bytes` / `corpus_bytes` | `packages/memory/src/query.ts` |
| `JSON.stringify` failure in the digest | the args excerpt degrades to `"{}"` | `packages/memory/src/digest.ts` |
| git unavailable / not a repo / probe timeout | `WorkspaceState` is `undefined`, debug log only | `packages/memory/src/workspace-state.ts` |

There are **no retries and no timeouts** in this layer other than the tree-lock wait
(`packages/memory/src/file-store/lock.ts`), the git probe
(`packages/memory/src/workspace-state.ts`) and the grep wall-clock budget
(`packages/memory/src/text/grep.ts`). Retry policy for index jobs is the sibling document's.

---

## 7. Coupling

### 7.1 Outbound (runtime, static)

| Depends on | What forces it |
| --- | --- |
| `@clarvis/paths` | `ensureWorkspaceSubdir` (`packages/memory/src/file-store/layout.ts`), `writeFileAtomic` + `isTmpFile` (`packages/memory/src/file-store/documents.ts`), `writeFileDurable` (`packages/memory/src/file-store/journal.ts`, `packages/memory/src/file-store/revisions.ts`, `packages/memory/src/file-store/jobs.ts`), and `workspacePaths`/`workspaceStatePaths` in the factory (`packages/memory/src/factory.ts`) |
| `@clarvis/capability` | the `Logger` port and its helpers `NOOP_LOGGER`, `levelEnabled`, `createSampler`, `sanitizeErrorMessage`, and the `bestEffort` / `detachObserved` observation pair (`packages/memory/src/file-store/tasks.ts`, `packages/memory/src/file-store/lock.ts`, `packages/memory/src/reindex.ts`, `packages/memory/src/workspace-state.ts`) |
| Node built-ins only | `node:crypto`, `node:fs`, `node:path`, `node:readline`, `node:async_hooks`, `node:child_process` — no third-party runtime dependency reaches this layer |

`zod` is a package dependency (`packages/memory/package.json` `dependencies`) but no module in the
store layer imports it — the frontmatter parser is hand-rolled precisely "to keep the package a leaf
with `zod` as its only runtime dependency" (`packages/memory/src/frontmatter.ts`), and the schema
surface lives in `src/schemas.ts` / `src/settings.ts`. `@clarvis/loop`
is likewise a package dependency, reached only through `IndexerRuntime`'s `ExecuteRunDeps` **type**
import (`packages/memory/src/types.ts`) — a type-only edge from this layer's point of view.

`@clarvis/paths` is what makes the machinery split possible at all: `memoryRoot` under
`.clarvis` (`packages/paths/src/workspace.ts`) and `memoryMachineryRoot` under the global state
root (`packages/paths/src/workspace-state.ts`) are two different functions, and
`createFileMemoryStore` takes them as two independent options.

### 7.2 Internal edges within the package

- `file-store.ts` is the only composer: it imports all seven `file-store/*` modules plus `batch.ts`
  (`packages/memory/src/file-store.ts`). Nothing else does.
- `batch.ts` depends on `frontmatter`, `paths`, `revisions`, `storage-limits` and `journal`
  (`packages/memory/src/batch.ts`) but on **no** backend — the `BatchPrimitives` port
   is what keeps the sequence backend-agnostic, and both adapters implement it
  (`packages/memory/src/file-store.ts`, `packages/memory/src/testing.ts`). The in-memory
  adapter's `writeJournal`/`markApplied`/`markCommitted`/`sweepJournal` are all no-ops; its own doc
  comment states why — "a journal exists so a batch can be finished or undone by a *later process*;
  this store cannot outlive its process, so there is nothing to recover to" — while all-or-nothing
  behaviour still holds because `runBatch` stages every operation and applies them only after the
  batch body returns (`packages/memory/src/testing.ts`).
- `journal.ts` holds the record shape and the **pure** decision; the I/O lives in
  `file-store/journal.ts` and `file-store/recovery.ts`, which the module header names as the reason
  the rule is testable without a filesystem (`packages/memory/src/journal.ts`).
- `tree.ts` was extracted from the reindex pass so health diagnostics and ranked query ask the same
  code rather than reimplementing the pyramid (`packages/memory/src/tree.ts`); its consumers are
  `packages/memory/src/reindex.ts` and `packages/memory/src/query.ts`.
- `text/grep.ts` is shared by both adapters — `packages/memory/src/file-store/documents.ts` and `packages/memory/src/testing.ts` — so
  "what counts as a match" has one definition (`packages/memory/src/text/grep.ts`).
- `similar.ts` imports `paths` and `text/tokenize` but is imported only by
  `packages/memory/tests/component/query.test.ts`, and is not in the barrel
  (`packages/memory/src/index.ts`). Its own header states it "has no production caller" and is kept as
  the baseline that keeps the ranker comparison honest (`packages/memory/src/similar.ts`). The
  same header states why it stopped being one: it used to be the indexer's selector for "which
  existing documents are relevant to this run", ranking over path, description and tags but never a
  document's body — "so the one component that decides which document to *rewrite* ranked without
  reading any of them, and wrote near-duplicates beside the leaves it should have updated"
  (`packages/memory/src/similar.ts`). The indexer now shares `query.ts`'s BM25 ranker instead.
- `file-store/tasks.ts` is the single shared failure-observation seam for every best-effort file-store
  side effect: `bestEffortFileStore` and `detachFileStoreTask`, both wrapping `@clarvis/capability`'s
  `bestEffort`/`detachObserved`. Its own doc comment states the rationale directly — the two used to
  route through `process.emitWarning`, which "bypasses every logger: no package installs a
  `process.on(\"warning\")` handler, so Bun's default handler wrote the line straight to the host's
  stderr — over the TUI's own canvas, and as a non-JSON line interleaved into a container's JSON log"
  (`packages/memory/src/file-store/tasks.ts`). Five call sites route through it: lock cleanup,
  the stale-lock steal, lock release and the heartbeat (`packages/memory/src/file-store/lock.ts`), job pruning (`packages/memory/src/file-store/jobs.ts`), revision metadata and body pruning
  (`packages/memory/src/file-store/revisions.ts`), the orphan-bookkeeping cleanup on a vanished split wiki
  (`packages/memory/src/file-store/layout.ts`), and journal sweep (`packages/memory/src/file-store/journal.ts`).

### 7.3 Inbound

| Consumer | Edge |
| --- | --- |
| `packages/memory/src/memory.ts` | `createMemory` / `createFileMemory` compose the store into the `Memory` facade |
| `packages/memory/src/factory.ts` | the per-owner factory constructs the default split store and threads `logger` + `lockWarnMs` |
| `packages/memory/src/tools.ts` | the model-facing write tools go through `reindexView` over a batch (**sibling document**) |
| `packages/memory/src/health.ts` | health reuses `planReindex` to detect stale navigation |
| `packages/kernel/src/owner-scoped-file-stores.ts` | the kernel's public multi-owner composition seam builds one file store per encoded owner segment |
| `packages/kernel/tests/architecture/workspace-surface.test.ts` | the kernel's own test that the working tree receives only markdown |
| `packages/kernel/tests/integration/memory-capability.test.ts` | the kernel drives the in-memory adapter from `@clarvis/memory/testing` |

The `./testing` subpath export (`packages/memory/package.json`) is what lets another package import
the in-memory adapter and the conformance table without pulling in test-runner code — the module
carries `node:assert/strict` and nothing else (`packages/memory/src/testing.ts`).

---

## 8. Open questions

1. **`readDescription` and `MemoryMutationFence`.** `readDescription` has exactly one production
   caller (`packages/memory/src/tools.ts`, sibling document); `MemoryMutationFence`
   (`packages/memory/src/types.ts`) is declared in this layer but implemented and consumed by the
   job/drain layer. Both are named here for completeness and specified by the sibling documents.

2. **Durability of the machinery writes is unpinned.** MS-21 states the code calls `writeFileDurable`,
   and `packages/paths/src/atomic.ts` states what that adds, but no test in
   `packages/memory/tests` observes an `fsync` or simulates a power loss. The recovery matrix is
   tested by planting on-disk state, which is a different guarantee.

3. **`poke` is the only backend-capability negotiation left.** Whether other
   backend-specific behaviours (e.g. cross-process durability, which `MemoryStore.recover`'s doc
   comment mentions at `packages/memory/src/types.ts`) were meant to become harness flags is not
   determinable.

4. **Rationale is largely absent from the code and deliberately not inferred here.** Where a doc
   comment or a test name states a reason — the locale-independent path comparator
   (`packages/memory/src/paths.ts`), the `applied` marker splitting the recovery policy
   (`packages/memory/src/journal.ts`), the multiplicative boost clamp
   (`packages/memory/src/query.ts`), the window-versus-truncate trade
   (`packages/memory/src/text/grep.ts`), the "never index from inside `exclusive`" rule
   (`packages/memory/src/file-store/lock.ts`) — it is quoted above. Everywhere else the mechanism
   is described and the motive left open.

5. **Windows execution is scheduled but has no current green evidence.** The dedicated Windows job
   now includes the complete `@clarvis/memory` suite, with named capability predicates around POSIX
   mode bits and file-symlink creation. The workflow itself remains manually disabled for lack of
   billable Actions minutes, so the store's Windows `process.kill(pid, 0)` liveness behavior is still
   unverified until an operator runs that job (`.github/workflows/ci.yml`, `windows`).
