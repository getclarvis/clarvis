# Memory indexer: passes, the durable job queue, leases, health and ingest

> Implemented at `packages/memory/src/**` and `packages/kernel/src/runs/memory-ingest-phase.ts`.
> Every claim below is anchored to a file and line. Open questions are collected in the final
> section.

## 1. Purpose

This subsystem is what turns *a run that finished* into *something the wiki knows*. The work it
performs — one LLM agent run over the memory tools — is expensive and must not sit on the response
path, so the code splits it in two: a **bounded, durable enqueue** performed synchronously at run end
(`packages/memory/src/ingest.ts:149`, `packages/memory/src/memory.ts:47`), and a **background drain**
that later claims that record, runs a real `executeRun`, and settles it
(`packages/memory/src/drain.ts:371`). The module header states the intent directly: "The gap between
'the run ended' and 'memory absorbed it' is therefore crossed by a durable record rather than an
in-flight promise: a process that dies mid-pass loses nothing it had accepted responsibility for"
(`packages/memory/src/jobs.ts:5`).

An *index pass* is not a single completion. `indexRun` builds a `RunRequest` and calls the engine's
`executeRun` (`packages/memory/src/indexer/run.ts:190`), so the model edits the wiki through the same
seven memory tools an agent gets. Two shapes exist. The **isolated** pass runs an inline
`memory-indexer` profile over a rendered execution digest and *replaces* the host's capability list
(`packages/memory/src/indexer/run.ts:364`). The **continuation** pass is a `continue_from` of the very
run being indexed, appending only a trailing instruction, and *prepends* its capability to the host's
list (`packages/memory/src/indexer/run.ts:328`). `planPass` chooses between them
(`packages/memory/src/indexer/run.ts:308`), guided by `continuationBlocker`
(`packages/memory/src/indexer/request.ts:276`).

Around that sit the supporting parts this document owns: the pure retry/give-up policy
(`packages/memory/src/jobs.ts:93`), the snapshot bounding and redaction
(`packages/memory/src/jobs.ts:219`), the file-backed queue with owner/token lease fencing
(`packages/memory/src/file-store/jobs.ts:213`), the per-tree background worker with its coalescing
timer (`packages/memory/src/worker.ts:69`), the per-run settlement broker
(`packages/memory/src/job-broker.ts:99`), the operator's recording policy
(`packages/memory/src/recording-policy.ts:67`), the deterministic diagnostics pass
(`packages/memory/src/health.ts:175`), the process-lived factory that assembles all of it
(`packages/memory/src/factory.ts:233`), and the kernel-side classification of an ingest notice's phase
(`packages/kernel/src/runs/memory-ingest-phase.ts:23`).

---

## 2. Surface

### 2.1 Exported from `@clarvis/memory` (the package barrel)

| Symbol | Kind | Signature / value | Source |
| --- | --- | --- | --- |
| `drainIndexJobs` | fn | `(args: DrainArgs) => Promise<MemoryDrainReport>` | `packages/memory/src/drain.ts:371` |
| `DEFAULT_JOB_RETENTION` | const | `{ terminalMs: 7d, pendingMs: 30d, keepFailed: 20 }` | `packages/memory/src/drain.ts:188` |
| `MemoryDrainOutcome` | type | `"completed" \| "retry_wait" \| "failed" \| "blocked"` | `packages/memory/src/drain.ts:41` |
| `MemoryDrainReport`, `MemoryJobRetention` | types | see §3.3 | `packages/memory/src/drain.ts:44`, `:153` |
| `createMemoryJobBroker` | fn | `(opts?: MemoryJobBrokerOptions) => MemoryJobBroker` | `packages/memory/src/job-broker.ts:99` |
| `MemoryJobSettlement` | type | `MemoryDrainReport["jobs"][number]` | `packages/memory/src/job-broker.ts:15` |
| `retryDelayMs` | fn | `(attempts: number, policy: MemoryRetryPolicy) => number` | `packages/memory/src/jobs.ts:77` |
| `classifyFailure` | fn | `(job, failure, policy, now) => MemoryJobTransition` | `packages/memory/src/jobs.ts:93` |
| `appendAttempt` | fn | `(job, failure, now) => MemoryJobAttempt[]` | `packages/memory/src/jobs.ts:116` |
| `isJobPrunable` | fn | `(job, { terminalBefore, pendingBefore? }) => boolean` | `packages/memory/src/jobs.ts:162` |
| `boundRunSnapshot` | fn | `(run, limits?) => BoundedSnapshot` | `packages/memory/src/jobs.ts:219` |
| `DEFAULT_RETRY_POLICY` | const | `{ maxAttempts: 5, maxValidateAttempts: 2, baseDelayMs: 30_000, maxDelayMs: 900_000, jitter: Math.random }` | `packages/memory/src/jobs.ts:59` |
| `DEFAULT_SNAPSHOT_LIMITS` | const | `{ maxToolCalls: 500, maxExcerptChars: 600, maxFinalAnswer: 4000, maxTask: 8000, maxSteering: 20, maxSteeringChars: 400 }` | `packages/memory/src/jobs.ts:186` |
| `MAX_JOB_HISTORY` | const | `5` | `packages/memory/src/jobs.ts:33` |
| `MemoryIndexError` | class | `phase`, `terminal`, `indexerRunId`, `code = "memory_index_failed"` | `packages/memory/src/indexer/run.ts:70` |
| `createIndexWorker` | fn | `(opts: MemoryIndexWorkerOptions) => MemoryIndexWorker` | `packages/memory/src/worker.ts:69` |
| `INDEXER_SYSTEM`, `INDEXER_ITERATION_LIMIT` (12), `INDEXER_TOKEN_LIMIT` (200_000), `MEMORY_INDEXER_AGENT` (`"memory-indexer"`) | consts | isolated-pass prompt and bounds | `packages/memory/src/indexer/request.ts:58,32,42,21` |
| `health`, `HEALTH_CODES`, `DEFAULT_HEALTH_CONFIG` | fn / consts | §2.4 | `packages/memory/src/health.ts:175,31,100` |

`DEFAULT_MEMORY_JOB_PAGE_SIZE` (200) is exported from `packages/memory/src/jobs.ts:36` but is **not** in the barrel's
export list (`packages/memory/src/index.ts:126`).

### 2.2 Exported from `@clarvis/memory/capability` (host-facing)

| Symbol | Signature | Source |
| --- | --- | --- |
| `createMemoryFactory` | `(opts: CreateMemoryFactoryOptions) => MemoryFactory` | `packages/memory/src/factory.ts:233` |
| `MemoryFactory`, `MemoryFactorySettings` | types | `packages/memory/src/factory.ts:123`, `:27` |
| `enqueueFinishedRun` | `(a: {...}) => Promise<void>` (never rejects) | `packages/memory/src/ingest.ts:122` |
| `MemoryIngestNotice` | type | `packages/memory/src/ingest.ts:12` |
| `storedExecutionToRunSnapshot`, `firstUserText` | fns | `packages/memory/src/run-snapshot.ts:56`, `:14` |
| `captureWorkspaceState` | `(cwd, logger?) => Promise<WorkspaceState \| undefined>` | `packages/memory/src/workspace-state.ts:37` |
| `composeMemoryPolicy`, `loadMemoryPolicy`, `MEMORY_POLICY_MAX_CHARS` (4000) | fns / const | `packages/memory/src/recording-policy.ts:67,103,38` |

Re-export site: `packages/memory/src/capability.ts:42-45`, `:61-67`.

`createIndexerMemoryCapability` and `createIndexingPassCapability`
(`packages/memory/src/indexer/capability.ts:154`, `:271`), `indexRun`, `planPass`
(`packages/memory/src/indexer/run.ts:149`, `:308`), `translateDrainSettlement`
(`packages/memory/src/ingest.ts:56`) and `createJobRepository`
(`packages/memory/src/file-store/jobs.ts:69`) are **not** exported from any package entrypoint
(`packages/memory/package.json:21-48`); they are reached only by this package's own modules and its
tests. `packages/memory/tests/architecture/file-store-exports.test.ts:7` pins that
`createJobRepository` stays internal.

### 2.3 `MemoryFactory` (the process-lived host seam)

| Member | Behaviour | Source |
| --- | --- | --- |
| `forOwner(owner)` | resolves only when a model resolves — the worker's entry point | `packages/memory/src/factory.ts:475`, `:348` |
| `forOwnerControlPlane(owner)` | resolves without a model; `index` then reports `note: "no-indexer"` (a `Memory` built with no `indexer` thunk) | `packages/memory/src/factory.ts:476`, `packages/memory/src/memory.ts:96-105` |
| `providerFor(owner)` | optional; resolves the declared memory provider | `packages/memory/src/factory.ts:477`, `:456` |
| `start(owner)` / `poke(owner)` | drive that owner's `MemoryIndexWorker` | `packages/memory/src/factory.ts:478-479` |
| `stopOwner(owner)` | closes broker subs, stops the worker, evicts caches and store | `packages/memory/src/factory.ts:480` |
| `stop()` | idempotent, concurrent-safe teardown of every worker | `packages/memory/src/factory.ts:494` |
| `subscribeToRun(owner, runId, onSettled)` | broker subscription, already translated to `MemoryIngestNotice` | `packages/memory/src/factory.ts:506` |

Construction inputs that matter here: `runDeps` and `passRunDeps` are **thunks**
(`packages/memory/src/factory.ts:47`, `:56`) — the host's deps object contains the memory capability built *from* this
factory, so an eager value would be circular (`packages/kernel/src/file-kernel.ts:869-872`).
`loadPolicy` is a thunk for the same reason edits should take effect next pass (`packages/memory/src/factory.ts:63`).

### 2.4 `health(args)` — deterministic diagnostics

`HealthArgs` = `{ tx: Pick<MemoryTx,"list"|"read"|"readBounded">, now, config?, jobs?,
recoveryRequired? }` (`packages/memory/src/health.ts:141`). The `tx` is typed as a `Pick` so the pass cannot write
(`packages/memory/src/health.ts:148`).

`HEALTH_CODES` in declaration order (`packages/memory/src/health.ts:31`), which is also part of the report sort key
(`packages/memory/src/health.ts:450`):

| Code | Severity | Source of severity |
| --- | --- | --- |
| `missing_profile` | error | `packages/memory/src/health.ts:112` |
| `recovery_required` | error | `packages/memory/src/health.ts:113` |
| `failed_index_job` | error | `packages/memory/src/health.ts:114` |
| `missing_topic_index` | warning | `packages/memory/src/health.ts:115` |
| `orphan_document` | warning | `packages/memory/src/health.ts:116` |
| `stale_navigation` | warning | `packages/memory/src/health.ts:117` |
| `invalid_frontmatter` | warning | `packages/memory/src/health.ts:118` |
| `missing_description` | warning | `packages/memory/src/health.ts:119` |
| `invalid_authority` | warning | `packages/memory/src/health.ts:120` |
| `empty_document` | warning | `packages/memory/src/health.ts:121` |
| `document_too_large` | warning | `packages/memory/src/health.ts:122` |
| `stuck_index_job` | warning | `packages/memory/src/health.ts:123` |
| `placeholder_description` | info | `packages/memory/src/health.ts:124` |
| `description_too_long` | info | `packages/memory/src/health.ts:125` |
| `stale_document` | info | `packages/memory/src/health.ts:126` |
| `unknown_frontmatter_key` | info | `packages/memory/src/health.ts:127` |

`DEFAULT_HEALTH_CONFIG` = `{ maxDocumentChars: 20_000, staleDays: 180, stuckJobMinutes: 30,
maxPerCode: 50, maxFindings: 200 }` (`packages/memory/src/health.ts:100`).

### 2.5 Kernel-facing surface

| Symbol | Value / signature | Source |
| --- | --- | --- |
| `isIngestPending(phase)` | `true` for `"started"`/`"queued"`, else `false` | `packages/kernel/src/runs/memory-ingest-phase.ts:23` |
| `ingestPendingAfter(event)` | `undefined` for a non-`memory_ingest` event | `packages/kernel/src/runs/memory-ingest-phase.ts:53` |
| `DEFAULT_INGEST_CLOSE_GRACE_MS` | `5_000` | `packages/kernel/src/runs/memory-ingest-phase.ts:36` |
| `DEFAULT_INGEST_CLOSE_MAX_WAIT_MS` | `15_000` | `packages/kernel/src/runs/memory-ingest-phase.ts:39` |
| `MAX_INGEST_CLOSE_WAIT_MS` | `60_000` | `packages/kernel/src/runs/memory-ingest-phase.ts:42` |

`isIngestPending` is re-exported on `@clarvis/kernel/policy` (`packages/kernel/src/policy.ts:11`).

The kernel's `MemoryService` exposes the queue to clients: `health()`, `jobs(filter)` with `limit`
clamped to `MAX_LIMIT = 100`, and `retryJob(runId)`
(`packages/kernel/src/memory/memory-service.ts:107,132,151,15`). The wire `MemoryJob` drops the
snapshot deliberately (`packages/kernel/src/memory/memory-service.ts:23-37`). Transport methods:
`memory.jobs`, `memory.retryJob`, and health at
`packages/kernel/src/transport/operations.ts:396,409,412`.

---

## 3. Data and formats

### 3.1 `MemoryIndexJob` — the durable record

```ts
interface MemoryIndexJob {
  run_id: string;
  state: "pending" | "running" | "retry_wait" | "completed" | "failed";
  enqueued_at: number;  updated_at: number;  attempts: number;
  provider_key?: string;
  not_before?: number;                 // retry_wait only
  lease_until?: number; lease_owner?: string; lease_token?: string;   // running only
  snapshot?: RunSnapshot;              // dropped on complete()
  history: MemoryJobAttempt[];         // capped at MAX_JOB_HISTORY = 5
  note?: string;
}
```

(`packages/memory/src/job-contract.ts:24-39`; `MemoryJobAttempt` = `{ at, phase, error }` at `:10`;
`MemoryJobPhase` = `"generate" | "validate" | "apply" | "commit"` at `:7`;
`MemoryJobLease` = `{ owner, token }` at `:42`;
`MemoryJobTransition` = `{ state: "retry_wait"; not_before } | { state: "failed" }` at `:48`.)

### 3.2 On-disk layout (file backend)

| Path | Contents | Source |
| --- | --- | --- |
| `<machineryRoot>/.state/jobs/<encoded>.json` | one job record, JSON | `packages/memory/src/file-store/jobs.ts:100`, `:102` |
| `<machineryRoot>/.state/indexed/<encoded>` | the "was indexed" ledger marker; body is `String(at)` | `packages/memory/src/file-store/jobs.ts:101`, `:414` |

`machineryRoot` is `workspaceStatePaths(workspaceRoot).memoryMachineryRoot`
(`packages/memory/src/factory.ts:240`), i.e. `<state>/…/memory`
(`packages/paths/src/workspace-state.ts:181`) — outside the wiki at
`<ws>/.clarvis/memory` (`packages/paths/src/workspace.ts:116`).

The filename encoder is deliberately lossy-but-collision-safe: non-`[A-Za-z0-9_-]` characters become
`_`, the slug is cut at 48 characters, and a 12-hex prefix of `sha256(runId)` is appended
(`packages/memory/src/file-store/jobs.ts:64-67`). `packages/memory/tests/integration/job-durability.test.ts:26` drives it
with `"../../etc/passwd:CON"` and asserts the record round-trips with the original id intact.

Writes go through `writeFileDurable` after an explicit size assertion against
`MEMORY_STORAGE_LIMITS.metadataBytes` (1 MiB) (`packages/memory/src/file-store/jobs.ts:114-123`,
`packages/memory/src/storage-limits.ts:12`).

**Job records survive a deleted wiki.** `discardOrphanedBookkeeping` removes `.state/indexed` and
`.journal` when the wiki directory has vanished under a split layout, and names neither `.state/jobs`
nor the lock (`packages/memory/src/file-store/layout.ts:35-44`, `:52`, `:59`). Pinned by
`packages/memory/tests/integration/machinery-split.test.ts:147`.

### 3.3 `MemoryDrainReport`

```ts
{ claimed, completed, retried, failed, blocked, next_due_at?,
  jobs: { run_id, outcome, note?, written?, deleted?, reindexed?,
          indexer_run_id?, continuation_blocker? }[] }
```

(`packages/memory/src/drain.ts:44-92`.) `written`/`deleted`/`reindexed` are present **only** for a
job whose pass actually ran; their absence is what distinguishes a real pass from a converged
shortcut (`packages/memory/src/drain.ts:63-67`, and the consumer at `packages/memory/src/ingest.ts:77`).

### 3.4 `MemoryIngestNotice` and the drain→notice mapping

`MemoryIngestNotice` = `{ execution_id, phase: "started"|"queued"|"done"|"failed"|"blocked",
written?, deleted?, reindexed?, skipped?, note?, error?, indexer_run_id? }`
(`packages/memory/src/ingest.ts:12-35`).

| Drain outcome | Notice phase | Carried | Source |
| --- | --- | --- | --- |
| `retry_wait` | `queued` | `indexer_run_id` only | `packages/memory/src/ingest.ts:60-61` |
| `failed` | `failed` | `error` = job note (omitted when absent), `indexer_run_id` | `packages/memory/src/ingest.ts:62-68` |
| `blocked` | `blocked` | `note` only — **no** `indexer_run_id` | `packages/memory/src/ingest.ts:69-74` |
| `completed` with any of `written`/`deleted`/`reindexed` | `done` | the three counts, defaulted to `0/0/false` | `packages/memory/src/ingest.ts:77-87` |
| `completed` with none of them | `done` | `skipped: true` | `packages/memory/src/ingest.ts:88` |
| anything unrecognized | `done`, `skipped: true` | — (`default` shares the `completed` arm) | `packages/memory/src/ingest.ts:76`, test `packages/memory/tests/component/ingest.test.ts:108` |

### 3.5 `RunSnapshot`, and how a stored run becomes one

`RunSnapshot` = `{ run_id, workspace, status, started_at, ended_at, task, final_answer?, tool_calls,
steering?, workspace_state? }` (`packages/memory/src/run-contract.ts:24`).

`storedExecutionToRunSnapshot` (`packages/memory/src/run-snapshot.ts:56`) walks the persisted trace:
`task` is the **first** user message, not the joined user text (`packages/memory/src/run-snapshot.ts:14`); `final_answer`
exists only for a non-error response (`packages/memory/src/run-snapshot.ts:19-30`); each tool call's result excerpt is
re-truncated to 2000 chars (`packages/memory/src/run-snapshot.ts:10`, `:71`); a `tool_call` with an empty `tool_name` is
treated as MCP — `mcp_name` becomes the tool name and `server` is omitted (`packages/memory/src/run-snapshot.ts:65-69`);
capability-contributed events are skipped via `isBuiltinTraceEvent` (`packages/memory/src/run-snapshot.ts:63`).

`captureWorkspaceState(cwd)` obtains branch, commit and dirty state from the explicitly selected
workspace. Its three Git probes remove Git's repository-local environment before using `cwd`, so a
Clarvis process launched by a parent hook cannot substitute that parent's repository or temporary
index (`packages/memory/src/workspace-state.ts:12-20`, `:42-46`). Probe failure remains best-effort:
it returns `undefined` and emits only the debug diagnostic (`:48-58`).

### 3.6 The composed recording policy

`composeMemoryPolicy` emits a fixed four-line preamble, then the usable scopes joined by a blank line,
global first (`packages/memory/src/recording-policy.ts:72-78`):

```
OPERATOR RECORDING POLICY — this workspace's owner has stated what they want kept.
It refines the judgement above about what is worth recording, and wins on conflict.
It does NOT change the structure: the pyramid, the closure rule and the frontmatter
still hold, and topic names remain whatever the knowledge itself calls for.
```

Each scope is independently truncated to `MEMORY_POLICY_MAX_CHARS` (4000), passed through
`sanitizeText`, and trimmed; a blank result is treated as absent
(`packages/memory/src/recording-policy.ts:49-53`, `:38`). `loadMemoryPolicy` reads each file through
`readUtf8PrefixSync` bounded at `MEMORY_STORAGE_LIMITS.prefixBytes` (64 KiB)
(`packages/memory/src/recording-policy.ts:111-113`, `packages/memory/src/storage-limits.ts:14`). The two files are
`<global>/memory-policy.md` and `<ws>/.clarvis/memory-policy.md`
(`packages/paths/src/global.ts:122`, `packages/paths/src/workspace.ts:114`), as wired in
`packages/kernel/src/file-kernel.ts:873-876`.

### 3.7 The isolated pass's request

```ts
{ execution_id, messages: [{ role: "user", content: task }], servers: [],
  providers: [...args.providers],
  profiles: [{ name: "memory-indexer", model: modelRef,
               base_prompt: INDEXER_SYSTEM (+ "\n\n" + policy),
               tools: [], iteration_limit: 12 }],
  entry: "memory-indexer",
  budget: { on_exceed: "stop", total_token_limit: 200_000 } }
```

(`packages/memory/src/indexer/request.ts:212-230`.) The profile carries **no grants and no
`can_spawn`** (`packages/memory/src/indexer/request.ts:11-15`), and `orchestration` is deliberately absent
(`packages/memory/src/indexer/request.ts:208`).

Task text: `# This run\ntask: <first 500 chars, whitespace collapsed>\n\n## Execution digest\n<digest
rendered at budgets.digest_tokens * 4 chars>` plus an optional
`## Final answer (excerpt)` capped at 800 chars (`packages/memory/src/indexer/task.ts:27-36`,
`:15`, `:18`).

### 3.8 The continuation request

```ts
{ execution_id, continue_from: subject.id,
  prompt_cache_key: `${(request.prompt_cache_key ?? subject.id).slice(0, 505)}_memory`,
  messages: [{ role: "user", content: INDEXER_CONTINUATION_INSTRUCTION (+ policy) }],
  servers: [...(request.servers ?? [])],
  providers: [...args.providers],          // live settings, NOT the trace
  profiles: request.profiles.map(p => p.name === entry ? { ...p, iteration_limit: 12 } : p),
  entry: request.entry,
  budget: { on_exceed: "stop", total_token_limit: continuationTokenLimit(subject) } }
```

(`packages/memory/src/indexer/request.ts:368-386`.) `continuationTokenLimit` =
`ceil(200_000 + (uncached_input / iterations_used) * 12)` where `uncached = max(0, input - cached)`
(`packages/memory/src/indexer/request.ts:410-415`). Worked examples the tests pin: a run with `input=1000, cached=1000`
lands exactly at `INDEXER_TOKEN_LIMIT`
(`packages/memory/tests/unit/indexer-continuation.test.ts:230`); a run with `input=264_503, cached=0,
iterations=2` yields a limit above 264_503 (`packages/memory/tests/unit/indexer-continuation.test.ts:221`).

`prompt_cache_key` examples from tests: `"session_42"` → `"session_42_memory"`; no explicit key →
`"run_subject_memory"`; a 512-char key stays 512 chars and still ends `_memory`
(`packages/memory/tests/unit/indexer-continuation.test.ts:133,144,154`).

---

## 4. Behavior

### 4.1 Enqueue (synchronous, on the response path)

1. The memory capability's `onRunEnd` **subscribes first**, then enqueues
   (`packages/memory/src/capability.ts:338-339`) — subscribing after risks missing a settlement the
   worker drains immediately (`packages/memory/src/job-broker.ts:45`).
2. `enqueueFinishedRun` emits `phase: "started"` (`packages/memory/src/ingest.ts:139`), captures git state best-effort
   (`packages/memory/src/ingest.ts:141`, `packages/memory/src/workspace-state.ts:37`), maps the record to a `RunSnapshot`
   (`packages/memory/src/ingest.ts:145`), calls `memory.enqueue` (`packages/memory/src/ingest.ts:149`), logs
   `memory.run.enqueued` and emits `phase: "queued"` (`packages/memory/src/ingest.ts:152-156`).
3. `Memory.enqueue` bounds and redacts the snapshot, then writes it inside `store.exclusive`
   with `provider_key` defaulting to `"wiki:local"` (`packages/memory/src/memory.ts:51-70`).
4. `factory.poke(owner)` is called and **not** awaited (`packages/memory/src/capability.ts:350`).

`enqueueFinishedRun` never rejects: any failure is caught, logged as
`memory.run.enqueue_failed`, and reported as `phase: "failed"` (`packages/memory/src/ingest.ts:157-171`), and the
`onNotice` listener's own throws are swallowed (`packages/memory/src/ingest.ts:132-138`).

### 4.2 `boundRunSnapshot` ordering

`boundRunSnapshot` lives in `packages/memory/src/jobs.ts`, not in the file-backed job store.
`sanitizeDeep(run, sanitizeText)` runs **first**, before any measurement or storage
(`packages/memory/src/jobs.ts:224`); `originalBytes` is measured on the *clean* object
(`packages/memory/src/jobs.ts:225`). Tool-call trimming keeps `floor(maxToolCalls / 5)` from the head
and the remainder from the tail (`packages/memory/src/jobs.ts:229-232`), then excerpts, `task`,
`final_answer` and `steering` are truncated (`packages/memory/src/jobs.ts:233-252`). `truncated` is
emitted when calls were dropped **or** the serialized size shrank
(`packages/memory/src/jobs.ts:254-259`), and is reported on the enqueue log line rather than stored
on the job.

### 4.3 One drain pass

`drainIndexJobs` loops up to `limit` (default 5, `packages/memory/src/drain.ts:212`) times
(`packages/memory/src/drain.ts:423`). Per iteration:

| Step | Code | Effect |
| --- | --- | --- |
| abort check | `packages/memory/src/drain.ts:424` | break |
| resolve the indexer runtime **before** claiming | `packages/memory/src/drain.ts:426` | readiness precedes any attempt |
| enter `store.exclusive` | `packages/memory/src/drain.ts:427` | one critical section for the claim decision |
| no runtime → peek at the first `pending`/`retry_wait` job | `packages/memory/src/drain.ts:428-431` | `blocked` / `none` |
| `tx.jobs.claim(now, {ms, owner, token: randomUUID()})` | `packages/memory/src/drain.ts:434-436` | stamps a lease, `attempts += 1` |
| `provider_key === undefined` | `packages/memory/src/drain.ts:441` | converge, note `provider-selection-unknown` |
| `provider_key !== (memoryProviderKey ?? "wiki:local")` | `packages/memory/src/drain.ts:444-447` | converge, `provider-selection-changed` |
| provider has no `writeTools` | `packages/memory/src/drain.ts:448` | converge, `provider-read-only` |
| `tx.wasIndexed(run_id)` | `packages/memory/src/drain.ts:451` | converge, `already-indexed` |
| `job.snapshot === undefined` | `packages/memory/src/drain.ts:454` | converge, `no-snapshot` |
| otherwise | `packages/memory/src/drain.ts:457` | `claimed` |

A converge is itself lease-fenced: it calls `tx.jobs.complete(..., lease)` and reports `lost` when
that returns false (`packages/memory/src/drain.ts:437-440`); the drain then blocks with `lease_lost`
(`packages/memory/src/drain.ts:465-469`). `packages/memory/tests/component/drain.test.ts:420` drives exactly that with a clock whose
second read is past the lease.

For a claimed job the drain starts `keepLeaseAlive` (`packages/memory/src/drain.ts:485`), calls `indexRun`
(`packages/memory/src/drain.ts:494`), stops the guard, and settles with a fenced `complete` (`packages/memory/src/drain.ts:503-506`). On a
throw the order of checks is: lease lost → `MemoryRecoveryRequiredError` → our own abort → ordinary
failure (`packages/memory/src/drain.ts:526-549`).

Claim/index/settle are three separate critical sections, not one: "starting it from inside an
exclusive section would silently hold that lock for the tree lock itself, and nesting `exclusive` is
explicitly not part of the store contract — a backend whose lock is a promise chain rather than a
re-entrant one would deadlock" (`packages/memory/src/drain.ts:354-359`).

**Prune** runs at the end of a pass only when the pass was not aborted and something happened
(`report.claimed > 0 || report.jobs.length > 0`, `packages/memory/src/drain.ts:596`), wrapped in `bestEffort`
(`packages/memory/src/drain.ts:600-611`). `packages/memory/tests/component/drain.test.ts:303` pins that an idle pass sweeps nothing.
`next_due_at` is read afterwards from the lock-free reader `store.jobs.nextDueAt()`
(`packages/memory/src/drain.ts:618`).

Pruning first identifies the `keepFailed` (20) most-recently-*updated* `failed` jobs
(`keptFailureIds`, `packages/memory/src/jobs.ts:141-148`) and exempts every one of them from the age
check entirely, however old — the file-store's `prune` computes that protected set before its
deletion pass and skips any job whose `run_id` is in it (`packages/memory/src/file-store/jobs.ts:380-398`).
Only a `failed` job outside that top-20 and past `terminalBefore` is actually deleted.
`DEFAULT_JOB_RETENTION`'s own doc comment states the intent: "Most recent failures kept whatever
their age, as evidence" (`packages/memory/src/drain.ts:158`).

### 4.4 Job state machine

Claim due-ness: `pending`, or `retry_wait` past `not_before`, or `running` past `lease_until`
(`packages/memory/src/file-store/jobs.ts:234-237`; identical rule in the in-memory adapter,
`packages/memory/src/testing.ts:334-336`).

| State | Event | Next | Effect |
| --- | --- | --- | --- |
| — | `enqueue` (new run id) | `pending` | `attempts: 0`, `history: []`, snapshot stored (`packages/memory/src/file-store/jobs.ts:215-229`) |
| any | `enqueue` (existing run id) | unchanged | the existing record is returned untouched (`packages/memory/src/file-store/jobs.ts:216-217`) |
| `pending` / due `retry_wait` / expired `running` | `claim` | `running` | `attempts += 1`, `lease_until = now + ms`, owner+token stamped, `not_before` deleted; among every due job, the one with the earliest `enqueued_at` wins — strict FIFO across `pending`/`retry_wait`/`running` together, identically on both store backends (`packages/memory/src/file-store/jobs.ts:227-238`, in-memory twin `packages/memory/src/testing.ts:333-338`) |
| `running` (fence valid & unexpired) | `renew` | `running` | `lease_until = at + ms` (`packages/memory/src/file-store/jobs.ts:254-267`) |
| `running` (fence valid, **expiry ignored**) | `refreshOwnedAfterFence` | `running` | `lease_until = at + ms` (`packages/memory/src/file-store/jobs.ts:268-280`) |
| `running` (fenced) | `complete` | `completed` | snapshot, all lease fields and `not_before` deleted; `note` set (`packages/memory/src/file-store/jobs.ts:281-307`) |
| `running` (fenced) | `fail` → `retry_wait` | `retry_wait` | history appended, `not_before` set, lease cleared, `note = "<phase>: <error>"` capped at 200 (`packages/memory/src/file-store/jobs.ts:308-334`) |
| `running` (fenced) | `fail` → `failed` | `failed` | same, `not_before` deleted |
| `running` (fenced) | `release` | `pending` | `attempts = max(0, attempts - 1)`, lease cleared (`packages/memory/src/file-store/jobs.ts:336-362`) |
| `failed` | `retry` | `pending` | `attempts = 0`, `note = "retried by operator"`, history retained (`packages/memory/src/file-store/jobs.ts:363-379`) |
| any but `failed` | `retry` | unchanged | returns `null` (`packages/memory/src/file-store/jobs.ts:365`) |
| terminal past `terminalBefore`, or `pending`/`retry_wait` past `pendingBefore` | `prune` | deleted | `packages/memory/src/jobs.ts:162-173`, applied at `packages/memory/src/file-store/jobs.ts:380-398` |
| `running` | `prune` | unchanged | `isJobPrunable` returns false for every other state (`packages/memory/src/jobs.ts:172`) |

The `complete`/`fail`/`release` fence condition is the same three-part predicate in each: the guard
fires when the record is `running` **or** a lease was supplied, and then demands a supplied lease,
`state === "running"`, matching owner **and** token, and `lease_until > at`
(`packages/memory/src/file-store/jobs.ts:284-293`, `:311-320`, `:339-347`).

### 4.5 Failure classification (`classifyFailure`)

Evaluated strictly in this order (`packages/memory/src/jobs.ts:99-105`):

1. `failure.terminal === true` → `failed` (budget untouched).
2. `job.attempts >= policy.maxAttempts` → `failed`.
3. `failure.phase === "validate"` and `history` already holds `maxValidateAttempts - 1` validate
   attempts → `failed`.
4. otherwise → `{ state: "retry_wait", not_before: now + retryDelayMs(job.attempts, policy) }`.

`retryDelayMs` = `round(min(maxDelayMs, baseDelayMs * 2^(attempts-1)) * jitter())` (`packages/memory/src/jobs.ts:77-80`).

`toFailure` maps a thrown value: a `MemoryIndexError` carries its own phase and `terminal`
(`packages/memory/src/drain.ts:339`); a `MemoryPathError` is `apply` + terminal (`packages/memory/src/drain.ts:342`); anything else is
`apply`, non-terminal (`packages/memory/src/drain.ts:343`) — the doc names the reason for that fallback: "an untagged
throw escaped `store.exclusive` or `tx.batch`. It used to say `generate`, a phase no unclassified
error has ever described" (`packages/memory/src/drain.ts:333-335`).

### 4.6 `indexRun`, step by step

| # | Step | Code | Outcome on failure |
| --- | --- | --- | --- |
| 1 | provider present but read-only | `packages/memory/src/indexer/run.ts:154` | `skipped` report, note `provider-read-only` |
| 2 | `store.exclusive(tx => tx.wasIndexed(run_id))` | `:158` | `skipped`, note `already-indexed` |
| 3 | `store.recover()` probe, outside any exclusive section | `:167-174` | throws `MemoryIndexError("apply", "memory is awaiting recovery…")` |
| 4 | `generateExecutionId()`, `planPass(...)` | `:177-186` | — |
| 5 | `executeRun({ rawBody, owner, deps, elicit: declineElicit, externalSignal? })` | `:190-196` | throw → `MemoryIndexError("generate", "index-run-failed: …")`, terminal iff `err.name === "ValidationError"` (`:410`) |
| 6 | `response.status === "error"` | `:206-213` | `MemoryIndexError("generate", "index-run-errored: <code>: <msg>")`, terminal iff code is `no_progress` |
| 7 | `status !== "completed"` | `:220-222` | `MemoryIndexError("validate", "index-run-<status>")` |
| 8 | `pyramidIssue(mutations)` | `:224-227` | `MemoryIndexError("validate", "pyramid-not-closed: …")` |
| 9 | fenced `markIndexed` inside `store.exclusive` | `:230-247` | `MemoryIndexError("commit", …)` |
| 10 | log `memory.index.pass`, build the report | `:255-279` | — |

Step 3's placement is explicit: a frozen tree "would otherwise surface as every mutating tool failing
inside its own batch, where the tool wrapper turns a throw into an ordinary error result — so the
model would burn its whole iteration budget on tools that cannot succeed" (`packages/memory/src/indexer/run.ts:162-166`).

The `declineElicit` constant answers every elicitation with `{ action: "decline" }`
(`packages/memory/src/indexer/run.ts:132`) so a continuation of a profile carrying `ask_user` passes the engine's
pre-flight check (`packages/memory/src/indexer/run.ts:118-131`; test
`packages/memory/tests/integration/continuation-elicitation.test.ts:89`).

Step 9's fence is `before → markIndexed → after`, and `after` is invoked even on the error path
(`packages/memory/src/indexer/run.ts:231-238`).

The final report deduplicates paths, with `deleted` derived from `tool === "delete_memory"` and
`written` from everything else (`packages/memory/src/indexer/run.ts:249-254`); `skipped` is `mutations.length === 0`, in
which case `note` is `"nothing-to-record"` (`packages/memory/src/indexer/run.ts:272-273`).

### 4.7 Pass selection (`planPass`)

```
passDeps === undefined                        → isolated, blocker "no-pass-deps"      (packages/memory/src/indexer/run.ts:351)
subject = traceStore.getById(owner, run_id)   (packages/memory/src/indexer/run.ts:329)
continuationBlocker(subject, modelRef) === null && subject !== null
                                              → continuation, capability PREPENDED    (packages/memory/src/indexer/run.ts:331-347)
otherwise                                     → isolated, blocker = that reason       (packages/memory/src/indexer/run.ts:349)
```

`continuationBlocker` order (`packages/memory/src/indexer/request.ts:280-294`):

| # | Condition | Blocker |
| --- | --- | --- |
| 1 | `subject === null` | `no-stored-run` |
| 2 | `final_context` absent or empty | `no-final-context` |
| 3 | `(request.servers ?? []).length > 0` | `mcp-servers-declared` |
| 4 | `total_input_tokens >= 100_000` and `total_cached_tokens === 0` | `no-cache-observed` |
| 5 | no profile named `request.entry` | `no-entry-profile` |
| 6 | `entry.model !== modelRef` | `model-differs` |

The 100 000-token floor is `CACHE_EVIDENCE_MIN_INPUT` (`packages/memory/src/indexer/request.ts:257`), and the tests carry
the measured cases: 5 110 875 input with 0 cached blocks; 2 270 231 with 2 083 456 cached does not;
8 937 with 0 cached does not (`packages/memory/tests/unit/indexer-continuation.test.ts:191,197,201`).

### 4.8 The two indexer capability shapes

| Property | isolated (`createIndexerMemoryCapability`) | continuation (`createIndexingPassCapability`) |
| --- | --- | --- |
| host capability list | **replaced** (`packages/memory/src/indexer/run.ts:384`) | **prepended** to (`packages/memory/src/indexer/run.ts:341-344`) |
| advertised `tools` | the seven wiki tools, read-then-write (`packages/memory/src/capability.ts:175`) | none (`packages/memory/src/capability.ts:294`) |
| `seedMarker` / `seedBlock` / `systemSection` | none declared here | none declared (`packages/memory/src/capability.ts:262-266`) |
| handlers | read toolset, write toolset (`packages/memory/src/capability.ts:166-173`) | read, write, **refusal** (`packages/memory/src/capability.ts:285-292`) |
| gates | `buildPyramidGate(ledger)` (`packages/memory/src/capability.ts:177`) | same (`packages/memory/src/capability.ts:294`) |
| `onRunEnd` | absent (`packages/memory/src/capability.ts:14-15`) | absent |

Both build their toolsets from `buildIndexerParts`: navigation is unbudgeted
(`Number.MAX_SAFE_INTEGER`) while the write half carries `budgets.max_index_ops`
(`packages/memory/src/capability.ts:131-137`, default 16 at `packages/memory/src/config.ts:37`).

The refusal handler matches every wire name outside
`readToolset.names ∪ writeToolset.names ∪ {submit_result}` (`packages/memory/src/capability.ts:199-205`,
`:226`) and answers with an envelope failure carrying "is not available in this pass"
(`packages/memory/src/capability.ts:241-244`). It refuses at **dispatch**, never by withholding a tool from the
advertised array (`packages/memory/src/capability.ts:212-218`).

For an external provider, writes are wrapped so the queue fence spans the remote call: the wrapper
takes `store.exclusive`, checks `fence.before`, executes, checks `fence.after`, and returns
`LOST_INDEX_CLAIM` as an error result if either check fails (`packages/memory/src/capability.ts:77-99`, `:44`). The test
pins the exact call order `["fence:before", "provider:write_memory", "fence:after"]`
(`packages/memory/tests/component/indexing-pass-capability.test.ts:162`).

### 4.9 Pyramid closure

`pyramidIssue(touched)` (`packages/memory/src/indexer/pyramid.ts:73-94`):

| Condition | Result |
| --- | --- |
| `touched` empty | `null` (recording nothing is legitimate) |
| no path ends `/MEMORY.md` | "you changed only compiled layers — …" |
| `PROFILE.md` not among the non-delete writes | "a detailed change must also update the compiled PROFILE.md" |
| some ancestor `TOPIC.md` of a leaf not among them | "the change to `<leaf>` must also update its compiled ancestor `<topic>`" |
| otherwise | `null` |

`compiled` excludes deletes (`packages/memory/src/indexer/pyramid.ts:82`), so deleting a leaf still obliges its ancestors to be
updated (`packages/memory/src/indexer/pyramid.ts:69-71`). `ancestorTopics` builds `<seg1>/TOPIC.md`, `<seg1>/<seg2>/TOPIC.md`, …
excluding the leaf's own directory-terminal segment count minus one (`packages/memory/src/indexer/pyramid.ts:53-60`).

`buildPyramidGate` supplies `fastAcceptOk: () => ledger.isEmpty()` — without it "the gate is skipped
entirely on the lone `submit_result` path and would never run at all" (`packages/memory/src/indexer/pyramid.ts:102-105`,
`:109`). A non-null issue becomes a `nudge` whose note ends "You cannot un-write what already landed,
so close what you started." (`packages/memory/src/indexer/pyramid.ts:113-118`).

### 4.10 Lease renewal (`keepLeaseAlive`)

The guard arms a timer at `max(1, floor(leaseMs / 2))` (`packages/memory/src/drain.ts:258`) that renews inside
`store.exclusive(before)` and re-arms only on success (`packages/memory/src/drain.ts:295-307`). It exposes
`mutationFence = { before, after }` where `before` is a strict `renew` and `after` is
`refreshOwnedAfterFence` (`packages/memory/src/drain.ts:268-294`, `:312`). Any failure — a `false` return or a throw —
calls `lose()`, which sets the flag and aborts the controller with `LOST_LEASE_NOTE`
(`packages/memory/src/drain.ts:264-267`). The signal handed to `indexRun` is `AbortSignal.any([hostSignal, controller])`
when a host signal exists (`packages/memory/src/drain.ts:254-257`).

`packages/memory/tests/component/drain.test.ts:48` pins that the lease is extended with the *current* clock while a
model call is in flight (200 → 250 after advancing 50 against `leaseMs: 100`), and
`packages/memory/tests/component/drain.test.ts:92` pins that a worker whose lease was reclaimed mid-pass writes
nothing to the wiki and does not mark its run indexed.

### 4.11 The worker

`createIndexWorker` holds a `resolve: () => Memory | undefined` thunk called **per tick**
(`packages/memory/src/worker.ts:29`, `:154`), so a model configured later is picked up without rebuilding
(`packages/memory/src/worker.ts:4-8`). Default interval 60 s (`packages/memory/src/worker.ts:61`).

- `requestPass` coalesces: while a pass is in flight, a poke only sets `again = true`
  (`packages/memory/src/worker.ts:180-183`). `packages/memory/tests/component/worker.test.ts:89` fires 100 000 pokes and asserts exactly
  two passes and two `detachObserved` calls.
- `reportPass` suppresses the `memory.drain.pass` log in two cases: it returns immediately, logging
  nothing at all, when the pass claimed no job (`report.jobs.length === 0`, `packages/memory/src/worker.ts:96`); and when
  the pass settled nothing (`completed + retried + failed === 0`) but did block something, the log is
  rate-limited by a sampler keyed by `blocked:<count>` (`admitIdlePass`, `packages/memory/src/worker.ts:97`) — distinct
  from the per-job `admitBlocked` limiter inside `drainIndexJobs` (MIX-17). A pass that settled
  anything is always logged. `packages/memory/tests/component/worker.test.ts:224` pins exactly this: two identical
  blocked-only passes produce exactly one `memory.drain.pass` record.
- Scheduling belongs to `requestPass`'s completion, never to `runOnce`, "Arming a timer here left
  that timer behind an immediate follow-up" (`packages/memory/src/worker.ts:145-150`, `:188-197`).
- `nextDelay`: a pass that settled nothing and blocked something waits the full interval, because a
  blocked job's due time is already in the past (`packages/memory/src/worker.ts:127-131`); otherwise
  `min(interval, max(0, next_due_at - now))`.
- Every exit of `runOnce` returns a delay, including "the resolver yielded nothing" and the catch
  branch which logs `memory.drain.failed` (`packages/memory/src/worker.ts:155`, `:166-175`).
- `onJobSettled` listener throws are swallowed (`packages/memory/src/worker.ts:158-164`).
- `stop()` disarms the timer, aborts the controller, and awaits the in-flight pass
  (`packages/memory/src/worker.ts:219-225`).

### 4.12 The settlement broker

Subscriptions are keyed `JSON.stringify([owner, runId])` (`packages/memory/src/job-broker.ts:108`) — the owner is part of
the key because "caller-supplied execution ids need only be unique within one owner scope"
(`packages/memory/src/job-broker.ts:49-52`). `TERMINAL_OUTCOMES` = `{completed, failed, blocked}` (`packages/memory/src/job-broker.ts:18`);
delivering one of those cancels the leak-guard timer and deletes the subscription **before** invoking
the listener (`packages/memory/src/job-broker.ts:132-140`). A re-subscribe for the same key cancels the prior timer and
replaces the listener (`packages/memory/src/job-broker.ts:114-118`). The returned canceller only removes the entry when
the stored listener is still the one it created (`packages/memory/src/job-broker.ts:120-124`). Default leak guard 30 min
(`packages/memory/src/job-broker.ts:91`). After `close()`, `subscribe` returns an inert canceller and allocates no timer
(`packages/memory/src/job-broker.ts:112`).

### 4.13 The factory

`indexerFor(owner)` yields an `IndexerRuntime` only when: settings load without throwing, memory is
not `enabled: false`, a model resolves from `config.model ?? defaultModel`, `runDeps()` yields deps,
`providersFor` resolves, and the provider resolution is `ok`
(`packages/memory/src/factory.ts:267-296`). Otherwise `undefined`, which the drain reads as `blocked`
(`packages/memory/src/types.ts:85-89`).

`providersFor` returns the declared array when it already covers the model's provider token; derives
a single `{ name: token, kind: token }` entry when the token is one of
`openai-compatible | openai | anthropic | google` (`packages/memory/src/factory.ts:226-231`, `:332`); otherwise warns
`memory.provider.undeclared` once and returns `undefined` (`packages/memory/src/factory.ts:322-331`).

Caching: stores are memoized per owner in a map the settings signature never touches
(`packages/memory/src/factory.ts:234-252`, `:212-216`); `Memory` facades are keyed by `owner` (or `no-model:<owner>`)
plus `JSON.stringify([config, modelRef ?? null, providers ?? []])`
(`packages/memory/src/factory.ts:376-388`); workers live in their own map so a settings edit never leaves a second timer
on one queue (`packages/memory/src/factory.ts:400`, `:411-422`). `stop()` assigns `stopPromise` before awaiting, deferred
by one microtask so an abort callback cannot re-enter (`packages/memory/src/factory.ts:494-505`).

### 4.14 Health

Order of work in `health` (`packages/memory/src/health.ts:175-473`): list the tree (a `MemoryStorageLimitError` there
skips **all** tree codes rather than reporting a partial wiki, `packages/memory/src/health.ts:209-218`); the
`recovery_required` flag; `missing_profile`; `missing_topic_index` per directory with children;
`stale_navigation` by asking `planReindex` what it would change (`packages/memory/src/health.ts:251-267`); then per
document `orphan_document`, `stale_document`, and the content checks under a running
`corpusBytes` budget which, once exhausted, skips eight content codes (`packages/memory/src/health.ts:322-335`); then the
queue codes `failed_index_job` and `stuck_index_job` (`packages/memory/src/health.ts:415-443`); then dedup by
`code|path|message`, a total sort by (severity rank, declaration index, path, message), and a cap at
`maxFindings` (`packages/memory/src/health.ts:445-456`).

The cap is applied at **two** tiers. At collection time, `add()` silently drops any finding once its
code has already reached `maxPerCode` (default 50) — the finding never enters `findings` at all, and
this does not call `skip(...)` (`packages/memory/src/health.ts:191-198`). After dedup and the total sort, the whole set is
truncated again to the overall `maxFindings` (default 200) (`packages/memory/src/health.ts:456`).

`truncated` is `incomplete || kept.length < sorted.length` (`packages/memory/src/health.ts:471`), where `incomplete` is
set by any `skip(...)` (`packages/memory/src/health.ts:186-189`). Because a per-code overflow never reaches `sorted`, it is
**not** reflected in `truncated` unless the overall cap is *also* exceeded or `incomplete` was
independently set by some other `skip(...)` — a tree with, say, 80 `orphan_document` findings and
nothing else wrong reports exactly 50 of them with `truncated: false`, as long as the total finding
count stays under `maxFindings`.

A `running` job is `stuck_index_job` only when `updated_at <= now - stuckJobMinutes*60_000`
(`packages/memory/src/health.ts:433-435`), and the suggested action states the design: "Its claim expires on its own;
retry it if it does not." (`packages/memory/src/health.ts:440`).

### 4.15 The kernel's stream-close grace

`ManagedRun` reads each pushed event through `ingestPendingAfter`; `undefined` leaves the flag alone,
`true` renews the wait, `false` settles it (`packages/kernel/src/runs/managed-run.ts:205-211`).
`closeStream` ends immediately when nothing is pending; otherwise it arms a sliding
`min(ingestGraceMs, absoluteDeadline - now)` timer against an absolute deadline of
`now + ingestMaxWaitMs` (`packages/kernel/src/runs/managed-run.ts:236-256`). Both values are bounded
by `MAX_INGEST_CLOSE_WAIT_MS` and `ingestMaxWaitMs` is floored at `ingestGraceMs`
(`packages/kernel/src/runs/managed-run.ts:178-192`).

---

## 5. Invariants

Each is stated in this subsystem's terms, with the production site and the test that pins it.
Catalog invariants carry `INV-nnn` and are owned by this document; `MIX-nn` are invariants derived
directly from the code by this document, not entries in the `INV-nnn` catalog.

### Indexer surface and prompt-cache identity

**INV-094.** The indexer's memory capability and the host run-time memory capability advertise an
**identical** wire surface for the entry agent — same `fullName`/`wireName`/`mcpName`/`toolName`/
`description`/`inputSchema`, in the same order — over a shared store, and that surface is non-empty
(7 tools).
Production: `packages/memory/src/indexer/capability.ts:175`.
Test: `packages/memory/tests/architecture/indexer-surface-identity.test.ts:84`, `:89`.

**INV-095.** That list partitions read before write, identically on both sides:
`list_memories, query_memories, read_memory, grep_memories, write_memory, edit_memory,
delete_memory`.
Production: the duplicated `READ_TOOLS` set at
`packages/memory/src/indexer/capability.ts:43` (its twin is the canonical name list
`MEMORY_READ_TOOL_NAMES` at `packages/memory/src/provider.ts:29`, consumed as `READ_NAMES` in
`packages/memory/src/wiki-provider.ts:21` and directly in `packages/memory/src/capability.ts:71`).
Test: `packages/memory/tests/architecture/indexer-surface-identity.test.ts:94`.

**MIX-01.** Moving the read/write partition boundary's last read-tool name
(`grep_memories`) across the boundary changes only that tool's call budget, never the wire order —
the concatenated `[...read, ...write]` array is unchanged either way, so the identity guard (INV-094)
cannot detect that particular reclassification; only moving a *non*-boundary name reorders the array
and turns the guard red.
Production: n/a (a property of concatenation order, not a code path).
Test: `packages/memory/tests/architecture/indexer-surface-identity.test.ts:27-34` (docstring
established by perturbing each `Set` and watching the comparison).

**INV-110.** `INDEXER_CONTINUATION_INSTRUCTION` contains the literal "explicitly authorised", all
three write tool names, and identifies itself as the "dedicated memory pass".
Production: `packages/memory/src/indexer/request.ts:140-143`.
Test: `packages/memory/tests/architecture/write-policy.test.ts:93`, `:100`.

**MIX-02.** The continuation capability advertises no tools, declares no `seedMarker`,
no `seedBlock` and no `systemSection`, and has no `onRunEnd`.
Production: `packages/memory/src/indexer/capability.ts:294`, `:271-300`.
Test: `packages/memory/tests/component/indexing-pass-capability.test.ts:64`, `:69`, `:76`.

**MIX-03.** The continuation capability never handles `submit_result` — the engine's own
handler must reach it, "or the pass could never finish".
Production: `packages/memory/src/indexer/capability.ts:202`.
Test: `packages/memory/tests/component/indexing-pass-capability.test.ts:106`.

**MIX-04.** A continuation's `providers` come from live settings, never from
`subject.request`, because the trace persists `sanitizeDeep(request)` and `api_key_env` is redacted
to `"[redacted]"`, which `providerConfigSchema` rejects.
Production: `packages/memory/src/indexer/request.ts:379`.
Test: `packages/memory/tests/component/continuation-sanitized-trace.test.ts:72`, `:79`, `:90`.

**MIX-05.** A continuation carries `entry`, `profiles` (including grants and tools) and
`prompt_cache_key` from the indexed run, and changes only `iteration_limit` on the entry profile and
`budget` — neither of which is on the wire.
Production: `packages/memory/src/indexer/request.ts:374-385`.
Test: `packages/memory/tests/unit/indexer-continuation.test.ts:106`, `:121`;
`packages/memory/tests/integration/continuation-elicitation.test.ts:100`.

**MIX-06.** `prompt_cache_key` is the indexed run's key (or its id) truncated to 505 chars
with `_memory` appended, so the composite never exceeds 512 characters. The doc comment states why the
key must diverge from the interactive session's own key rather than reuse it: "sharing the exact
affinity key let that background branch displace the conversation's hot prefix on providers that
retain one active prefix per session."
Production: `packages/memory/src/indexer/request.ts:374`, rationale at `:361-365`.
Test: `packages/memory/tests/unit/indexer-continuation.test.ts:154`.

**MIX-07.** The hot path *prepends* the pass capability to the host's list and the cold
path *replaces* it with a single-element list.
Production: `packages/memory/src/indexer/run.ts:341-344`, `:383-394`.
Test: `packages/memory/tests/integration/indexer-pass-plan.test.ts:91`, `:109`.

### Recording policy

**INV-116.** `composeMemoryPolicy` concatenates global before workspace; either scope survives alone;
both blank/absent yields `undefined`; a blank scope counts as absent; each scope is bounded
separately by `MEMORY_POLICY_MAX_CHARS`, so a long workspace file cannot crowd out the personal one.
Production: `packages/memory/src/recording-policy.ts:67-79`, `:49-53`, `:38`.
Test: `packages/memory/tests/unit/recording-policy.test.ts:28`, `:33`, `:38`, `:43`, `:48`.

**INV-117.** The composed text always restates its two structural limits — "does NOT change the
structure" and "topic names remain" — whatever the operator wrote.
Production: `packages/memory/src/recording-policy.ts:75-76`.
Test: `packages/memory/tests/unit/recording-policy.test.ts:56`.

**INV-118.** The policy reaches the isolated pass only through its own `base_prompt` and the
continuation only through its trailing message; with no policy configured, the isolated
`base_prompt` does not contain "OPERATOR RECORDING POLICY".
Production: `packages/memory/src/indexer/request.ts:222`, `:376`, `:313-315`.
Test: `packages/memory/tests/unit/recording-policy.test.ts:66`, `:77`, `:103`.

**INV-119.** `loadMemoryPolicy` reproduces those rules from real files: personal text precedes
workspace text; a missing file, a blank file and a path that is a directory are each exactly an
absent scope, never a throw.
Production: `packages/memory/src/recording-policy.ts:103-113`.
Test: `packages/memory/tests/integration/recording-policy.test.ts:13`, `:25`, `:36`, `:46`, `:54`.

### Retry policy and snapshot bounding

**INV-111.** `retryDelayMs` backs off exponentially (`base × 2^(attempts-1)`) and clamps at
`maxDelayMs`; a `jitter()` of `0.5` halves the computed delay.
Production: `packages/memory/src/jobs.ts:77-80`, `:59`.
Test: `packages/memory/tests/unit/jobs-policy.test.ts:29`, `:36`.

**INV-112.** `classifyFailure` reschedules a transient failure as `retry_wait`; fails a job once
`attempts >= maxAttempts`; gives up on a `validate` failure sooner than on a `generate` one; and
fails a `terminal: true` error immediately without spending the retry budget.
Production: `packages/memory/src/jobs.ts:99-105`.
Test: `packages/memory/tests/unit/jobs-policy.test.ts:41`, `:46`, `:53`, `:65`; end-to-end at
`packages/memory/tests/component/drain.test.ts:234` (5 attempts on transport) and `:259` (2 on an
open pyramid).

**INV-113.** `boundRunSnapshot` redacts secret-shaped values before the snapshot is ever stored —
redaction is the first operation, ahead of measurement.
Production: `packages/memory/src/jobs.ts:224`.
Test: `packages/memory/tests/unit/jobs-policy.test.ts:73`.

**INV-114.** When tool calls must be dropped, the first and the last are kept, and the exact dropped
count is reported.
Production: `packages/memory/src/jobs.ts:229-232`, `:254-259`.
Test: `packages/memory/tests/unit/jobs-policy.test.ts:80`.

**INV-115.** Long string fields (`task`, `final_answer`) are capped at their configured maximum.
Production: `packages/memory/src/jobs.ts:240`, `:243`.
Test: `packages/memory/tests/unit/jobs-policy.test.ts:91`.

**MIX-08.** A job's `history` never exceeds `MAX_JOB_HISTORY = 5`, and each entry's error
is truncated to 500 characters.
Production: `packages/memory/src/jobs.ts:126`, `:124`, `:33`, `:39`. Enforced again on read: a record
whose `history.length > MAX_JOB_HISTORY` is rejected as corrupt
(`packages/memory/src/file-store/jobs.ts:47`). The five-entry cap is pinned directly; the 500-char
error truncation is not.
Test: `packages/memory/tests/unit/jobs-policy.test.ts:85` (cap); error length unpinned.

### The durable queue

**INV-123.** A run id is recorded indexed **at most once** — `markIndexed` is idempotent — and the
ledger never appears in the document listing.
Production: `packages/memory/src/file-store/jobs.ts:412-415` (exclusive-of-tree `.state/indexed`
directory).
Test: `packages/memory/src/testing.ts:751`, `:762`, driven against both backends from
`packages/memory/tests/contract/store.test.ts:40`.

**INV-124.** Enqueuing for a run id already queued returns the original record untouched — the
original `enqueued_at` wins — and queue counts reflect exactly the distinct jobs.
Production: `packages/memory/src/file-store/jobs.ts:216-217`; in-memory twin at
`packages/memory/src/testing.ts:316-317`.
Test: `packages/memory/src/testing.ts:773`.

**INV-125.** Claiming a due job locks it to one worker (a second concurrent claim returns `null`),
and `release()` returns the job to `pending` with its attempt refunded to zero.
Production: `packages/memory/src/file-store/jobs.ts:231-253`, `:336-362`.
Test: `packages/memory/src/testing.ts:784`.

**MIX-09.** Among all due jobs, `claim` always selects the one with the earliest
`enqueued_at` — strict FIFO by enqueue time across `pending`, expired `retry_wait` and expired
`running` jobs together, not the drain's iteration order or job-id order, identically on both store
backends.
Production: `packages/memory/src/file-store/jobs.ts:227-238`, `packages/memory/src/testing.ts:333-338`.
Test: **Unpinned** — no test in this document's scope asserts the tie-break explicitly against more than one
simultaneously-due job.

**INV-126.** An expired lease can be reclaimed by a new worker, and the reclaim does **not** reset the
attempt counter (`attempts: 2`, not 1).
Production: `packages/memory/src/file-store/jobs.ts:237`, `:244`.
Test: `packages/memory/src/testing.ts:805`.

**INV-127.** Every lease operation (`renew`, `refreshOwnedAfterFence`, `complete`, `fail`, `release`)
is fenced by the `(owner, token)` pair: after a reclaim, every one of them presented with the *old*
pair returns `false` rather than mutating the job — even before the new owner has completed anything.
Production: `packages/memory/src/file-store/jobs.ts:254-362`.
Test: `packages/memory/src/testing.ts:817` ("refreshes a fenced long effect and rejects every stale
operation after reclaim").

**INV-128.** An expired-lease holder cannot `renew`, `complete`, `fail` or `release` its own claim
*before* anyone reclaims it — expiry alone invalidates those calls.
Production: the `(job.lease_until ?? 0) <= at` term at
`packages/memory/src/file-store/jobs.ts:258`, `:290`, `:317`, `:345`.
Test: `packages/memory/src/testing.ts:886`.

**INV-129.** Only an explicit `retry` revives a `failed` job — back to `pending` with `attempts: 0` —
and the prior failure's message is retained in `history`.
Production: `packages/memory/src/file-store/jobs.ts:363-379`.
Test: `packages/memory/src/testing.ts:917`; facade-level at
`packages/memory/tests/component/jobs.test.ts:33`.

**INV-130.** Pruning removes only terminal jobs past `terminalBefore` (excluding the `keepFailed`
most-recently-updated `failed` jobs, which are exempt from that age check regardless of how old they
are) or explicitly stale `pending`/`retry_wait` jobs past `pendingBefore`, and never a `running` job
at any age — `isJobPrunable` returns `false` for `running` unconditionally, whether or not its lease
has expired; an outlived lease is reclaimed by a future `claim()`, never pruned.
Production: `packages/memory/src/jobs.ts:141-148` (`keptFailureIds`), `:162-173` (`isJobPrunable`,
whose own doc comment states "`running` is never prunable at any age"), applied at
`packages/memory/src/file-store/jobs.ts:380-398`.
Test: `packages/memory/src/testing.ts:938`.

**INV-131.** Job-view filters (`state`, `limit`) and the reported next-due time are each
independently correct against a mixed set of `running`/`retry_wait`/`pending` jobs.
Production: `packages/memory/src/file-store/jobs.ts:163-210`.
Test: `packages/memory/src/testing.ts:975`.

**MIX-10.** `refreshOwnedAfterFence` deliberately ignores wall-clock expiry, because the
enclosing `store.exclusive` excluded any reclaim between the strict pre-fence and this post-effect
refresh; it must never be used as a heartbeat or a settlement check.
Production: `packages/memory/src/file-store/jobs.ts:268-280`; contract note at
`packages/memory/src/types.ts:363-372`.
Test: `packages/memory/src/testing.ts:832` shows it succeeding at `at = 20` against a
`lease_until` of 15.

**MIX-11.** `complete` erases `snapshot` from the record, so a settled job stops retaining
the run's payload.
Production: `packages/memory/src/file-store/jobs.ts:300`.
Test: `packages/memory/tests/component/jobs.test.ts:69`.

**MIX-12.** A file-backed job's basename must match `encodeRunId(job.run_id)` or the
record is reported `run_id_mismatch` and skipped.
Production: `packages/memory/src/file-store/jobs.ts:153-156`.
Test: `packages/memory/tests/integration/file-store-observability.test.ts:276`.

**MIX-13.** Job listings are page-bounded: `limit` is clamped into
`[1, DEFAULT_MEMORY_JOB_PAGE_SIZE=200]` and the page is kept sorted by `enqueued_at` descending.
Production: `packages/memory/src/file-store/jobs.ts:170-180`, `packages/memory/src/jobs.ts:36`.
**Unpinned** at the 200 bound; the ordering half is covered by `packages/memory/src/testing.ts:975`.

### Drain and worker

**MIX-14.** Readiness is checked *before* claiming: with no indexer runtime the drain only
peeks at the first waiting job and reports it `blocked`, consuming no attempt and taking no lease.
Production: `packages/memory/src/drain.ts:426-432`, `:461-464`.
Test: `packages/memory/tests/component/jobs.test.ts:111` (`state: "pending", attempts: 0`).

**MIX-15.** A `MemoryRecoveryRequiredError` thrown mid-pass releases the claim and stops
the whole pass rather than failing the job; a shutdown does the same, decided from *our* abort signal
rather than from the error's shape.
Production: `packages/memory/src/drain.ts:530-543`, reasoning at `:364-369`.
Test: `packages/memory/tests/component/observability.test.ts:182`, `:210`;
`packages/memory/tests/component/drain.test.ts:350` (three shutdowns leave `pending`, `attempts: 0`,
empty history).

**MIX-16.** The retention sweep is skipped entirely on a pass that saw no job at all, so a
quiet workspace never takes the tree lock for it.
Production: `packages/memory/src/drain.ts:596`.
Test: `packages/memory/tests/component/drain.test.ts:303`.

**MIX-17.** A blocked job is *reported* every pass but the log record is rate-limited,
keyed by `reason \0 run_id`, so a second stuck run or a new reason for the same run is never
swallowed by the first.
Production: `packages/memory/src/drain.ts:416-421`; the limiter is constructed once per tree, beside
the drain owner (`packages/memory/src/memory.ts:40`).
Test: `packages/memory/tests/component/observability.test.ts:70`, `:90`, `:139`.

**MIX-18.** One layer up, the worker's own `memory.drain.pass` log has two independent
suppression rules, distinct from MIX-17's per-job limiter: a pass that claimed nothing logs nothing
at all, and a pass that settled nothing but blocked something is rate-limited by a separate sampler
keyed by `blocked:<count>`; a pass that settled anything is always logged.
Production: `packages/memory/src/worker.ts:96-110`.
Test: `packages/memory/tests/component/worker.test.ts:224`.

**MIX-19.** A pass that settled nothing and blocked something waits the full worker
interval, rather than re-draining immediately on a due time already in the past.
Production: `packages/memory/src/worker.ts:128`.
Test: `packages/memory/tests/component/worker.test.ts:186`.

**MIX-20.** A poke storm coalesces into at most one follow-up pass and exactly one
`detachObserved` observation per created pass.
Production: `packages/memory/src/worker.ts:180-183`, `:209`.
Test: `packages/memory/tests/component/worker.test.ts:89`;
`packages/memory/tests/component/jobs.test.ts:143`.

**MIX-21.** The worker's timer stays armed through a tick where the resolver yields
nothing and through a drain that throws.
Production: `packages/memory/src/worker.ts:155`, `:166-175`.
Test: `packages/memory/tests/component/worker.test.ts:33`, `:60`.

**MIX-22.** A job whose run was already folded in, whose `provider_key` is absent or has
changed, whose provider is read-only, or which carries no snapshot converges straight to `completed`
with a naming note and **no model call**.
Production: `packages/memory/src/drain.ts:441-456`.
Test: `packages/memory/tests/component/drain.test.ts:397` (`provider-selection-unknown`, zero LLM
calls), `:462` (`provider-selection-changed`), `packages/memory/tests/component/jobs.test.ts:74`
(`already-indexed`).

**MIX-23.** A pass that ends in `no_progress` is terminal and is never replayed.
Production: `packages/memory/src/indexer/run.ts:207`.
Test: `packages/memory/tests/component/drain.test.ts:480`.

### Ingest and the kernel bridge

**MIX-24.** `enqueueFinishedRun` never rejects, and a throwing `onNotice` listener never
breaks it — on the success path or the failure path.
Production: `packages/memory/src/ingest.ts:132-138`, `:157-171`.
Test: `packages/memory/tests/component/ingest.test.ts:167`, `:239`.

**MIX-25.** A `blocked` settlement's notice carries `note` but never `indexer_run_id`,
while `failed` and `queued` both carry it.
Production: `packages/memory/src/ingest.ts:60-74`.
Test: `packages/memory/tests/component/ingest.test.ts:41`, `:54`.

**MIX-26.** `isIngestPending` is `true` only for `"started"` and `"queued"`; an absent or
unrecognized phase is not pending; `ingestPendingAfter` returns `undefined` for any non-
`memory_ingest` event so the caller's flag is left untouched.
Production: `packages/kernel/src/runs/memory-ingest-phase.ts:23-25`, `:53-57`.
Test: `packages/kernel/tests/unit/memory-ingest-phase.test.ts:12`, `:20`, `:30`.

**MIX-27.** The ingest close grace is 5 s sliding with a 15 s absolute ceiling, and no host
or test override may retain a settled run beyond 60 s.
Production: `packages/kernel/src/runs/memory-ingest-phase.ts:36`, `:39`, `:42`, enforced at
`packages/kernel/src/runs/managed-run.ts:178-192`.
Test: `packages/kernel/tests/unit/memory-ingest-phase.test.ts:41`.

### Broker, factory and health

**MIX-28.** A `retry_wait` settlement does not unsubscribe; exactly one terminal outcome
does, automatically; and a subscription for the same `(owner, run_id)` is replaced, never stacked.
Production: `packages/memory/src/job-broker.ts:18`, `:114`, `:132-135`.
Test: `packages/memory/tests/component/job-broker.test.ts:33`, `:45`, `:101`.

**MIX-29.** A publish with no subscriber is a silent no-op, and a listener's throw never
propagates to the drain loop.
Production: `packages/memory/src/job-broker.ts:131`, `:136-140`.
Test: `packages/memory/tests/component/job-broker.test.ts:68`, `:73`, `:126`.

**MIX-30.** The same run id in two owner scopes is isolated, and `closeOwner` cancels only
that owner's subscriptions.
Production: `packages/memory/src/job-broker.ts:108`, `:142-150`.
Test: `packages/memory/tests/component/job-broker.test.ts:135`, `:148`.

**MIX-31.** A workspace with a model but no engine deps still has a fully usable wiki; only
`index` degrades, reporting `note: "no-indexer"` with zero LLM calls.
Production: `packages/memory/src/factory.ts:279`, `packages/memory/src/memory.ts:96-105`.
Test: `packages/memory/tests/component/factory.test.ts:126`.

**MIX-32.** A settings change rebuilds the owner's `Memory` facade but never produces a
second store over the same tree.
Production: `packages/memory/src/factory.ts:234-252`, `:376-388`.
Test: `packages/memory/tests/component/factory.test.ts:489`, `:363`.

**MIX-33.** `health` never writes: its `tx` is a `Pick` of read methods only, and it works
against a store exposing nothing but `list`/`read`.
Production: `packages/memory/src/health.ts:148`.
Test: `packages/memory/tests/component/health.test.ts:150`.

**MIX-34.** `health` is deterministic for a fixed tree and a fixed `now`, orders errors
before warnings before info, and drops the *least* important findings when the overall `maxFindings`
cap truncates the sorted set. A separate, earlier `maxPerCode` cap (default 50) drops excess findings
of one code at collection time, before dedup or sort ever sees them — that drop does **not** set
`truncated` on its own; only the overall cap (or an independent `skip(...)`) does.
Production: `packages/memory/src/health.ts:191-198` (per-code cap), `:447-456` (overall cap and
sort), `:471` (`truncated`).
Test: `packages/memory/tests/component/health.test.ts:131`, `:138`, `:162`.

**MIX-35.** An incomplete catalog (a `MemoryStorageLimitError` from `list`) skips every
tree conclusion instead of reporting a partial wiki, while queue and recovery checks stay useful.
Production: `packages/memory/src/health.ts:209-218`, `:132-135`.
Test: `packages/memory/tests/component/health.test.ts:181`.

**MIX-36.** With no `jobs` reader supplied, `failed_index_job` and `stuck_index_job` are
reported as `skipped_codes` rather than as absent findings.
Production: `packages/memory/src/health.ts:417-418`.
Test: `packages/memory/tests/component/health.test.ts:175`.

**MIX-37.** Workspace-state capture reflects the workspace passed as `cwd`, never a parent Git
process's repository-local routing or temporary index. Production:
`packages/memory/src/workspace-state.ts:12-20`. Test:
`packages/memory/tests/integration/workspace-state.test.ts:11-49` injects `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, and `GIT_COMMON_DIR` while asserting the selected repository's branch, commit and
clean state.

---

## 6. Failure modes and degradation

| Condition | Detected at | Classification | Consequence |
| --- | --- | --- | --- |
| No indexer runtime resolves | `packages/memory/src/drain.ts:428` | `blocked`, reason `no_indexer` | job stays `pending`, **no attempt consumed**; log says "the learning is recovered whole once one is configured" (`packages/memory/src/drain.ts:99-101`) |
| Lease reclaimed mid-pass | `packages/memory/src/drain.ts:526`, `:507` | `blocked`, reason `lease_lost` | "whatever this pass wrote stands, and the claimant decides the rest" (`packages/memory/src/drain.ts:102`) |
| Tree frozen awaiting recovery | `packages/memory/src/drain.ts:530`; probed at `packages/memory/src/indexer/run.ts:167` | `blocked`, reason `recovery` | claim released, whole pass stops (`packages/memory/src/drain.ts:535`) |
| Host aborted the drain | `packages/memory/src/drain.ts:537` | `blocked`, reason `shutdown` | claim released, attempt refunded (`packages/memory/src/drain.ts:539`) |
| `executeRun` throws | `packages/memory/src/indexer/run.ts:197` | `generate`; terminal iff `ValidationError` | full retry budget unless terminal |
| Run answered `status: "error"` | `packages/memory/src/indexer/run.ts:206` | `generate`; terminal iff `no_progress` | as above |
| Run ended non-`completed` (cancelled, `budget_exhausted`, `soft_limit_declined`) | `packages/memory/src/indexer/run.ts:220` | `validate` | 2-attempt budget; the subject is **not** marked indexed (`packages/memory/src/indexer/run.ts:215-219`) |
| Pyramid still open at run end | `packages/memory/src/indexer/run.ts:224` | `validate` | 2-attempt budget |
| `markIndexed` failed or the claim was lost first | `packages/memory/src/indexer/run.ts:240-247` | `commit` | full retry budget |
| `MemoryPathError` escaping a tool | `packages/memory/src/drain.ts:342` | `apply`, terminal | fails immediately |
| Any other untagged throw | `packages/memory/src/drain.ts:343` | `apply`, non-terminal | full retry budget |
| Retry budget spent | `packages/memory/src/drain.ts:572` | `failed` | `memory.index.gave_up` at **error** level: "what that run could have taught this workspace is lost for good" (`packages/memory/src/drain.ts:582`) |
| Enqueue write failed | `packages/memory/src/ingest.ts:157` | `phase: "failed"` notice | run stays persisted; "memory will never cover it" (`packages/memory/src/ingest.ts:164`) |
| Drain itself threw | `packages/memory/src/worker.ts:166` | `memory.drain.failed` warn | timer re-armed at the full interval; the queue is durable |
| A job record cannot be parsed | `packages/memory/src/file-store/jobs.ts:110`, `:149` | `memory.job.record_corrupt` warn, sampled | the record is skipped: "that run's learning is lost and nothing will retry it" (`packages/memory/src/file-store/jobs.ts:97`) |
| A job file exceeds `metadataBytes` on write | `packages/memory/src/file-store/jobs.ts:116` | `MemoryStorageLimitError` throws | propagates out of `enqueue` |
| Prune failed | `packages/memory/src/drain.ts:600` | swallowed by `bestEffort` | the pass still reports normally |
| `onJobSettled` / `onNotice` / broker listener threw | `packages/memory/src/worker.ts:161`, `packages/memory/src/ingest.ts:135`, `packages/memory/src/job-broker.ts:138` | swallowed | never breaks the worker or the publisher |
| Git probe unavailable | `packages/memory/src/workspace-state.ts:42-58` | `undefined` | snapshot simply carries no `workspace_state`; debug-only log |
| Provider token neither declared nor built-in | `packages/memory/src/factory.ts:322` | `memory.provider.undeclared` warn, once | runtime resolves `undefined` → job blocked rather than burning retries (`packages/memory/src/factory.ts:311-314`) |
| Settings unreadable | `packages/memory/src/factory.ts:352`, `:274` | `memory.settings.unreadable` warn | run proceeds with memory off entirely |
| Neither `memory.model` nor `default_model` | `packages/memory/src/factory.ts:365` | `memory.model.absent` warn, once | `forOwner` → `undefined`; `forOwnerControlPlane` still resolves |

Bounded reads throughout: a job scan visits at most `MEMORY_STORAGE_LIMITS.scanEntries` (10 000)
entries and stops once accumulated bytes would exceed `corpusBytes` (32 MiB)
(`packages/memory/src/file-store/jobs.ts:142-147`, `packages/memory/src/storage-limits.ts:16`, `:20`).

Log events this subsystem emits, with level: `memory.job.blocked` (info, `packages/memory/src/drain.ts:420`),
`memory.job.converged` (debug, `packages/memory/src/drain.ts:474`), `memory.index.failed` (warn, `packages/memory/src/drain.ts:555`),
`memory.index.gave_up` (error, `packages/memory/src/drain.ts:575`), `memory.prune` (debug, `packages/memory/src/drain.ts:612`),
`memory.index.pass` (info, `packages/memory/src/indexer/run.ts:255`), `memory.drain.pass` (info, `packages/memory/src/worker.ts:99`),
`memory.drain.failed` (warn, `packages/memory/src/worker.ts:167`), `memory.run.enqueued` (info, `packages/memory/src/ingest.ts:152`),
`memory.run.enqueue_failed` (warn, `packages/memory/src/ingest.ts:158`), `memory.job.record_corrupt` (warn,
`packages/memory/src/file-store/jobs.ts:95`), `memory.workspace_state.unavailable` (debug, `packages/memory/src/workspace-state.ts:49-56`),
`memory.provider.undeclared` (warn, `packages/memory/src/factory.ts:326`), `memory.model.absent` (warn, `packages/memory/src/factory.ts:369`),
`memory.settings.unreadable` (warn, `packages/memory/src/factory.ts:353`).

---

## 7. Coupling

### 7.1 Outbound, runtime

| Depends on | Why the direction is forced | Static/dynamic |
| --- | --- | --- |
| `@clarvis/loop` (`executeRun`, `generateExecutionId`, `ExecuteRunDeps`, `StoredExecution`) | an index pass **is** a run — `packages/memory/src/indexer/run.ts:47` value-imports the engine; `packages/memory/package.json:73` lists it as a hard dependency | static, value |
| `@clarvis/loop/host` (`SUBMIT_RESULT_TOOL_NAME`) | the refusal set must contain the exact name the engine dispatches — `packages/memory/src/indexer/capability.ts:26` | static, value |
| `@clarvis/capability` | `sanitizeDeep`/`sanitizeText` (`packages/memory/src/jobs.ts:13`), `createRateLimiter`/`createSampler`/`bestEffort`/`detachObserved`/`NOOP_LOGGER` (`packages/memory/src/drain.ts:23-30`, `packages/memory/src/worker.ts:14-20`, `packages/memory/src/file-store/jobs.ts:6`), `FinalizeGate` (`packages/memory/src/indexer/pyramid.ts:14`), `handlerBaseOf`/`openCallEnvelope` (`packages/memory/src/indexer/capability.ts:25`) | static, value |
| `@clarvis/paths` | `workspacePaths`/`workspaceStatePaths` (`packages/memory/src/factory.ts:1`), `writeFileDurable` (`packages/memory/src/file-store/jobs.ts:7`), `ensureWorkspaceSubdir` (`packages/memory/src/file-store/layout.ts:4`) | static, value |
| `node:crypto` | `randomUUID` for the claim's fencing token (`packages/memory/src/drain.ts:20`), `createHash` for `encodeRunId` (`packages/memory/src/file-store/jobs.ts:1`) | static |
| the run's trace store | `planPass` reads the subject through `indexer.deps.traceStore.getById(owner, run_id)` (`packages/memory/src/indexer/run.ts:329`) — no direct `@clarvis/trace` import or manifest edge | structural, via `ExecuteRunDeps` from `@clarvis/loop` |

### 7.2 Inbound

| Consumer | Edge | Source |
| --- | --- | --- |
| `@clarvis/kernel` (`file-kernel`) | constructs the factory, supplies `runDeps`/`passRunDeps`/`loadPolicy`/`storeFor`/`serverPort`/`pluginPort`/`executablePort` | `packages/kernel/src/file-kernel.ts:860-882` |
| `@clarvis/kernel` (`kernel.ts`) | registers `memoryFactory.stop()` on the kernel lifecycle | `packages/kernel/src/kernel.ts:280` |
| `@clarvis/kernel` (`memory-service`) | exposes `health`/`jobs`/`retryJob` over the protocol | `packages/kernel/src/memory/memory-service.ts:107,132,151` |
| `@clarvis/kernel` (`managed-run`, `run-service`, `workflows-service`) | uses `ingestPendingAfter` / `DEFAULT_INGEST_CLOSE_GRACE_MS` to decide whether a run's stream may close | `packages/kernel/src/runs/managed-run.ts:207`, `packages/kernel/src/runs/run-service.ts:96`, `packages/kernel/src/workflows/workflows-service.ts:155` |
| `@clarvis/code` | reads `memory_ingest` phases through the kernel's policy export | `packages/kernel/src/policy.ts:11`, consumed at `packages/code/src/run-host.ts:10`, `:397` |
| memory's own run capability | calls `enqueueFinishedRun`, `factory.subscribeToRun`, `factory.poke` in `onRunEnd` | `packages/memory/src/capability.ts:330-350` (`onRunEnd`) |

### 7.3 What the host, not this package, must compose

`IndexerRuntime.passDeps` must differ from `deps` in exactly two ways, both assembled by the host: the
workspace-hooks capability is **absent from the list** (not merely inactive), and the memory
capability carries `enqueueOnRunEnd: false` (`packages/memory/src/types.ts:50-67`). The kernel does
precisely that at `packages/kernel/src/memory/pass-deps.ts:36-41` — a `.filter(c => c.name !==
HOOKS_CAPABILITY_NAME)` plus `createMemoryCapability(memoryFactory, { enqueueOnRunEnd: false })`.
The `absent vs inactive` distinction is stated as load-bearing for seed-block survival
(`packages/memory/src/types.ts:55-62`; same reasoning restated at
`packages/kernel/src/memory/pass-deps.ts:18-27`).
`packages/kernel/tests/unit/index-pass-deps.test.ts:63-99` pins the hooks removal, memory
registration, enqueue suppression, ordering, pass-through and non-mutation properties.

---

## 8. Open questions

1. **Why `passDeps` must remove hooks rather than deactivate them is asserted, not demonstrated.**
   Both `packages/memory/src/types.ts:55-62` and `packages/kernel/src/memory/pass-deps.ts:18-27`
   describe `buildEntrySeed` dropping a carried block when a registered capability's marker is not
   live, and name `runtime/entry-seed.ts` as the mechanism. That engine module is outside this
   document's scope, and no test in the memory or kernel scope exercises the
   registered-but-inactive case. Treat the rule as unverified here.

2. **`DEFAULT_MEMORY_JOB_PAGE_SIZE` is exported from `packages/memory/src/jobs.ts:36` but not
   re-exported from the barrel** (`packages/memory/src/index.ts:126-144`). The file and in-memory
   adapters both consume it (`packages/memory/src/file-store/jobs.ts:171`,
   `packages/memory/src/testing.ts:281`); whether omitting it from the package surface is deliberate
   is not stated in the source.

3. **The 500-char job-history error cap and 200-job page ceiling remain unpinned.** The history
   length cap is now directly tested (`packages/memory/tests/unit/jobs-policy.test.ts:85`), and the
   corrupt-record filename check is covered by
   `packages/memory/tests/integration/file-store-observability.test.ts:276`; only the two remaining
   bounds lack direct assertions (MIX-08, MIX-13).

4. **`Memory.index` is a direct, unqueued entry point** (`packages/memory/src/memory.ts:91`) used by
   integration and factory tests and by no `src` caller in scope outside that
   facade. Whether any production host still calls it — as opposed to always going through
   `enqueue` + `drain` — is undetermined.

5. **The isolated pass's `budgets.max_index_ops` overage message is described but not located here.**
   `packages/memory/src/indexer/capability.ts:109-111` says the (N+1)th mutating call is "refused with
   a message the model can act on"; that behaviour lives in `buildMemoryToolset`
   (`packages/memory/src/toolset.ts`), which belongs to the *memory-capability-and-tools* document.

6. **Store atomicity, `store.exclusive` re-entrancy and journal recovery** are only referenced here.
   `packages/memory/src/indexer/run.ts:32-37` states the file store's lock is re-entrant via `AsyncLocalStorage` and that
   "Nothing enforces" the rule against starting a pass inside `store.exclusive`. Verification of that
   claim belongs to *memory-wiki-store*.

7. **Prefix-cache pricing.** Several comments quantify the cost of breaking the prefix
    (`packages/memory/tests/architecture/indexer-surface-identity.test.ts:12` cites "120:1 against a
    cache read" and points at [cross-cutting/prompt-cache.md](../cross-cutting/prompt-cache.md), which is outside this document's scope). The verified mechanism
    is only that the surfaces are asserted equal; the economics are not derivable from this code.

8. **Rationale for specific constants** — `INDEXER_ITERATION_LIMIT = 12`,
    `INDEXER_TOKEN_LIMIT = 200_000`, `CACHE_EVIDENCE_MIN_INPUT = 100_000`, `DEFAULT_LEASE_MS =
    600_000`, `DEFAULT_LIMIT = 5`, `DEFAULT_JOB_RETENTION`'s 7/30-day split, the broker's 30-minute
    leak guard — is given as prose in the source and echoed above where the source states it. None of
    it is verifiable from the code itself; where a test carries a measured number (the
    `no-cache-observed` production case at
    `packages/memory/tests/unit/indexer-continuation.test.ts:191`), the test is cited instead.

9. **`MemoryBatchCommit.mark_indexed` has a production mechanism and no production producer.**
   `packages/memory/src/file-store.ts:163` and the in-memory adapter replay it, while repository-wide
   source search finds construction only in test fixtures. `packages/memory/src/indexer/run.ts:28-31`
   says its former producer was removed; whether the field remains intentionally for external
   adapters or should now be removed is not stated.
