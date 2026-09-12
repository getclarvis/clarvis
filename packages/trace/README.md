# @clarvis/trace

Records and persists a Clarvis run's trace.

Successful `run_ended` events preserve the accepted `final` or `checkpoint` disposition. A missing
disposition retains ordinary final semantics. The mapper does not attach it to failed or cancelled
events; a saved stage must remain distinguishable when clients rebuild their transcript from disk.

## Contract

Trace vocabulary, recording, persistence, journal recovery, mapping, and retention are specified in
[`foundations/trace.md`](../../specs/foundations/trace.md). Diagnostic events remain governed by
[`cross-cutting/observability.md`](../../specs/cross-cutting/observability.md).

`@clarvis/capability` owns the trace **vocabulary** — the kinds, the detail map,
the `TracePort` a capability writes through, and `ExecutionRecord`. This package
owns the **implementation**:

|                                 |                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `TraceHandle`, `RecordingTrace` | the in-run recorder; satisfies `TracePort` structurally                                |
| `JsonTraceStore`                | the on-disk format sessions are rehydrated from                                        |
| `RunJournal`, journal recovery  | what makes a run that died mid-flight recoverable                                      |
| `mapEntry` / `mapEntryRaw`      | trace entry → persisted `TraceEvent`, consulting a capability projector registry first |
| `capDetail` and the caps        | the display bounds, shared with the mapper                                             |
| `TraceCleanup`                  | retention                                                                              |

File-kernel hosts retain traces for 30 days by default. Cleanup receives the execution ids still
referenced by persisted sessions and never removes those records, so age-based garbage collection
cannot break resumable conversation history. `CLARVIS_TRACE_TTL_DAYS=0` remains the explicit
opt-out.

No external dependencies — `node:fs`, `node:os`, `node:path` and `node:crypto`
only, over `@clarvis/capability` and `@clarvis/paths`. `@clarvis/loop` depends on
this package; nothing here may depend on the engine.

`TraceHandle` satisfies `TracePort` **structurally** — no adapter, no cast — so
the engine passes the handle straight through, exactly as `LiveContext` satisfies
`ContextPort`.

The minimal durable `tool_call_announced` contains actor, call identity, tool name, iteration and
attempt, never partial arguments or progress counters. All `tool_input_delta` reports are live
signals. Replay can therefore restore an announced call interrupted before execution without
persisting every delta. A durable `model_call_retry` retains its bounded failure message and closes
the prior attempt in clients; a client disconnect alone is not an execution outcome.

Free text is bounded as it enters the recording handle and bounded again in the mapper for legacy
or direct entries that bypassed it. In particular, `delegation_created.task` shares
`@clarvis/capability`'s 32,768-Unicode-character `delegate_task` ceiling, so one brief cannot be
multiplied unbounded across the retained trace, persisted event and UI projection.
An iteration's authoritative final model response has its own 2 MiB ceiling, aligned with the TUI's
per-node transcript retention. It deliberately does not share the 5,000-character tool-result cap:
otherwise the closing iteration event replaces a complete streamed answer with a truncated trace
summary before either persistence or presentation can make an honest display decision.
The iteration event also retains an optional bounded `response_phase` (`commentary` or
`final_answer`) so replayed clients can distinguish a progress update from a terminal answer without
duplicating opaque provider metadata into the trace.
An execution record may likewise carry optional host-owned `host_metadata`. The journal, recovery,
JSON store and in-memory test store round-trip it after deep sanitization without interpreting its
shape. The file kernel uses this narrow seam for the active Extension Profile's id and
fingerprint; the owning contract is
[`hosts/extension-profiles.md`](../../specs/hosts/extension-profiles.md).
Tool arguments additionally share a 64 Ki-character aggregate key/string budget, 4,096-entry
ceiling and depth 32. Those structural bounds complement the 10,000-character per-leaf cap: a very
wide object made of small values cannot bypass it, and cyclic/deep contributed detail is replaced
with an explicit truncation marker rather than overflowing the stack.

`mapEntry` accepts an immutable `PersistedTraceProjectorRegistry` from the host. A matching
capability-owned projector runs before built-in mapping and before the generic contributed-event
fallback; the resulting object then passes through the same deep secret sanitization as every
built-in event. An unknown contributed kind still persists as `{ type, occurred_at, detail }`, with
the normal detail caps, so adding typed projectors does not weaken forward-compatible journal
recovery. This package deliberately knows no contributed discriminator or detail shape.

Long-lived stores bound their derived state. At most 32 owner indexes are kept
in an LRU, and one index retains at most 50,000 ids; a lookup beyond that cache
falls back to a streaming directory scan, preserving correctness. Owner and
cross-owner listings retain only the requested newest `offset + limit` rows in
a fixed-size heap instead of repeatedly sorting every summary. One page is
capped at 200 rows and an offset at 10,000, so an untrusted transport request
cannot turn either listing into an arbitrary-size allocation. Cleanup similarly keeps only its oldest batch,
using a fixed-size heap, examines at most 10,000 directory entries per synchronous call, and resumes its
directory cursor on the next interval. The recurring sweeper deletes at most 10,000 entries in one run before
leaving the backlog for the next interval. Durable-session references are resolved before a pass;
an incomplete bounded reference scan skips destructive cleanup, and raw execution ids are encoded
at the filesystem-store boundary before filename comparison. Filesystem directory scans use
handles, avoiding `readdir` arrays proportional to trace history.

Stored execution bodies are `stat`ed before reading. The default admission limit is 128 MiB per
record and no caller may raise it above the 256 MiB hard maximum; insert serializes and checks the
same limit before writing. Summary sidecars are likewise bounded at 64 KiB. An oversized direct
lookup fails with a typed persistence error, while listings skip an oversized legacy fallback and
continue serving the rest of the page.

Crash recovery never reads a journal body wholesale. It parses 64 KiB chunks, retaining at most 20,000
events from a journal of at most 32 MiB; one boot examines at most 100 journals and admits at most 64 MiB
in total. Journal discovery also examines at most 10,000 root plus owner-directory entries, so millions of empty
owner directories or unrelated files cannot make startup recovery unbounded; unexamined journals remain
intact for a later pass. A journal that exceeds its per-file or parser bound is renamed with `.jsonl.oversized` and kept for
operator inspection, rather than repeatedly allocating it or deleting the only surviving trace. Corrupt
headers retain the existing `.jsonl.corrupt` quarantine. These are recovery bounds, not silent trace
truncation: an over-limit journal is never presented as a complete recovered run.

## What it reports to an operator

`createJsonTraceStore` and `resolveTraceStore` take an optional `logger`; the kernel passes
`logger.child({ component: "trace" })`. Nothing here logs per trace entry or per journal delta —
the store's own failures are what an operator cannot otherwise see, because they are failures of
the machinery rather than facts about a run and so have no place in the trace they are about
(`specs/cross-cutting/observability.md` §1.1).

| Level | `event`                              | Says                                                                                                    |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| error | `trace.insert_failed`                | a record was not persisted, and in which `phase` (`generation`/`lease`/`write`)                         |
| warn  | `trace.insert_aborted_deleted_owner` | the owner was deleted mid-write, so the partial record was rolled back                                  |
| warn  | `trace.record_unreadable`            | a listing dropped a row it still counts in `total`                                                      |
| warn  | `trace.journal_quarantined`          | a journal was set aside — and, when `renamed` is `false`, that it was not, so every boot re-examines it |
| warn  | `trace.journal_recovery_degraded`    | a recovered run is missing lines or carries synthesized tool results                                    |
| warn  | `trace.recovery_budget_exhausted`    | a bound stopped the pass; the journals it did not reach remain on disk                                  |
| info  | `trace.recovery_completed`           | the pass's whole outcome, once per boot                                                                 |
| debug | `trace.sidecar_write_failed`         | a listing sidecar was lost, so that row pays a full-record read forever                                 |
| debug | `trace.owner_index_evicted`          | an owner's cached id index is gone and its lookups now scan the directory                               |

`trace.journal_recovery_degraded` is only half of that fact. Its two counts also land **on the
record**, as an optional `recovery: { skipped_lines, synthesized_tool_calls }` set by
`journalToRecord` and persisted by the store — the crossing rule of `specs/cross-cutting/observability.md` §1.1, since
the person reading a restored run has no access to an operator's stderr. It is written only when a
count is non-zero, so an absent `recovery` keeps meaning "this record is intact", and the log line
reads its numbers off the record rather than deriving them a second time. The counts are all that is
kept: a skipped line's content never reaches the record.

`recoverOrphans` returns a `TraceRecoveryReport`, not a count: `0` alone could not tell "nothing to
recover" from "the budget blew halfway through the scan". `TraceStore.cleanup` takes an optional
`TraceCleanupCounters` out-parameter so the retention sweeper's one `info` line can name
`journals_removed` and `leases_reclaimed` beside `deleted`.

## Entry points

| Entry                    | Contents                                                                   |
| ------------------------ | -------------------------------------------------------------------------- |
| `@clarvis/trace`         | the recorder, the JSON store, the journal, the mapper, the caps, retention |
| `@clarvis/trace/testing` | `createMemoryTraceStore`, the in-memory `TraceStore` double                |

The double lives here rather than in the loop's `src/testing/` because a package
the loop depends on cannot import the loop's helpers, and it is an implementation
of _this_ package's interface. `@clarvis/loop`'s `testing/index.ts` re-exports it.

## Test ownership

The suite is classified by the highest effect boundary each file currently exercises:

| Level                | Owns                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/`        | Pure caps, mapping, journal parsing/folding/repair, span derivation, record assembly, execution ids, projector selection, and the in-memory recording state machine. |
| `tests/component/`   | `TraceCleanup` composed with fake or in-memory store collaborators, without a real filesystem boundary.                                                              |
| `tests/contract/`    | One reusable `TraceStore` conformance matrix applied to both the published in-memory double and the JSON implementation.                                             |
| `tests/integration/` | JSON-specific format/layout/reopen/corruption/locking behavior, journal I/O and crash recovery, retention, and store-factory wiring.                                 |
| `tests/helpers/`     | Contract-only record builders; helpers perform no effects or global mutation at import time.                                                                         |

There is no trace-owned architecture or end-to-end test at present. Cross-package run round-trips
remain with the package that composes the seam. `capDetail.test.ts` is the sole owner of the cap
matrix; mapper tests cover projection, optional-field omission, internal/contributed sentinels, and
one persistence-redaction smoke. Filesystem integrations do not repeat the shared store matrix.

`compaction_started` follows the same live-only `signal` path as streaming deltas: the mapper can
project it for a watching host, but the journal never receives it. The terminal `compaction` event
remains durable and carries `fallback_reason` when a failed or ineffective summary ended in
mechanical eviction.

## The on-disk format is a contract

The stored response retains an accepted checkpoint's `disposition` and bounded handoff independently
of execution status. Its metadata is separate from the final result value. Reopening the store must
preserve that distinction; orphan recovery still reports `interrupted` and does not invent an accepted
checkpoint from an unfinished journal.

`JsonTraceStore` writes what `@clarvis/kernel` reads back to restore a session.
Changing what it writes changes what every already-recorded run means, so a
change there is a deliberate format decision, never a side effect of a
refactor. Owner deletion is ordered against concurrent inserts by a durable
`deleting`/`active` generation marker and an owner-wide deletion lease under
the store's `.locks` machinery directory. `deleteOwner` publishes `deleting`
before removing the owner directory and publishes the next generation as
`active` only after that removal and its machinery cleanup finish. An insert
that straddles the transition removes only the files it published; one that
observes a live deletion fails with `persistence_failure` instead of reporting
success for a file the remover can still erase. If the deleting process dies,
the next insert reclaims its local lease, completes the purge, activates the
already-recorded generation and then proceeds. A per-record generation sidecar
keeps a straddling record invisible even if its writer dies before rollback;
the execution JSON format itself is unchanged.

An explicitly requested settled-context compaction uses `replaceFinalContext` to atomically replace
only `final_context` and add any summarizer usage to the record totals. The replacement holds the
same owner deletion lease and per-record lease as `deleteById`, so neither record deletion nor owner
deletion can race the rewrite and resurrect stale context.

Terminal `tool_call` rows may include the final command-guard review. The mapper
preserves that small structured fact so restored sessions can show whether an
automatic review approved or denied the command and who supplied the answer.
