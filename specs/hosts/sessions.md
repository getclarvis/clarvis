# Saved sessions, listing/paging, deletion and restoring a run

> Implemented at `packages/kernel/src/sessions/session-service.ts`,
> `packages/kernel/src/runs/map-events.ts`, `packages/code/src/adapters/session.ts` and
> `packages/code/src/adapters/session-store.ts`, plus their tests. Every claim below is anchored to
> a file and line. Open questions are collected in the final section.

## 1. Purpose

A `Session` (`packages/protocol/src/sessions.ts:54`) is a conversation index: an ordered list of
turns, each optionally pointing at a run (`execution_id`) whose full transcript lives in the runs
service, plus running token/cost totals and any not-yet-delivered "pending" observations
(`packages/protocol/src/sessions.ts:70-74`). The session document itself never carries the
transcript — only enough to look up and re-render it. Each turn may also carry the id and fingerprint
of the resolved [Extension Environment](environments.md) under which it began; this is historical
identity, not a request to reactivate that Environment during resume.

Two problems this subsystem solves:

1. **Where a session lives on disk, and how it survives a catalog with an unbounded number of
   entries.** `createSessionService` (`packages/kernel/src/sessions/session-service.ts:335`) is a
   file-backed `SessionService`: one JSON document per session under a per-owner directory, plus a
   bounded "summary" sidecar so listing a large catalog never has to read every full document
   (`packages/kernel/src/sessions/session-service.ts:33,143-157,370-414`).
2. **How a client rebuilds a visible transcript from persisted traces.** Every turn carries a
   required `kind`: conversation turns may rebuild model-facing continuation, while transcript turns
   are display/export-only. `resumeSession` walks conversation ids backwards for continuation and
   separately fetches every kind inside the visual window, while tracking what could not be restored
   (`degraded`) versus what was simply outside that window (`collapsed`).

Deletion is a third concern this document owns: `deleteSession`
(`packages/code/src/adapters/session.ts:670`) cascades a session delete into a delete of every
turn's run trace, one call at a time, before deleting the session record itself.

Everything about the trace *store*'s on-disk format is [foundations/trace.md](../foundations/trace.md)'s scope;
everything about the *mapping* of individual trace/capability events to protocol `RunEvent`s is
[hosts/kernel-runs.md](kernel-runs.md)'s scope. This document covers only the session record itself, and the
rehydration arm that decides which already-mapped events survive a restore versus which are
"live-only" and are simply gone once a run ends. The TUI's `SessionStore` write-coalescing cache
and the CLI's `--resume`/`--continue` flag wiring are described only insofar as they call into this
item's functions; their own mechanics are [hosts/code-run-host.md](code-run-host.md)'s scope.
Whether the reconstructed nodes are immediately mutable UI state or are prepared into an immutable
history page is separately owned by
[hosts/code-transcript-stability.md](code-transcript-stability.md). `resumeSession` supplies ordered
`RunDetail.events` to its `renderTurn` callback (`packages/code/src/adapters/session.ts:597-642`); it
does not define a renderer commit boundary.

## 2. Surface

### `SessionService` (kernel-side, `packages/protocol/src/sessions.ts:92-121`)

| Method | Signature | Cite |
|---|---|---|
| `listPage` | `(page?: CursorPagination) => Promise<CursorPage<SessionSummary>>` | `packages/protocol/src/sessions.ts:94` |
| `list` | `() => Promise<Session[]>` | `packages/protocol/src/sessions.ts:97` |
| `get` | `(id: string) => Promise<Session \| null>` | `packages/protocol/src/sessions.ts:105` |
| `save` | `(session: Session) => Promise<void>` | `packages/protocol/src/sessions.ts:112` |
| `delete` | `(id: string) => Promise<boolean>` | `packages/protocol/src/sessions.ts:120` |

The file-backed implementation widens `listPage` with a second, non-wire parameter for transport
cancellation (`FileSessionService`, `packages/kernel/src/sessions/session-service.ts:270-275`):

```ts
interface FileSessionService extends SessionService {
  listPage(page?: CursorPagination, scan?: { signal?: AbortSignal }): Promise<CursorPage<SessionSummary>>;
}
```

The kernel's transport layer accesses this widened shape by a local, non-exported cast
(`SignalAwareSessionListPage`, `packages/kernel/src/transport/operations.ts:115-128`) precisely so
the wire-level `CursorPagination` DTO never grows a `signal` field.

### Wire methods (`packages/kernel/src/transport/operations.ts:677-714`)

| Method | Access | Encode | Cite |
|---|---|---|---|
| `sessions.listPage` | read | `{ page }` | `packages/kernel/src/transport/operations.ts:678-688` |
| `sessions.list` | read | `{}` | `packages/kernel/src/transport/operations.ts:689-694` |
| `sessions.get` | read | `{ id }` | `packages/kernel/src/transport/operations.ts:695-700` |
| `sessions.save` | write | `{ session }` | `packages/kernel/src/transport/operations.ts:701-707` |
| `sessions.delete` | write | `{ id }` | `packages/kernel/src/transport/operations.ts:708-713` |

`packages/code/src/adapters/kernel-run-client.ts:504-510` is a bare passthrough of these five
methods onto `requireKernel().sessions`, exposed on the client at `sessions`
(`packages/code/src/adapters/kernel-run-client.ts:112,581`).

### `Session` / `SessionSummary` DTOs (`packages/protocol/src/sessions.ts`)

```ts
interface Session {                       // packages/protocol/src/sessions.ts:54
  id: string; title: string; project_id: string; workspace: string;
  created_at: Timestamp; updated_at: Timestamp; profile?: string;
  turns: SessionTurn[]; totals: SessionTotals; pending?: Message[];
}
interface SessionTurn {                   // packages/protocol/src/sessions.ts:34
  kind: "conversation"|"transcript";
  user_preview: string; execution_id?: string;
  environment?: EnvironmentRunRef;
  status: "pending"|"running"|"done"|"error"|"cancelled"|"interrupted";
  started_at?: Timestamp; ended_at?: Timestamp;
}
interface SessionSummary {                // packages/protocol/src/sessions.ts:78 — never carries turns/pending
  id: string; title: string; project_id: string; workspace: string;
  created_at: Timestamp; updated_at: Timestamp; profile?: string;
  turn_count: number; last_status?: SessionTurnStatus;
  last_environment?: EnvironmentRunRef; totals: SessionTotals;
}
interface SessionTotals {
  input: number; output: number; cached?: number; cost_usd?: number;
}
```

`cached` has evidence semantics: a number, including zero, is the complete measured cache-read
total; absence means at least one positive-input contribution omitted the split. Production:
`packages/protocol/src/sessions.ts` (`SessionTotals`). Test:
`packages/protocol/tests/contract/public-contract.fixture.ts` (`unknownCacheSessionTotals`).

### `createSessionService` options (`packages/kernel/src/sessions/session-service.ts:335-342`)

```ts
createSessionService(opts: {
  dir: string; owner: string; projectId: string; workspaceId: string; logger?: Logger;
}): FileSessionService
```

### Code-side session functions covered by this document

| Symbol | Signature | Cite |
|---|---|---|
| `resumeSession` | `(meta, deps: ResumeDeps, opts?: ResumeOptions) => Promise<ResumedSession>` | `packages/code/src/adapters/session.ts:504` |
| `deleteSession` | `(meta, store: SessionStore, deleteRun: (id) => Promise<boolean>) => Promise<{session, traces}>` | `packages/code/src/adapters/session.ts:670` |
| `buildRecoveredContext` | `(events, planRef?, selectedPlanProviderKey?) => string \| null` | `packages/code/src/adapters/session.ts:290` |
| `createSession` | `(deps: SessionDeps, init?: SessionInit) => Session` (the code-side turn tracker, distinct name from the protocol DTO) | `packages/code/src/adapters/session.ts:93` |
| `isContinuationUnavailable` | `(envelope: RunResult \| undefined) => boolean` | `packages/code/src/adapters/session.ts:82` |

### CLI surface touching sessions (declared at `packages/code/src/cli-args.ts:80-83`)

| Flag | Value | Cite (behavior) |
|---|---|---|
| `--resume` | `<session-id>` | `resumeSessionById` at `packages/code/src/run-host.ts:1418-1433`, wired by `sessionControls` in `packages/code/src/runtime.tsx`; `assertSessionExists` in the same runtime |
| `--continue` | — | `assertSessionExists` calls `resolveResumeMeta` during boot preflight; interactive resume resolves the same metadata in `runApp` (`packages/code/src/runtime.tsx`) |
| `--list` | — | `runListMode`, `packages/code/src/runtime.tsx` |
| `--delete` | `<session-id>` | `runDeleteMode`, `packages/code/src/runtime.tsx` |

The CLI flag *parsing* and the `Mode` union are [hosts/code-run-host.md](code-run-host.md)'s territory; only
the session-delete/resume cascade these modes call into is this document's.

## 3. Data and formats

### On-disk layout

For an owner-scoped `SessionService` built with `dir`/`owner`, files live under:

```
<dir>/state/sessions/<ownerSegment(owner)>/<ownerSegment(id)>.json           # full Session document
<dir>/state/sessions/<ownerSegment(owner)>/<ownerSegment(id)>.summary.json   # bounded SessionSummary sidecar
```

`ownerDir = join(globalPaths(opts.dir).sessionsDir, ownerSegment(opts.owner))`
(`packages/kernel/src/sessions/session-service.ts:344`); `globalPaths(...).sessionsDir` is `join(base, "state", "sessions")`
(`packages/paths/src/global.ts:125`, with `state = join(base, "state")` at `packages/paths/src/global.ts:105`).
`fileFor`/`summaryFor` append `${ownerSegment(id)}.json` / `.summary.json`
(`packages/kernel/src/sessions/session-service.ts:347-353`). `ownerSegment` percent-encodes an arbitrary string into one safe
path segment, or falls back to `h_<sha256hex>` past a 200-byte encoded length
(`packages/paths/src/roots.ts:130,139-144,163-168`) — so an owner or session id of unbounded length
or containing `/`/`.`/`..` cannot escape the owner directory or collide with a sibling segment.

Both files are written with `writeFileAtomicSync` — tmp file + `rename`, **no `fsync`**
(`packages/paths/src/atomic.ts:473-479`, which calls the shared `writeStagedSync` at `:405-436` with
`durable = false`) — so a concurrent reader observes either the old file or the complete new one,
never a partial write, but a power loss can still lose the write entirely (`packages/kernel/src/sessions/session-service.ts:553-554`
doc comment). The `fsync`-of-payload-plus-directory-`fsync` variant is a **separate** function,
`writeFileDurableSync` (`packages/paths/src/atomic.ts:513-519`), whose doc remark (`packages/paths/src/atomic.ts:481-497`) states this
durability guarantee is why it is "a separate function rather than a flag" on `writeFileAtomic`.
`session-service.ts` imports and calls only `writeFileAtomicSync` (`packages/kernel/src/sessions/session-service.ts:12,408,577-578`)
and never calls `writeFileDurableSync`.

### Example `Session` document (from the test fixture, `packages/kernel/tests/integration/session-service.test.ts:11-22`)

```json
{
  "id": "s1",
  "title": "session s1",
  "project_id": "prj_test",
  "workspace": "ws_test",
  "created_at": 1,
  "updated_at": 100,
  "turns": [{ "kind": "conversation", "user_preview": "hi", "status": "done" }],
  "totals": { "input": 0, "output": 0, "cached": 0 }
}
```

### Code-side data model: `SessionMeta` / `TurnRef`

The TUI never operates on the wire `Session`/`SessionTurn` DTOs directly; `createSession`,
`resumeSession` and `deleteSession` all read and write the code-side `SessionMeta`/`TurnRef` shapes
(`packages/code/src/adapters/session-store.ts:51-66,28-44`), and two conversion functions bridge the
two representations at the storage boundary:

- **`metaToSession(m)`** (`packages/code/src/adapters/session-store.ts:294-322`) and **`sessionToMeta(s, owner)`**
  (`packages/code/src/adapters/session-store.ts:323-354`) convert camelCase (`userPreview`, `executionId`, `startedAt`,
  `endedAt`, `costUsd`) to and from the wire's snake_case (`user_preview`, `execution_id`,
  `started_at`, `ended_at`, `cost_usd`) field by field, each optional field present only when its
  source has it (spread-guarded, e.g. `...(t.executionId !== undefined ? { executionId: ... } : {})`).
  Pinned round-trip: "metaToSession <-> sessionToMeta round-trips (camelCase <-> snake_case)"
  (`packages/code/tests/component/session-store.test.ts:73-91`).
- **Cache-detail absence survives both conversion directions.** `metaToSession`, `sessionToMeta` and
  `sessionSummaryToMeta` include `cached` only when their source includes it; no boundary replaces
  missing detail with zero. Production: `packages/code/src/adapters/session-store.ts`
  (`metaToSession`, `sessionToMeta`, `sessionSummaryToMeta`). Test:
  `packages/code/tests/component/session-store.test.ts` ("an unknown cache split stays absent across
  the persisted session boundary").
- **`TurnRef.kind` / `SessionTurn.kind` is mandatory and semantic.** The code-side `TurnRef` is the
  discriminated union `ConversationTurnRef | TranscriptTurnRef`; `metaToSession` writes its kind and
  `sessionToMeta` validates it through `persistedTurnKind`. Missing or unknown values from a stale
  pre-discriminator document throw `"session turn kind is required"`; the adapter never guesses a
  continuation role. Production: `packages/protocol/src/sessions.ts` (`SessionTurnKind`,
  `SessionTurn`), `packages/code/src/adapters/session-store.ts` (`ConversationTurnRef`,
  `TranscriptTurnRef`, `TurnRef`, `persistedTurnKind`, `metaToSession`, `sessionToMeta`). Test:
  `packages/code/tests/component/session-store.test.ts` ("transcript-only turn identity is persisted
  and stale undiscriminated turns are rejected").
- **`TurnRef.environment` / `SessionMeta.lastEnvironment`** preserve the resolved Environment id and
  fingerprint without embedding its definition, plugins, skills, or secrets. `metaToSession` and
  `sessionToMeta` round-trip the turn field; `sessionSummaryToMeta` retains
  `SessionSummary.last_environment` even though its bounded projection deliberately omits `turns`.
  Production: `packages/code/src/adapters/session-store.ts` (`metaToSession`, `sessionToMeta`,
  `sessionSummaryToMeta`). Test: `packages/code/tests/component/session-store.test.ts`
  ("Environment identity round-trips on turns and bounded summaries").
- **`TurnRef.error`** (`packages/code/src/adapters/session-store.ts`, `{ code: string; message: string }`)
  has no declared counterpart in the protocol `SessionTurn` DTO listed above (§2), but it is
  intentionally persisted through a local `PersistedSessionTurn` widening. `metaToSession` writes
  the optional pair and `sessionToMeta` accepts it only when both `code` and `message` are strings.
  The kernel stores session turns opaquely after checking only that `turns` is an array, so the extra
  JSON member survives the wire and disk round trip. `createSession.endTurn` masks and bounds the
  message before it reaches this converter. Production:
  `packages/code/src/adapters/session-store.ts` (`PersistedSessionTurn`, `persistedTurnError`,
  `metaToSession`, `sessionToMeta`). Test:
  `packages/code/tests/component/session-store.test.ts` (failed-turn reason persistence and malformed
  persisted error cases).
- `sessionSummaryToMeta(s, owner)` (`packages/code/src/adapters/session-store.ts:355-375`) is the third conversion, from the
  bounded wire `SessionSummary` to a `SessionMeta` whose `turns` is deliberately left `[]` with
  `turnCount` set instead — see `loadSessions` in §7 for where this is used to seed a catalog page
  without pretending its turns are loaded.

### Cursor format

`listPage`'s opaque cursor is `base64url(JSON.stringify([summary.updated_at, summary.id]))`
(`encodeCursor`, `packages/kernel/src/sessions/session-service.ts:287-291`), decoded and shape-checked by `decodeCursor`
(`packages/kernel/src/sessions/session-service.ts:293-314`): must be a 2-element array of `[finite number, non-empty string]`,
and the raw (pre-decode) cursor string itself must not exceed `CURSOR_MAX_BYTES = 256`
(`packages/kernel/src/sessions/session-service.ts:37,295-297`). Any violation throws `kernelError("invalid_request", ...)`
before the catalog is scanned (`packages/kernel/src/sessions/session-service.ts:296,308,312`), confirmed by
`packages/kernel/tests/integration/session-service.test.ts:216-242` (malformed JSON, `null`, empty
array, non-number/non-string members, an out-of-range float literal `1e999`, and a 2-tuple with an
empty id string are all rejected).

### Bounds and defaults

| Constant | Value | Cite |
|---|---|---|
| `SESSION_MAX_BYTES` | 8 MiB (full document) | `packages/kernel/src/sessions/session-service.ts:31` |
| `SESSION_SUMMARY_MAX_BYTES` | 8 KiB (summary sidecar) | `packages/kernel/src/sessions/session-service.ts:32` |
| `SESSION_PAGE_DEFAULT` | 50 | `packages/kernel/src/sessions/session-service.ts:33` |
| `SESSION_PAGE_MAX` | 200 | `packages/kernel/src/sessions/session-service.ts:34` |
| `LEGACY_LIST_MAX` | 200 full documents (`list()`) | `packages/kernel/src/sessions/session-service.ts:35` |
| `LEGACY_LIST_MAX_BYTES` | 32 MiB (`list()`) | `packages/kernel/src/sessions/session-service.ts:36` |
| `CURSOR_MAX_BYTES` | 256 | `packages/kernel/src/sessions/session-service.ts:37` |
| `JSON_MAX_DEPTH` | 128 | `packages/kernel/src/sessions/session-service.ts:38` |
| `SESSION_SCAN_BATCH` | 64 files per event-loop slice | `packages/kernel/src/sessions/session-service.ts:40` |
| `SESSION_SCAN_BATCH_BYTES` | 512 KiB inspected per slice | `packages/kernel/src/sessions/session-service.ts:42` |
| `SESSION_REFERENCE_SCAN_MAX_FILES` | 10,000 full session documents per trace-retention scan | `packages/kernel/src/sessions/session-service.ts` |
| `SESSION_REFERENCE_SCAN_MAX_BYTES` | 256 MiB per trace-retention scan | `packages/kernel/src/sessions/session-service.ts` |
| `SESSION_RESUME_MAX_PAYLOAD_CHARS` (code-side) | 16,000,000 | `packages/code/src/adapters/session.ts:399` |
| `SESSION_RESUME_MAX_MESSAGES` (code-side) | 10,000 | `packages/code/src/adapters/session.ts:400` |
| `DEFAULT_RENDER_WINDOW` (code-side) | 20 turns | `packages/code/src/adapters/session.ts:446` |
| `FETCH_CONCURRENCY` (code-side) | 6 | `packages/code/src/adapters/session.ts:459` |
| `MAX_RESIDENT_FULL_SESSIONS` (TUI store) | 8 | `packages/code/src/adapters/session-store.ts:250` |
| `TURN_ERROR_MAX_CHARS` (code-side) | 2,000 | `packages/code/src/adapters/session-store.ts` |

## 4. Behavior

`referencedSessionExecutionIds` performs the separate cross-owner scan used by trace retention. It
returns `{ ids, complete }`: malformed and oversized records are ignored, while either aggregate
bound or a non-missing filesystem error sets `complete: false`. A session catalog that is absent at
open or at the first lazy directory read is the same complete empty catalog, including on Bun
runtimes that defer `opendirSync` failure until `readSync`. Trace cleanup treats an incomplete flag
as a fail-closed destructive boundary and skips the pass rather than trusting a partial protection set.
Production: `packages/kernel/src/sessions/session-service.ts` and
`packages/kernel/src/file-kernel.ts`. Test:
`packages/kernel/tests/integration/session-service.test.ts`.

### 4.1 `listPage` — bounded, cursor-paged catalog scan

`packages/kernel/src/sessions/session-service.ts:446-481`. Step by step:

1. Resolve `limit` (default `SESSION_PAGE_DEFAULT`), reject `<1` or `>SESSION_PAGE_MAX` or
   non-integer as `invalid_request` (`:450-453`).
2. Decode/validate the cursor (`:454`, see §3).
3. Iterate `sessionEntries()` — a generator over `*.json` files in the owner dir, excluding
   `*.summary.json`, tolerating a missing directory (empty iteration) or a mid-scan
   `readSync`/`opendirSync` failure (returns/stops rather than throwing)
   (`packages/kernel/src/sessions/session-service.ts:416-443`).
4. For each entry, `readSummary` (see §4.2) produces a `SummaryRead`; a non-null summary that is
   `afterCursor` (`packages/kernel/src/sessions/session-service.ts:316-322` — strictly older `updated_at`, or equal `updated_at`
   with a lexicographically smaller `id`, tie-broken the same way `compareSummaries` orders pages)
   is offered to `retainSessionSummary` with capacity `limit + 1` (`:461-464`).
5. Every `SESSION_SCAN_BATCH` (64) files scanned, or once `SESSION_SCAN_BATCH_BYTES` (512 KiB) of
   file bytes have been inspected in the current slice, the scan awaits `yieldToEventLoop()`
   (`setImmediate`) and re-checks the cancellation signal (`:466-471`).
6. After the full directory scan, the retained set (at most `limit+1` items) is sorted by
   `compareSummaries` (`updated_at` descending, `id` descending on ties — `packages/kernel/src/sessions/session-service.ts:176-178`);
   `hasMore = selected.length > limit`; the page returns the first `limit` items and, if there is
   more, `next_cursor = encodeCursor(last item)` (`:473-480`).

`retainSessionSummary` (`packages/kernel/src/sessions/session-service.ts:187-253`) is a worst-first binary heap of bounded size
`capacity`: below capacity it inserts and bubbles up; at capacity it replaces the current worst
(heap root) only if the candidate compares better, then sinks the new root down — giving an exact
top-K in `O(log capacity)` per candidate rather than an `O(n log n)` full sort of every entry.
Pinned by `packages/kernel/tests/integration/session-service.test.ts:83-93` (exact top-4 of 10
inputs) and exercised at scale by `:95-124` (513 files, 25-per-page, asserting the listing does not
settle synchronously — i.e. it really yields — and that two successive pages partition the newest
513 correctly).

Cancellation: `assertScanActive(scan.signal)` (`packages/kernel/src/sessions/session-service.ts:259-263`) is checked before the
scan starts and after every yield point; an aborted signal throws
`kernelError("cancelled", "session catalog request was cancelled")` mid-scan
(`packages/kernel/tests/integration/session-service.test.ts:126-141`).

### 4.2 `readSummary` — sidecar-first read, with legacy repair

`packages/kernel/src/sessions/session-service.ts:374-414`. For one `.json` entry:

1. Try the sidecar (`<id>.summary.json`): stat it, reject (throw, caught below) if over
   `SESSION_SUMMARY_MAX_BYTES`, parse it, and accept it only if `isSummary(value)` **and** its
   `project_id`/`workspace` match the service's own (`:377-390`) — this is the per-owner isolation
   check applied a second time at the summary layer.
2. On any sidecar failure (missing, oversized, corrupt JSON, wrong shape, wrong
   project/workspace), fall through: stat + read the full session document via `readOne`
   (`:392-395`; see §4.3). If that also fails, return `{ summary: null, inspectedBytes }` — the
   entry is silently skipped from the page.
3. Otherwise, build a fresh `SessionSummary` from the full document (`toSummary`,
   `packages/kernel/src/sessions/session-service.ts:143-157` — last turn's `status` becomes `last_status`, `turns.length`
   becomes `turn_count`), serialize it bounded to 8 KiB (`serializeSummary`), and — if that fits —
   opportunistically write it back as the sidecar (`writeFileAtomicSync`, best-effort: a write
   failure, e.g. read-only filesystem, is swallowed, `:407-412`).
4. **A legacy full record whose derived summary itself cannot fit 8 KiB (oversized `title` or
   `totals`) is dropped from the page entirely** rather than truncated — no sidecar is written and
   the session is invisible to `listPage` until repaired
   (`packages/kernel/tests/integration/session-service.test.ts:158-182`, "skips legacy records
   whose title or totals cannot fit a bounded summary").

`inspectedBytes` accumulates whatever was actually stat'd/read (sidecar size, or sidecar size plus
full-document size on fallback) and feeds the batch-yield byte budget in `listPage`
(`packages/kernel/src/sessions/session-service.ts:379,393,466`).

### 4.3 `readOne` — full-document read with per-workspace isolation

`packages/kernel/src/sessions/session-service.ts:356-368`. Rejects (returns `null`, never throws) when: the file exceeds
`SESSION_MAX_BYTES`, `JSON.parse` throws, the parsed value fails `isSession` shape-checking
(`:17-29` — requires `id`/`project_id`/`workspace` strings, numeric `created_at`, array `turns`,
object `totals`), or the session's `project_id`/`workspace` do not match the service's own
`opts.projectId`/`opts.workspaceId`. This last check is the mechanism that keeps a session
readable only by the exact project+workspace it was saved for, even if two workspaces happened to
share the same owner directory — though in practice the owner directory itself is already
per-owner (see §5).

### 4.4 `list()` — legacy unbounded listing

`packages/kernel/src/sessions/session-service.ts:489-526`. Walks the same `sessionEntries()` generator, calling `readOne` on
every file, but with two hard caps rather than a bounded heap: more than `LEGACY_LIST_MAX` (200)
successfully-read sessions, or more than `LEGACY_LIST_MAX_BYTES` (32 MiB) of file bytes retained,
throws `kernelError("resource_exhausted", ...)` mid-scan telling the caller to use `listPage()`
instead (`:495-499,507-511`; pinned by
`packages/kernel/tests/integration/session-service.test.ts:308-324`). A corrupt/unreadable file is
skipped, not thrown (`:513-517`; pinned by `:358-369`, "a corrupt file in the owner dir is skipped,
not thrown"). Results sort newest-`updated_at`-first, `id` descending on ties (`:525`).

### 4.5 `get(id)` — single-session read plus a diagnostic

`packages/kernel/src/sessions/session-service.ts:534-547`. Delegates to `readOne(fileFor(id))`, then unconditionally logs
`{ event: "sessions.rehydrate", session_id, found, turns, pending }` at `debug`
(`:536-545`) — `found: session !== null`, so a session absent for any reason (never existed,
belongs to another project/workspace, corrupt, oversized) reads identically as `found: false` in
the log; the log message itself says as much ("a session that reads back as absent was unreadable
or belongs to another workspace"). Pinned by
`packages/kernel/tests/integration/session-service.test.ts:379-411`.

### 4.6 `save(session)` — validate, then two atomic writes

`packages/kernel/src/sessions/session-service.ts:556-579`.

1. Reject (`invalid_request`) if `session.project_id`/`session.workspace` do not match the service's
   own scope, **before any write** (`:557-562`; pinned by `:279-291`).
2. Serialize the full document bounded to `SESSION_MAX_BYTES` (throws `resource_exhausted` if it
   does not fit — see §4.8 for the preflight mechanism) and the derived summary bounded to
   `SESSION_SUMMARY_MAX_BYTES` (`:563-569`).
3. **Unlink the old summary sidecar first**, before writing either new file (`:574-576`) — the
   doc comment states the reasoning: a crash after this point can only leave a *missing* sidecar
   (which `readSummary` rebuilds from the authoritative full document), never a valid-looking but
   stale one.
4. Write the full document, then the new summary, both via `writeFileAtomicSync` (`:577-578`).

### 4.7 `delete(id)` — best-effort sidecar, authoritative document

`packages/kernel/src/sessions/session-service.ts:588-600`. Unlinks the summary sidecar first (ignoring a missing-file error —
"legacy records have no summary sidecar", `:591-593`), then unlinks the full document, returning
`true` only if that second unlink succeeded, `false` if the document was already gone (or could not
be unlinked) — the sidecar's own outcome is not reported. Pinned by
`packages/kernel/tests/integration/session-service.test.ts:326-338` ("get returns null for a
missing id; delete reports found/not-found").

### 4.8 Size preflight without full serialization

`jsonFits`/`jsonStringBytes` (`packages/kernel/src/sessions/session-service.ts:44-132`) walk a value and sum its *would-be* JSON
byte length without calling `JSON.stringify`, so a caller cannot use `toJSON`, a cyclic/absurdly
deep graph, or a `bigint` as an allocation-spike bypass of the size cap: any `toJSON` method present
on an object fails the preflight outright (`:109`), a `bigint` fails (`:102-103`,
`JSON.stringify` would throw on it anyway), and depth beyond `JSON_MAX_DEPTH` (128) fails
(`:89`). `serializeBounded` (`:134-141`) then re-checks the *actual* serialized byte length after
`JSON.stringify`, as a second bound. Pinned exhaustively by
`packages/kernel/tests/integration/session-service.test.ts:244-277` ("preflights the complete JSON
value without invoking custom serialization") — covering inherited/own enumerable string
properties, all JSON-escape byte-widths (quotes, backslash, control chars, surrogate pairs), an
`Array` containing `undefined`/a function/a `Symbol` (each of which becomes JSON `null` inside an
array but is *omitted* as an object member — matching `JSON.stringify`'s own behavior, `:100-101`
vs `:124`), a `toJSON`-bearing nested object (rejected), a top-level `bigint` (rejected), and a
130-level-deep nested array (rejected).

### 4.9 Deletion cascade (code-side, `deleteSession`)

`packages/code/src/adapters/session.ts:670-682`:

```ts
async function deleteSession(meta, store, deleteRun) {
  const traces = [];
  for (const turn of meta.turns) {
    if (turn.executionId)
      traces.push({ executionId: turn.executionId, deleted: await deleteRun(turn.executionId) });
  }
  const session = store.delete(meta.id);
  return { session, traces };
}
```

Turns are deleted **sequentially, in turn order** (a plain `for...of` with `await` inside), not
concurrently — pinned by the test "deleteSession removes the session file and cascades delete_run
per turn" in `packages/code/tests/component/session.test.ts`, which asserts `deleted` is
`["exec_a", "exec_b"]` in order). The session record itself is deleted **after** every turn's
`deleteRun` has been awaited — but only if none of those calls **rejects**: the loop has no
try/catch of its own, so a `deleteRun` that throws aborts the whole cascade before `store.delete`
is ever reached, leaving the session record intact. Whether a `false` (as opposed to a thrown
error) still lets the cascade finish and the session record still get deleted is exactly the
behavior that same test exercises (its `deleteRun` stub always resolves, never rejects).

The two call sites that build a `deleteRun` differ in how much they insulate `deleteSession` from
a real error, which matters for whether the session record ends up deleted:

- **CLI `--delete`** (`runDeleteMode` in `packages/code/src/runtime.tsx`) wraps every call in a blanket
  `try { … return true } catch { return false }` — any run-delete failure, of any kind, becomes
  `false` rather than a rejection, so the cascade always reaches `store.delete` and the session
  record is always removed; the CLI then reports the successful trace count from the returned
  array.
- **The TUI session delete path** (`sessionControls.delete` in `packages/code/src/runtime.tsx`) passes
  `runClient.deleteRun` directly,
  with no additional catch. `deleteRun` itself (`packages/code/src/adapters/kernel-run-client.ts`)
  only swallows a `not_found` kernel error into `false`; any other error (e.g. a transport failure)
  still rejects — which means **on this path a non-`not_found` trace-delete failure aborts the
  cascade and the session record is left undeleted**, unlike the CLI path.

### 4.10 `resumeSession` — rehydrating a transcript from persisted `RunDetail`s

`packages/code/src/adapters/session.ts:504-662`. High-level shape, in the order the code runs it:

1. **Reserve budget for `meta.pending`** (unflushed observations) first (`:534`), since
   `createSession` will later prepend them to the reconstructed chain (comment at `:531-533`).
2. **Walk conversation turns backwards in concurrency-`FETCH_CONCURRENCY`(6) batches**, skipping
   every `kind: "transcript"` turn and fetching each conversation's `RunDetail` via
   `deps.getRun(executionId)`, until either every conversation has been visited or a batch produces one whose
   `RunDetail.continue_from` is absent (`:580-585`, `fetchBatch` at `:536-578`). That turn is the
   **reset point** (`foundReset = true; resetIdx = index`, `:573-576`) — everything before it is
   provably superfluous because a non-continued run replaces the accumulated history outright
   (doc comment `:473-482`). The stop is checked once per whole batch, not per turn, so up to
   `FETCH_CONCURRENCY - 1` turns older than the reset can be fetched needlessly — a bounded,
   constant-size overfetch, not one that grows with session length (same doc comment).
3. Within the conversation-only "keep history" span (from the newest conversation back to and
   including the reset point), each batch's projection additionally calls `reserveHistory`, which throws
   `SessionResumeLimitError("messages", ...)` or `SessionResumeLimitError("payload_chars", ...)`
   (`:403-417`) the instant the running totals would exceed `SESSION_RESUME_MAX_MESSAGES` (10,000)
   or `SESSION_RESUME_MAX_PAYLOAD_CHARS` (16,000,000) — **before** fetching the next batch
   (`packages/code/tests/component/session.test.ts:724-756`, asserting exactly 18 of 30 turns were
   fetched and zero turns were rendered once the limit tripped: the whole projection is atomic on
   failure).
4. **A second, independent pass** fills in every turn kind inside the visual render window
   (`windowStart = turns.length - renderWindow`, `:499-500`) that fall *before* the reset point and
   were not already visited by the backward walk (`:587-591`) — because those turns need their
   `events` for display even though their history contributes nothing to the continuation chain.
5. **Final single pass over every turn in order** (`:597-642`) calls `deps.renderTurn` for each:
   - A conversation turn whose projection is present and at/after `resetIdx` contributes its `history.messages`
     (accumulated if it carried `continue_from`, or replacing the chain outright if it did not,
     `:606-607`) plus its assistant content, to the returned `messages`.
   - A transcript turn is rendered from its canonical `userPreview` and events when resident, but
     never contributes its internal run messages, assistant result or `active_task` to continuation.
   - A turn outside the render window (`collapsed = idx < windowStart`) is still rendered (with
     `collapsed: true` and no events) but is counted in `resumed.collapsed`, never in `degraded`.
   - A turn that was `visited` (a fetch was attempted) but has no projection (`getRun` returned
     `null`) is `degraded`, with a reason chosen by `turn.status`: `"interrupted"` if the turn's own
     persisted status was still `"running"`, else `"trace_pruned"` if it had an `executionId` (the
     trace existed once but is now gone), else `"trace_unavailable"` (no `executionId` was ever
     recorded) — `:621-627`.
   - A turn neither visited nor windowed (older than both the reset point and the render window,
     and the reset point already terminated the backward walk) is simply `collapsed` — never
     `degraded` — because collapsing is a display choice about turns known to be intact
     (`:634-640`, and doc comment `:369-374` distinguishing `collapsed` from `degraded`).
6. `newestActiveTask` tracks the highest-index **conversation** turn whose
   `RunDetail.active_task` is defined and is returned as `resumed.activeTask` —
   used so a continued run can recover which external task was bound even if that turn's own
   history was not retained (`:644-649`).

**Invariant proven by test, not merely asserted in a comment:** a `collapsed` turn and a `degraded`
turn are mutually exclusive and their counts never overlap —
`packages/code/tests/component/session.test.ts:590-609` ("resumeSession counts a folded-but-pruned
turn as degraded only, never as both") constructs a turn that is *both* outside the render window
*and* has a pruned trace, and asserts it counts only toward `degraded`, with
`resumed.collapsed + resumed.degraded.length` equal to the total non-rendered-with-events turn
count. The kind split is pinned by `packages/code/tests/component/session.test.ts`
("resumeSession renders transcript-only runs without adding them to continuation").

`RunRecovery` (crash-journal reconstruction counts on a `RunDetail`, `packages/protocol/src/runs.ts:196-204`)
is threaded through to `renderTurn` only for turns inside the render window, and is explicitly *not*
a `degraded` marker — a recovered turn replays normally with its (possibly incomplete) events, it is
only the record that is flagged incomplete (`packages/code/src/adapters/session.ts:377-385`;
pinned by `packages/code/tests/component/session.test.ts:545-574`).

### 4.11 What a resumed transcript recovers when a run was interrupted mid-turn

`buildRecoveredContext` (`packages/code/src/adapters/session.ts:290-333`) is called (inside `fetchBatch`, `:567-568`) as the
fallback assistant content for a turn whose `RunResult` did not produce one (i.e. the run was
interrupted before finishing). It is built entirely from the turn's own persisted `events` and
`plan_ref` — **not** from a reconstructed plan document (plan documents never enter the trace, per
the doc comment `:284-287`) — and surfaces: every accepted `elicitation_resolved` event with a
non-empty answer, as a "do not re-ask" list (`:296-306`); and, if the run's `plan_ref.status` is not
`"completed"`, a note naming the plan's provider/id/(path) and instructing the resumed run to
`read_plan` it back rather than trust a stale snapshot — with an extra warning line if the
currently-selected plan provider differs from `plan_ref.provider_key` (`:308-322`).

### 4.12 What is live-only and therefore absent from a rehydrated session

The engine trace (read on rehydration, mapped by `engineEventToProto`,
`packages/kernel/src/runs/map-events.ts:389`) and the loop's capability channel (live-only, mapped
by `capabilityEventToProto`, `packages/kernel/src/runs/map-events.ts:335`) are two distinct sources a client receives events
from; **rehydration reads only the persisted trace**, per the doc remark on `engineEventToProto`
("any event a rehydrated session must show has to be mapped here, since rehydration reads only the
persisted trace", `packages/kernel/src/runs/map-events.ts:378-379`). Concretely, in this repository's `code` client:

- **The plan overlay/sidebar/inline block is live-only.** `packages/code/src/adapters/store.ts:1454-1456`:
  "Plan capability events are intentionally live-only, so the stored trace replay cannot regenerate
  this node." The transcript-reconciliation code explicitly retains the *prior* live plan node at
  its old position across a trace replay rather than trying to rebuild it (`packages/code/src/adapters/store.ts:1447-1471`).
  `packages/code/src/adapters/activity-store.ts:286-288` states the same for the activity-store's
  plan projection: "Capability events are live-only and therefore absent from the stored trace used
  for the end-of-run replay," and the code keeps whatever plan state the live stream already
  delivered rather than clearing it on replay (`packages/code/src/adapters/activity-store.ts:290-291`).
- **`appendRunFailure` (the live path's inline error node) never reaches a rehydrated run** — a
  restored run instead gets whatever the persisted `run_ended` event's `code` field carries, via
  `engineEventToProto`'s mapping of `run_ended` (`packages/kernel/src/runs/map-events.ts:403-410`); `packages/code/src/adapters/store.ts:1399-1403`
  states this directly ("`appendRunFailure` ... is a runtime append that never reaches
  [rehydration]. The trace does carry the failure's code, so a restored run says why it ended
  rather than only that it did.").
- Any event a mapper does not recognize is dropped with a rate-limited `debug` log
  (`reportUnmapped`, `packages/kernel/src/runs/map-events.ts:50-69`) rather than surfaced to the client at all — the doc
  comment names this "the documented rehydration hazard made visible" (`:42-48`): a format skew
  between the writer and the reader silently deletes events from a restored session with no signal
  at either end (log-only, sampled). The sampling is a **module-level** `createSampler()` instance
  (`sampleUnmapped`, `packages/kernel/src/runs/map-events.ts:32`), keyed by `` `${path}\0${capability ?? ""}\0${kind}` `` — one
  budget per distinct `(path, capability, kind)` triple, shared across every rehydration in the
  process, not reset per run or per session. It is not a first-few-then-silence cutoff: `createSampler`
  admits the first 8 occurrences of a key and then only every power of two thereafter
  (`packages/capability/src/log.ts:250-260`), so a long-lived format skew keeps producing
  exponentially rarer log lines rather than none at all — but on any single short rehydration pass,
  a key with more than 8 dropped events past the first 8 still produces no further signal until the
  16th, 32nd, ... occurrence.

This document does not re-derive the full per-event-type mapping table (which events map to which
`RunEvent`, and which engine-internal types like `convergence_warning`/`guard_escalation` are
deliberately unmapped) — that belongs to [hosts/kernel-runs.md](kernel-runs.md). What this document asserts is
only the *architectural* fact used above: the trace is what rehydration reads, the capability
channel is not, and at least the plan surfaces and the live-only error node are consequences of that
split, demonstrated directly in the `code` client's own reconciliation code.

### 4.13 `createSession` — the code-side turn tracker

`packages/code/src/adapters/session.ts` builds the in-memory `Session` handle that mirrors
`SessionMeta` into the live run loop and saves it to `deps.store` after every mutation. Its methods
are not a passive DTO: they are the mechanism that produces the persisted record
`session-service.ts` stores and the counterpart (`restoreHistory`) that re-arms a resumed session.

- **`beginTurn(content, executionId)`** seeds `meta` on the first turn or appends a running
  `kind: "conversation"` turn, pushes the user message onto `history`, advances
  `continuationBase`, and returns the previous **conversation** execution id. Initialization likewise
  scans backward for the newest conversation turn, skipping transcript turns. Pinned by
  `packages/code/tests/component/session.test.ts` ("beginTurn returns the previous turn's executionId
  as the continuation base").
- **`beginTranscriptTurn(display, executionId)`** appends a running `kind: "transcript"` turn for a
  separately invoked run without pushing its internal prompt into history or changing
  `continuationBase`; **`endTranscriptTurn`** settles that exact kind without appending its assistant
  result. Both kinds still contribute usage totals once. Pinned by
  `packages/code/tests/component/session.test.ts` ("transcript-only runs are canonical without
  becoming continuation context").
- **`endTurn(envelope)`** is the live conversation completion path: it sets the turn's
  `status` via `runStatusToNode` (see below), records a redacted and bounded copy of
  `envelope.error` on the turn via `redactTurnError` (or clears it on a later success), appends the
  assistant message if the envelope produced one, and folds
  `envelope.usage` into `meta.totals` via `addUsageToTotals` **exactly once per `executionId`** — a
  module-scoped `counted` set (`packages/code/src/adapters/session.ts:99,155-158`) guards a turn that is reconciled again from
  double-counting. Pinned by "a failed turn records why, and a later success clears it"
  (`packages/code/tests/component/session.test.ts:151-169`) and "createSession accumulates a multi-turn Message[] and totals"
  (`packages/code/tests/component/session.test.ts:170-196`).
- **`lastTurnFor(executionId, kind)`** scans backward for an exact kind and, when present, execution
  id. It returns `undefined` rather than falling back to the newest unrelated turn; this prevents a
  transcript run from settling a conversation turn or vice versa. Production:
  `packages/code/src/adapters/session.ts` (`lastTurnFor`, `finishTurn`).
- **`reconcile(stored)`** (`packages/code/src/adapters/session.ts:167-183`) is the independent re-derivation path used when a
  live `envelope` was never observed (e.g. a turn resumed from a stored `RunDetail`): it re-derives
  `status` from the stored record's own `result?.ended_reason` and folds `stored.result?.usage`
  through the **same** `counted`-set guard, so a turn already counted by `endTurn` is not double
  counted by a later `reconcile`, and a turn whose `endTurn` never saw a usable envelope still gets
  counted once here. Pinned by "reconcile does not double-count an already-counted turn"
  (`packages/code/tests/component/session.test.ts:272-280`) and "reconcile counts a turn whose endTurn had no envelope (error path)"
  (`packages/code/tests/component/session.test.ts:281-288`).
- **`appendObservation(content, role?)`** (`packages/code/src/adapters/session.ts:192-204`) and **`takePending()`**
  (`packages/code/src/adapters/session.ts:206-214`) stage messages that are not yet part of a turn: `appendObservation` pushes
  onto both `history` and a `pending` buffer and persists `meta.pending` immediately, so an
  unconsumed observation survives a quit/resume cycle via the persisted `Session.pending` field;
  `takePending` drains the in-memory buffer and clears `meta.pending` once a caller has consumed it.
  Pinned by "appendObservation buffers a framed digest into history without becoming the continuation
  base" (`packages/code/tests/component/session.test.ts:771-792`), "pending observations survive quit/resume via the persisted meta"
  (`packages/code/tests/component/session.test.ts:793-823`), and "appendObservation with a user role queues a user message for the
  next run" (`packages/code/tests/component/session.test.ts:824-838`).
- **`releaseHistory()`/`restoreHistory(messages)`/`hasCompleteHistory()`** (`packages/code/src/adapters/session.ts:220-228`, plus
  the `historyComplete` flag read at `packages/code/src/adapters/session.ts:233`) gate whether the in-memory `history` array is
  the authoritative full-wire chain: `releaseHistory` empties it and marks it incomplete once its run
  trace is durably readable elsewhere, and `restoreHistory` is the counterpart `resumeSession` calls
  to re-arm a session with a reconstructed chain, marking it complete again. Pinned by "releaseHistory
  drops only the reconstructible message chain and restoreHistory rearms it"
  (`packages/code/tests/component/session.test.ts:197-220`).

Two helpers `endTurn`/`reconcile` both call, from `session-store.ts`, are load-bearing enough to
belong here rather than only in §3:

- **`runStatusToNode(status, endedReason?)`** (`packages/code/src/adapters/session-store.ts:72-83`) is
  the explicit state-transition table from a protocol `RunStatus` to the code-side `NodeStatus`:
  `completed → done`, `cancelled → cancelled`, `running → running`, and every other status
  (`failed`, in practice) `→ error` — **except** a `failed` status whose `ended_reason` is
  `"soft_limit_declined"`, which maps to `cancelled` instead of `error`. Pinned by "status
  normalization tables" (`packages/code/tests/component/session-store.test.ts:425-430`), which asserts
  all five cases including the `soft_limit_declined` special case.
- **`redactTurnError(error, opts?)`** (`packages/code/src/adapters/session-store.ts`) preserves the
  error code, applies the shared error-message sanitizer unless redaction was explicitly disabled,
  and truncates the message to `TURN_ERROR_MAX_CHARS` (2,000) by default. Newlines are preserved,
  and the stored in-memory value is the same bounded value later serialized to disk. Test:
  `packages/code/tests/component/session-store.test.ts` (`redactTurnError` masking, newline, bound,
  and opt-out cases) and `packages/code/tests/component/session.test.ts` (producer persistence).
- **`addUsageToTotals(totals, usage, priceFor?)`** is the sole path that mutates a session's
  `totals`: per-agent detail adds raw input/output/cached counts, while a flat-only compatibility
  result adds its input/output and permanently removes `cached` when positive input omitted the
  split. Once unknown, later known runs cannot turn the partial cached subset back into a complete
  total. Only when `priceFor` resolves a `CatalogCost` for a detailed agent does it
  accumulate `totals.costUsd` by pricing **fresh** input (gross input minus cached, floored at zero)
  at the model's input rate, cached tokens at its `cache_read` rate (falling back to `input`), and
  cache-write tokens at its `cache_write` rate (falling back to `input`) — so a cached token is never
  billed at both the input and cache-read rate. `uncachedInput(totals)` is the display-side
  counterpart: it subtracts only a complete numeric cached total; otherwise it returns gross input.
  Production: `packages/code/src/adapters/session-store.ts` (`addUsageToTotals`, `uncachedInput`) and
  `packages/code/src/adapters/session.ts` (`finishTurn`, `reconcile`). Tests:
  `packages/code/tests/component/session-store.test.ts` (per-agent sums, flat unknown split, net/gross
  display and cost cases) and `packages/code/tests/component/session.test.ts` (missing split at live
  settlement and stored reconciliation).
- **`redactPreview(text, opts?)`** (`packages/code/src/adapters/session-store.ts:118-124`) is what produces every persisted
  `Session.title` and `SessionTurn.user_preview` (called from `beginTurn` above): it takes only
  `text`'s first line, masks secret-shaped substrings via `sanitizeText` (unless `redact: false`), and
  truncates to `opts.max` (default 200; `beginTurn` passes 80 for `title`) with an ellipsis glyph —
  **redaction runs before truncation**, specifically so a preview cut at the character limit can never
  retain a prefix of a secret the truncation would otherwise have cut into. Previews already on disk
  are never re-redacted. Pinned by "redactPreview masks secrets, keeps first line, truncates"
  (`packages/code/tests/component/session-store.test.ts:319-328`), "redactPreview applies the canonical rules a local pattern list
  used to miss" (`:332-347`), "redactPreview names the vendor a masked token belongs to" (`:348-355`),
  and "redactPreview redacts before truncating" (`:356-362`).

### 4.14 `buildSkillRunDigest` — tagging a `/skill` run's result

`packages/code/src/adapters/session.ts:257-280` builds the text a lead agent sees after it dispatched
a `/skill` run: a `[/name → agent, exec id]` tag (execution id present only when either `envelope` or
`stored` carries one) followed by a three-tier fallback body — the live/stored textual result
(`resultToContent`), or, when the run produced none, the same `buildRecoveredContext` salvage §4.11
describes (`:267-271`), or, when neither exists, a bare `"<tag> <status> with no textual result."`
line. Pinned by "buildSkillRunDigest tags the result with the skill, its agent and the execution id"
(`packages/code/tests/component/session.test.ts:839-849`) and "buildSkillRunDigest falls back to the
recovered-context salvage when there is no result" (`packages/code/tests/component/session.test.ts:850-862`).

The `/skill` run itself is separately persisted as a transcript-only turn; the digest is a pending
observation delivered to the next conversation, not evidence that the skill run became the provider
continuation base.

## 5. Invariants

1. **A session's project/workspace scope is checked twice on every path that returns or accepts a
   session: once on read (`readOne`), once on save.** `save` rejects a foreign project/workspace
   before either file is written; `readOne` and `readSummary` both discard a document/sidecar whose
   `project_id`/`workspace` do not match the service's own.
   Production: `packages/kernel/src/sessions/session-service.ts:360-364,384-390,557-562`.
   Test: `packages/kernel/tests/integration/session-service.test.ts:279-291` ("rejects sessions for
   another workspace before writing either document").

2. **Owners are isolated by directory, not by a check inside a shared file.** Two `SessionService`s
   built with different `owner` values over the same `dir` never see each other's sessions.
   Production: `packages/kernel/src/sessions/session-service.ts:344` (`ownerDir` includes `ownerSegment(opts.owner)`).
   Test: `packages/kernel/tests/integration/session-service.test.ts:340-356` ("owners are isolated").

3. **`listPage`'s cursor is a `(updated_at, id)` pair, and `afterCursor` orders strictly by that pair
   in the same direction `compareSummaries` sorts pages** — so paging never repeats or skips a row
   at a page boundary as long as no row's `updated_at`/`id` changes between pages. The `id` tiebreak
   is not an arbitrary lexicographic fallback: a session's `id` is minted by the code-side
   `uuidv7()` (`packages/code/src/adapters/session-store.ts:86-100`), whose first 48 bits are a
   millisecond timestamp, so id-descending on an `updated_at` tie already orders newest-created
   first — the same direction `updated_at` itself sorts in. Pinned by "uuidv7 has version 7 and
   variant bits" (`packages/code/tests/component/session-store.test.ts:68-71`).
   Production: `packages/kernel/src/sessions/session-service.ts:176-178,287-322`.
   Test: `packages/kernel/tests/integration/session-service.test.ts:61-81,95-124`.

4. **`retainSessionSummary` produces the exact top-K by `compareSummaries`, independent of input
   order**, using bounded `O(capacity)` heap space rather than retaining the whole catalog.
   Production: `packages/kernel/src/sessions/session-service.ts:187-253`.
   Test: `packages/kernel/tests/integration/session-service.test.ts:83-93`.

5. **A cursor over `CURSOR_MAX_BYTES` (256 raw bytes) or that fails to decode to a
   `[finite number, non-empty string]` pair is rejected with `invalid_request` before any directory
   scan happens.**
   Production: `packages/kernel/src/sessions/session-service.ts:293-314`.
   Test: `packages/kernel/tests/integration/session-service.test.ts:216-242`.

6. **A legacy full record is repaired into a bounded summary sidecar on first `listPage` read, but
   only if the derived summary itself fits `SESSION_SUMMARY_MAX_BYTES`; otherwise it is invisible to
   `listPage` (never truncated) until repaired by hand.**
   Production: `packages/kernel/src/sessions/session-service.ts:392-413`.
   Test: `packages/kernel/tests/integration/session-service.test.ts:143-182`.

7. **A corrupt or oversized sidecar is repaired from the authoritative full document, never trusted
   as-is; the full document alone is authoritative.**
   Production: `packages/kernel/src/sessions/session-service.ts:377-391`.
   Test: `packages/kernel/tests/integration/session-service.test.ts:184-201,293-306`.

8. **`list()` (the unbounded legacy method) throws `resource_exhausted` rather than silently
   truncating once either 200 full records or 32 MiB of file bytes have been retained**, and directs
   the caller to `listPage()` instead.
   Production: `packages/kernel/src/sessions/session-service.ts:495-499,507-511`.
   Test: `packages/kernel/tests/integration/session-service.test.ts:308-324`.

9. **A transport-level `AbortSignal` reaches `listPage`'s cooperative scan unchanged** (INV-218) —
   full statement owned by [hosts/kernel-transport.md](kernel-transport.md) §5. This
   item's own corroborating evidence that the service *itself* honors the abort mid-scan:
   `packages/kernel/tests/integration/session-service.test.ts:126-141`.

10. **Every write is preflighted for JSON size without invoking `JSON.stringify`, and a value with a
    `toJSON` method, a `bigint`, or nesting past 128 levels is rejected rather than silently
    expanded or crashing.**
    Production: `packages/kernel/src/sessions/session-service.ts:82-132`.
    Test: `packages/kernel/tests/integration/session-service.test.ts:244-277`.

11. **`save` invalidates the old summary sidecar before writing either new file**, so the worst a
    crash mid-save can leave behind is a *missing* sidecar (which `listPage` repairs from the
    authoritative document) — never a valid-looking but stale one.
    Production: `packages/kernel/src/sessions/session-service.ts:570-578` (doc comment states the reasoning explicitly).
    Test: unpinned — no test in `session-service.test.ts` kills the process between the unlink and
    the two subsequent writes to observe the intermediate state; the ordering itself is exercised
    only as an implementation detail of every passing `save` call.

12. **`deleteSession` deletes every turn's run trace sequentially, in turn order, and reaches the
    session-record deletion only if none of those per-turn `deleteRun` calls rejects** — a rejection
    aborts the cascade before `store.delete` runs, leaving the session record intact. Whether a
    given failure surfaces to `deleteSession` as a rejection or as a resolved `false` is entirely a
    property of the `deleteRun` closure the *caller* supplies (see §4.9): the CLI call site in
    `packages/code/src/runtime.tsx` catches every error into `false` (so the session record is always
    removed there), while the TUI session-controls path passes `kernel-run-client.ts`'s `deleteRun`
    directly, which only swallows `not_found`.
    Production: `deleteSession` in `packages/code/src/adapters/session.ts`; `runDeleteMode` and
    `sessionControls.delete` in `packages/code/src/runtime.tsx`; `deleteRun` in
    `packages/code/src/adapters/kernel-run-client.ts`.
    Test: `packages/code/tests/component/session.test.ts` ("deleteSession removes the session file
    and cascades delete_run per turn" and "deleteSession records a missing trace and still removes
    the session", and "deleteSession preserves the session when a trace deletion rejects") pins
    sequential order, resolved `true`/`false`, and rejection behavior.

13. **`resumeSession` never re-derives history from a conversation turn older than the first
    conversation turn (walking backwards) whose `RunDetail.continue_from` is absent** — that turn's `messages` replace the
    accumulated chain outright, and no older turn is fetched for history purposes (only, possibly,
    for its events if inside the render window).
    Production: `packages/code/src/adapters/session.ts:574-577,606-607`.
    Test: `packages/code/tests/component/session.test.ts:480-510` ("resumeSession stops fetching
    once it reaches a turn that carries no continue_from" — asserts exactly 6 of 14 turns are
    fetched).

14. **A turn is never simultaneously `collapsed` and `degraded`.**
    Production: `packages/code/src/adapters/session.ts:610-652`.
    Test: `packages/code/tests/component/session.test.ts:576-609` (two tests: "never marks a folded
    turn as degraded" and "counts a folded-but-pruned turn as degraded only, never as both").

15. **`resumeSession` throws before rendering anything, and before fetching further batches, the
    instant its running message count or payload character count would exceed
    `SESSION_RESUME_MAX_MESSAGES`/`SESSION_RESUME_MAX_PAYLOAD_CHARS`** — it never allocates or
    returns a silently truncated context.
    Production: `packages/code/src/adapters/session.ts:404-418,510-529`.
    Test: `packages/code/tests/component/session.test.ts:724-756`.

16. **`resumeSession` releases each batch's fetched `RunDetail` objects before requesting the next
    batch**, bounding peak retained trace memory by `FETCH_CONCURRENCY` regardless of session
    length.
    Production: `packages/code/src/adapters/session.ts:547-589` (doc comment `:493-496`).
    Test: `packages/code/tests/component/session.test.ts:667-716` (`WeakRef` + `Bun.gc(true)`
    assertion that no first-batch `RunDetail` survives once the second batch starts, plus
    `maxInFlight <= 6`).

17. **Plan-capability-projected transcript/activity state is intentionally absent from the engine
    trace and therefore cannot be reconstructed by rehydration** — the live client instead retains
    whatever plan state it already had rather than clearing or rebuilding it from replay.
    Production: `packages/code/src/adapters/store.ts:1447-1471` (esp. `:1454-1456`),
    `packages/code/src/adapters/activity-store.ts:275-292` (esp. `:286-291`).
    Test: unpinned in this document's scope — no test file under `packages/kernel/tests` or
    `packages/code/tests` matching `session*`/`map-events*` was found asserting this retention
    behavior directly; it is asserted only by the production doc comments cited. (A dedicated test
    for `store.ts`'s `endReconcile` plan-retention logic may exist under a differently-named test
    file outside this document's scope — see §8.)

18. **A failed turn's `{ code, message }` survives the code adapter, transport, and disk round trip,
    while malformed persisted error values are ignored; the producer masks and bounds the message
    before persistence.**
    Production: `redactTurnError`, `PersistedSessionTurn`, `persistedTurnError`, `metaToSession`, and
    `sessionToMeta` in `packages/code/src/adapters/session-store.ts`; `endTurn` in
    `packages/code/src/adapters/session.ts`.
    Test: `packages/code/tests/component/session-store.test.ts` (failed-turn round trip, reload,
    malformed-value rejection, and sanitizer/bound cases) and
    `packages/code/tests/component/session.test.ts` (failed-turn producer cases).

19. **Environment history is snapshot identity, never implicit activation.** A full session turn
    persists only `{id, fingerprint}`; the bounded sidecar projects the newest value as
    `last_environment`; loading or resuming the session does not select that Environment. A host may
    compare it with its current snapshot and warn, as [code-run-host.md](code-run-host.md) specifies.
    Production: `packages/protocol/src/sessions.ts` (`SessionTurn`, `SessionSummary`),
    `packages/kernel/src/sessions/session-service.ts` (`toSummary`), and
    `packages/code/src/adapters/session-store.ts` (`metaToSession`, `sessionToMeta`,
    `sessionSummaryToMeta`). Test: `packages/kernel/tests/integration/session-service.test.ts`
    ("projects the newest Environment identity into the bounded summary") and
    `packages/code/tests/component/session-store.test.ts` ("Environment identity round-trips on
    turns and bounded summaries").

20. **Every persisted turn has an explicit continuation role; stale undiscriminated turns are
    rejected.** `kind: "conversation"` is the only variant that can rebuild or advance provider
    continuation. `kind: "transcript"` remains canonical for display, export, status and totals but
    never contributes its internal prompt/result or active-task binding to model history. Missing or
    unknown `kind` throws during `sessionToMeta` rather than receiving a legacy default.
    Production: `packages/protocol/src/sessions.ts` (`SessionTurnKind`, `SessionTurn`),
    `packages/code/src/adapters/session-store.ts` (`persistedTurnKind`, `metaToSession`,
    `sessionToMeta`), and `packages/code/src/adapters/session.ts` (`beginTurn`,
    `beginTranscriptTurn`, `finishTurn`, `resumeSession`). Test:
    `packages/code/tests/component/session-store.test.ts` ("transcript-only turn identity is persisted
    and stale undiscriminated turns are rejected") and
    `packages/code/tests/component/session.test.ts` ("transcript-only runs are canonical without
    becoming continuation context", "resumeSession renders transcript-only runs without adding them
    to continuation").

21. **Session cache totals never turn missing telemetry into a zero hit rate.** `cached: 0` means
    every contributing positive-input run reported a measured zero; an omitted split removes the
    optional cumulative field permanently, survives persistence/resume, makes `uncachedInput` return
    gross input, and suppresses any derived rate. Production:
    `packages/protocol/src/sessions.ts` (`SessionTotals`),
    `packages/code/src/adapters/session-store.ts` (`SessionTotals`, `addUsageToTotals`,
    `uncachedInput`, session converters), and `packages/code/src/adapters/session.ts` (`finishTurn`,
    `reconcile`). Tests: `packages/protocol/tests/contract/public-contract.fixture.ts`
    (`unknownCacheSessionTotals`), `packages/code/tests/component/session-store.test.ts` (unknown
    split persistence and aggregation), and `packages/code/tests/component/session.test.ts` (live
    settlement and stored reconciliation without cache detail).

## 6. Failure modes and degradation

| Condition | Handling | Cite |
|---|---|---|
| Owner directory missing | `listPage`/`list` return empty, not an error | `packages/kernel/src/sessions/session-service.ts:420-424` (`opendirSync` catch) |
| Directory entry unreadable mid-scan (`readSync` throws) | Scan stops (returns) rather than throwing | `packages/kernel/src/sessions/session-service.ts:428-432` |
| A `.json` file over `SESSION_MAX_BYTES` | `readOne` returns `null` (skipped) | `packages/kernel/src/sessions/session-service.ts:358` |
| A `.json` file fails to parse, or parses to a non-`Session` shape | `readOne` returns `null` | `packages/kernel/src/sessions/session-service.ts:359-364` (caught by the enclosing `try`) |
| A session belongs to a different `project_id`/`workspace` | Read as absent (`readOne`/`readSummary`), write rejected `invalid_request` (`save`) | `packages/kernel/src/sessions/session-service.ts:360-364,384-390,557-562` |
| A full turn has missing or unknown `kind` | `sessionToMeta` throws `"session turn kind is required"`; resume/load stops rather than guessing continuation semantics | `packages/code/src/adapters/session-store.ts` (`persistedTurnKind`, `sessionToMeta`) |
| Cursor over 256 bytes or malformed | `invalid_request`, before scanning | `packages/kernel/src/sessions/session-service.ts:295-314` |
| `listPage` limit `<1`, `>200`, or non-integer | `invalid_request` | `packages/kernel/src/sessions/session-service.ts:451-453` |
| `list()` crosses 200 records or 32 MiB | `resource_exhausted`, telling the caller to use `listPage` | `packages/kernel/src/sessions/session-service.ts:495-499,507-511` |
| A session document (or summary) fails the size preflight | `resource_exhausted` on `save` | `packages/kernel/src/sessions/session-service.ts:135,563-567` |
| Transport cancellation during a `listPage` scan | `cancelled`, thrown from inside the scan loop | `packages/kernel/src/sessions/session-service.ts:259-263,458-470` |
| Summary sidecar corrupt/oversized/wrong-shape | Silently rebuilt from the authoritative full document; a rebuild failure to persist (e.g. read-only fs) is swallowed and does not fail the read | `packages/kernel/src/sessions/session-service.ts:391,407-412` |
| `delete(id)` on an already-deleted session | Returns `false`; the (already-absent) summary unlink error is separately swallowed | `packages/kernel/src/sessions/session-service.ts:588-599` |
| A turn's run trace is gone by the time `resumeSession` looks for it | Turn is rendered `degraded` with a reason distinguishing `interrupted`/`trace_pruned`/`trace_unavailable`; the session as a whole still resumes | `packages/code/src/adapters/session.ts:632-644` |
| A turn's `RunDetail` was reconstructed from a damaged crash journal | Turn replays normally; `recovery` counts are surfaced beside its (possibly incomplete) events, never withheld | `packages/code/src/adapters/session.ts:377-385` |
| Newest persisted Environment differs from the active kernel snapshot | Session data remains readable and resume continues; the TUI surfaces the mismatch without changing either snapshot | [code-run-host.md](code-run-host.md) (`loadSessionMeta`) |
| Resume history exceeds message/char limits | Hard failure (`SessionResumeLimitError`, `code: "resource_exhausted"`) before rendering anything, rather than truncating context silently | `packages/code/src/adapters/session.ts:404-418` |
| An individual trace-delete resolves `false` (e.g. `not_found`) during `deleteSession` | Recorded as `{ executionId, deleted: false }`; the cascade continues and the session record is still deleted | `packages/code/src/adapters/session.ts:674-681`; `packages/code/tests/component/session.test.ts` ("records a missing trace") |
| An individual trace-delete *rejects* during `deleteSession`, and the caller's `deleteRun` does not catch it | The rejection propagates out of `deleteSession`; the cascade stops and the session record is **not** deleted | `deleteSession` in `packages/code/src/adapters/session.ts` (no try/catch), TUI `sessionControls.delete` in `packages/code/src/runtime.tsx`, `deleteRun` in `packages/code/src/adapters/kernel-run-client.ts`, and `packages/code/tests/component/session.test.ts` ("preserves the session") |
| An individual trace-delete rejects, but the caller's `deleteRun` catches every error into `false` | Cascade continues as if the delete had simply failed; session record is still deleted | CLI `runDeleteMode` in `packages/code/src/runtime.tsx` |
| An event reaches a mapper with no recognized projection (rehydration or live) | Dropped; a rate-limited `debug` log names the path/kind/capability/reason, but nothing is sent to the client | `packages/kernel/src/runs/map-events.ts:50-69,397-402,676-679` |

## 7. Coupling

- **`createSessionService` depends on `@clarvis/paths`** (`globalPaths`, `ownerSegment`,
  `writeFileAtomicSync`) for every path it computes and every write it performs
  (`packages/kernel/src/sessions/session-service.ts:12`) — a static import; changing `@clarvis/paths`' segment-encoding or atomic
  write semantics changes this subsystem's on-disk safety without this file changing.
- **`createSessionService` depends on `@clarvis/capability` only for `Logger`/`NOOP_LOGGER`**
  (`packages/kernel/src/sessions/session-service.ts:14`) — the diagnostic surface, not a behavioral one.
- **The kernel constructs one `SessionService` per owner**, via
  `createSessionService({ dir: globalDir, owner: scope.owner, projectId: scope.projectId,
  workspaceId: scope.workspaceId, logger: runLogger })` in `packages/kernel/src/kernel.ts:439-444` —
  this is the registration point that forces the project/workspace scope check in §5's invariant 1:
  the service is *handed* the scope it will enforce, it does not discover it.
  `packages/kernel/src/file-kernel.ts` does not build this per-owner service itself; it reaches
  `kernel.ts`'s builder only indirectly, through `createInProcessKernel` (imported at
  `packages/kernel/src/file-kernel.ts:68`, called at `packages/kernel/src/file-kernel.ts:829`).
- **The transport layer (`packages/kernel/src/transport/operations.ts`) depends on the file-backed
  service's *widened* `listPage` shape**, not just the protocol `SessionService` interface, via the
  locally-cast `SignalAwareSessionListPage` type (`packages/kernel/src/transport/operations.ts:115-128`) — a structural,
  compile-time-only coupling (a duck-typed cast, not an imported type) that a test
  (`packages/kernel/tests/contract/transport-codecs.test.ts:147-160`) is the only thing verifying still holds against the real
  service.
- **`packages/code/src/adapters/session.ts`'s `resumeSession`/`deleteSession` depend only on the
  small `ResumeDeps`/`deleteRun` function-shaped parameters they are given** (`packages/code/src/adapters/session.ts:360-388`,
  `:662`) — not on `@clarvis/kernel` or `SessionService` directly. The kernel-shaped `getRun`,
  `deleteRun` and `sessions` bindings are supplied by `packages/code/src/run-host.ts` and
  `packages/code/src/runtime.tsx`, which is how a remote kernel would need no change to this file: it
  never imports a kernel type, only protocol DTOs (`Message`, `RunDetail`, `RunEvent`, `RunResult`,
  `ActiveTaskBindingDto`, `PlanRef`, `RunRecovery`, from `@clarvis/protocol`, `packages/code/src/adapters/session.ts:1-10`).
- **`packages/code/src/adapters/session-store.ts`'s `SessionStore` is the only thing `deleteSession`
  and `resumeSession`'s callers hand a persisted `SessionMeta` through** — its own write-coalescing
  and LRU-demotion mechanics are [hosts/code-run-host.md](code-run-host.md)'s scope, but this document depends on its
  `save`/`delete`/`get` shape (`packages/code/src/adapters/session-store.ts:230-239`) as the storage side of both functions.
  The concrete client-side caller tying `SESSION_PAGE_MAX = 200` (§3's bounds table) to real client
  behavior is `loadSessions(sessions, owner)` (`packages/code/src/adapters/session-store.ts:382-388`), which seeds a
  `createSessionStore` cache with exactly one `sessions.listPage({ limit: 200 })` call — pinned by
  "loadSessions seeds bounded summaries and fetches a full document only on demand"
  (`packages/code/tests/component/session-store.test.ts:286-294`) and "loadSessions requests at most
  one 200-row catalog page" (`:295-307`). `listSessionsForWorkspace(store, workspace)`
  (`packages/code/src/adapters/session-store.ts:252-255`) is the workspace-scoping filter applied on top of that cache, pinned by
  "listSessionsForWorkspace filters by exact workspace" (`packages/code/tests/component/session-store.test.ts:308-318`).
- **`packages/kernel/src/runs/map-events.ts` is imported by nothing in this document's own scope
  directly** — the coupling runs the other way: `resumeSession` consumes already-mapped
  `RunEvent`s off a `RunDetail` (via `deps.getRun`, ultimately `KernelClient.runs.get`, which is
  [hosts/kernel-runs.md](kernel-runs.md)'s scope), so this document's only claim on `map-events.ts` is the
  architectural fact in §4.12 (trace-only rehydration), not any function call.
- **Nothing in `session-service.ts` or `session.ts` imports the trace store**
  (`@clarvis/trace`) directly — the coupling to what a `RunDetail` even contains is entirely through
  the `RunDetail`/`ResumeDeps.getRun` boundary, enforced by TypeScript's structural typing on
  `ResumeDeps` rather than by any import.

## 8. Open questions

- **Whether `save`'s unlink-then-write ordering (invariant 11) is exercised by a crash-injection
  test anywhere in the repository.** No such test was found in
  `packages/kernel/tests/integration/session-service.test.ts`; the ordering is asserted only by the
  production doc comment at `packages/kernel/src/sessions/session-service.ts:570-576`.
- **Whether `packages/code/src/adapters/store.ts`'s plan-retention-across-replay logic
  (`endReconcile`, cited in §4.12/§5 invariant 17) has a dedicated unit test.** This document's scope
  is `session-service.ts`, `map-events.ts`, `session.ts` and `session-store.ts`; `store.ts` itself
  belongs to a different document (likely [hosts/code-run-host.md](code-run-host.md)), and no test file within this
  item's own scope exercises it — its evidence here is the production code and comments only.
- **What determines `opts.owner`/`opts.projectId`/`opts.workspaceId` at the call site** (i.e. how a
  connection's `scope.owner` is derived) is [hosts/kernel-composition.md](kernel-composition.md)'s scope
  (`file-kernel.ts`/`kernel.ts` construction), not re-derived here beyond the two
  citations in §7 showing *where* `createSessionService` is invoked.
- **The exact wire/DTO validation the kernel's transport layer applies to a `sessions.save`
  payload before calling `services.sessions.save`** (i.e. whether malformed wire JSON is rejected
  before or only inside the service) is [hosts/kernel-transport.md](kernel-transport.md)'s scope; this document only
  describes what the service itself does once called.
- **Whether a session's `pending` messages (`Session.pending`) are ever pruned or capped
  independent of the whole-document `SESSION_MAX_BYTES` cap.** No code path in this document's scope
  applies a bound to `pending` specifically; it is charged only as part of the full document's
  8 MiB ceiling (`packages/kernel/src/sessions/session-service.ts:563-567`) and, on resume, as part of the same character/message
  budget as everything else (`packages/code/src/adapters/session.ts:545`). Whether this is deliberate or simply
  undifferentiated is not stated anywhere in the code.
