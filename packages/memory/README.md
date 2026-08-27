# `@clarvis/memory`

Workspace-local execution memory for AI agents, modelled as a **navigable
markdown wiki** the model reads and edits directly — no vectors, no embeddings.

The knowledge is markdown and nothing else; the machinery around it (the durable
index queue, the batch journal, revision metadata) is JSON under dot-directories
the wiki's own listing never shows.

The package sits **above** the engine and composes it — the `@clarvis/workflows`
shape. It depends on `@clarvis/paths` (the directory vocabulary),
`@clarvis/capability` (the shared secret-redaction rules, and the contract its
`./capability` entry implements) and `@clarvis/loop` (an index pass **is** an
`executeRun`), plus `zod`. The loop does not name, load or construct it: the
kernel builds the factory and folds `createMemoryCapability` into
`deps.capabilities`.

Memory's real-loop integration tests consume the engine-owned infrastructure from
`@clarvis/loop/testing`; the package has no direct runtime or test dependency on the MCP client or
trace implementation.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> is not published independently.

## Contract

The package contract is split by responsibility: the wiki and store in
[`memory-store.md`](../../specs/capabilities/memory-store.md), run composition and tools in
[`memory-capability.md`](../../specs/capabilities/memory-capability.md), and finished-run indexing in
[`memory-indexer.md`](../../specs/capabilities/memory-indexer.md). External providers are governed by
[`provider-executables.md`](../../specs/capabilities/provider-executables.md).

## Memory model

```text
<ws>/.clarvis/memory/
  PROFILE.md              # workspace-wide compiled knowledge + root index
  infra/
    TOPIC.md              # compiled domain knowledge + topic index
    bun/
      MEMORY.md           # detailed knowledge, commands, examples, pitfalls
```

The hierarchy is a semantic pyramid. Knowledge is intentionally repeated with
progressive compression: `MEMORY.md` contains the full detail, `TOPIC.md`
compiles the important knowledge from its descendants, and `PROFILE.md`
compiles the most important workspace-wide operational knowledge. Every level
must be useful by itself; it is not merely a list of links.

Every document is markdown with a small frontmatter block:

```markdown
---
description: pinned to 1.4.0 via mise
tags: [bun, infra]
---

# Bun

Body — the durable, non-obvious knowledge.
```

Navigation between documents is **not** hand-maintained. A deterministic,
stateless `reindex` walks the tree and regenerates each index file's `## Contents`
section from each child's frontmatter `description:`. Other prose and sections
are never touched, and no implementation markers are written into the wiki.
A person can hand-edit memory freely — as long as the `description:` line is
present, the next reindex wires it in. There is no checksum or cached index.
The model owns the prose before that section and updates PROFILE, TOPIC, and
MEMORY together when detailed knowledge changes what its ancestors should say.
Host callers already inside a memory unit of work may pass that transaction to
`memory.reindex(tx)`; the facade uses it directly instead of attempting a nested
exclusive lock. Calls without a transaction acquire the store lock themselves.

## Usage

```ts
import { createFileMemory } from "@clarvis/memory";

const memory = createFileMemory({
  root: `${process.cwd()}/.clarvis/memory`,
  // Resolves what one index pass runs as: the engine deps, the owner, and the
  // model plus providers its request declares. Called per pass, so a model
  // configured later takes effect without a rebuild. Omit it to disable the
  // indexer; the tools and seeding still work.
  indexer: () => ({ owner, deps, modelRef: "anthropic/claude-haiku", providers }),
});

// At run start: inject the PROFILE index as a <memory>…</memory> block.
const seed = await memory.seed("Work on the build again");

// At run end: fold the finished run into the wiki, autonomously.
await memory.index({
  run_id: "run-123",
  workspace: process.cwd(),
  status: "completed",
  started_at: Date.now() - 1_000,
  ended_at: Date.now(),
  task: "Fix the build",
  final_answer: "The build now passes.",
  tool_calls: [
    {
      tool_name: "bash",
      arguments: { command: "bun test" },
      result_excerpt: "42 pass",
      error: null,
      started_at: Date.now() - 500,
      ended_at: Date.now(),
    },
  ],
});
```

The per-run indexer is a real `executeRun` over the same seven wiki tools an
agent gets, not a single completion returning a JSON array of whole-document
writes. It edits through `edit_memory`, and a finalize gate refuses to let it
stop with the pyramid open — a touched leaf must ship with each ancestor
`TOPIC.md` and with `PROFILE.md`. Most runs deserve no change at all.
Already-indexed run IDs are skipped. Runs without tool calls are still examined:
user instructions and final answers may contain durable knowledge.

When the kernel selects an executable or plugin Memory provider, the same indexing policy runs over
that provider's serializable tools. Writable providers receive indexing calls through their own
session; read-only providers are skipped and never receive a queued job. Each queued job records the
effective provider key. If selection changes before the job drains, Clarvis marks the old job skipped
instead of applying it to another backend. Mutations and terminal `no_progress` outcomes are never
replayed automatically.

### Telling it what to record

What is worth remembering differs per person and per project, so the editorial
half of the instruction is operator-authored, in two files:

| file                             | scope                        | shared?         |
| -------------------------------- | ---------------------------- | --------------- |
| `<global>/memory-policy.md`      | this person, every workspace | never           |
| `<ws>/.clarvis/memory-policy.md` | this project                 | yes — committed |

`<global>` is `~/.clarvis` unless `CLARVIS_HOME` says otherwise.

Each file is **plain markdown prose** — no frontmatter, no schema, no required
headings. Write what you would tell a new teammate about what to write down.
Create it with any editor; nothing needs to be registered, and there is no
command to run.

`~/.clarvis/memory-policy.md` — personal, follows you everywhere:

```markdown
Keep the exact command line, never a paraphrase of it. If I had to discover a
flag, that flag is the point of the note.

Record the _why_ behind a workaround, not just the workaround. A fix with no
reason gets cargo-culted into the next project.

Do not record my personal shell aliases or editor setup — those live in my
dotfiles and go stale here.
```

`<ws>/.clarvis/memory-policy.md` — this project's, committed and shared:

```markdown
This repo's pain is almost always the build and the test harness. Prefer
recording anything about `bun`, the coverage gate, or CI flakiness.

Never record customer names, ticket contents, or anything from `fixtures/`.

Deployment steps change every quarter — record them only with the date they
were verified, so a stale one is obvious.
```

Both take effect on the **next indexing pass**: the files are read per pass, so
editing one needs no restart. Each scope is bounded at 4,000 characters on its
own — not a shared budget, so a long project file cannot crowd out your personal
one.

They **concatenate**, global first, so the project reads as a refinement rather
than a replacement. That is a deliberate departure from `guard-judge.md`, which
takes the nearest scope whole: a judging prompt is one complete instruction, but
"always keep the exact commands" and "record the migration traps here" are both
true at once, and shadowing would drop the personal half the moment a project
added its own. A blank file counts as absent, as it does for `guard-judge.md` —
emptying one is how you turn it off, and it is the same as deleting it.

It governs **what**, never **where**:

```markdown
<!-- works: an opinion about what deserves a note -->

Record flaky-test symptoms with the exact failure output.

<!-- ignored: an instruction about structure -->

Always file everything under `infra/`, and never create more than four topics.
Skip PROFILE.md when the change is small.
```

The three levels are mechanism — the finalize gate enforces closure over them,
so a policy able to redefine the structure would produce a pass the gate pushes
back until its budget ran out. Topic _names_ are the opposite: they are content,
and stay emergent. Fixing a top-level taxonomy would force knowledge into slots
decided before anyone knew what the workspace was about, and leave empty topics
nobody prunes. Depth is mechanism; breadth is emergent.

Nothing rejects a structural line — the file is prose, not a schema. The pass is
simply told, ahead of your text, that structure is not yours to set, so such a
line is wasted rather than harmful.

The composed text is appended to the isolated pass's base prompt and to the
continuation's trailing message — the two positions that cost no prompt cache.
It must never reach the capability's `systemSection`, which sits in every
ordinary run's system head, where editing the file would invalidate every run's
cached prefix.

### The two passes

A pass runs one of two ways, and the difference is entirely about what the
provider's prefix cache will serve.

**Continuation (hot).** The pass is a `continue_from` of the run it indexes, with
the indexing instruction appended as a trailing user message — an append, which
`specs/cross-cutting/prompt-cache.md` prices at full prefix survival. It runs on the host's own
capability list with the pass capability **prepended**: that capability
advertises no tools, no system section and no seed block, so the indexed run's
tool array and system head survive byte-identical, and its handlers win by
registration order alone. Tools the pass inherited are advertised and then
**refused at dispatch** — dropping them from the array would re-bill the request.
The pass uses the session's key with `_memory` appended, so its divergent trailing
instruction cannot displace the interactive conversation's hot prefix. A key at
the 512-character request limit is truncated before the suffix, never after it.

**Isolated (cold).** The pass gets its own `memory-indexer` profile, its own tool
array and a rendered run digest. Always correct, and merely more expensive. It is
what runs when the indexed run left no resumable `final_context`, declared MCP
servers (whose tools are part of the cached array), or was answered by a
different model than the one indexing it — a cache belongs to a model, so setting
`memory.model` to something cheaper is choosing this path deliberately. It also
uses this path when a stored profile carries a grant the pass deps do not declare;
workflow managers are the common case because their capability is injected only
for the primary manager run. Retrying that continuation would fail validation
before a model call, so the digest path preserves memory indexing instead.
`IndexReport.continuation_blocker` reports which applied.

The host composes the continuation's deps (`IndexerRuntime.passDeps`) and must
**remove** the workspace hooks capability rather than deactivate it: the engine
keeps a carried seed block only while its marker is still live, so a registered
but inactive capability makes the block the continuation carried get dropped out
of the middle of the transcript. A capability the run never registers is
unrecognised instead, and its block survives in place.
The ordinary memory capability is replaced, not duplicated, by the pass form
whose `onRunEnd` is disabled; every other long-lived capability, including tasks,
stays in registration order.

## The index queue

`index()` is not called on the response path. A finished run is **enqueued** as a
durable job (`enqueue`), and a background worker (`createIndexWorker`) drains the
queue on a timer, so a process that dies mid-pass loses nothing it had accepted
responsibility for. `drainIndexJobs` owns one pass of that queue and never
sleeps; all waiting lives in the worker's injectable clock, which is what lets a
test move time by hand.

`MemoryFactory` owns one process-lived worker per activated owner. Hosts call
`start(owner)` or `poke(owner)`, and settlement subscriptions are keyed by both
`owner` and `runId`; identical run IDs in different owner scopes cannot observe
each other's jobs. `stop()` closes every worker and prevents the factory from
creating another one. Tool-server providers are likewise bound through
`serverPort.forOwner(owner)` before their model-facing tools are built.

Kernel construction does not call `start(owner)`. A host explicitly releases durable queue recovery
after its first-paint or readiness boundary, so old index jobs cannot put model inference on the
critical boot path. `poke(owner)` remains lazy: a newly completed primary run can enqueue and begin
draining without waiting for a restart. Auxiliary workflow leader runs receive no memory capability
and enqueue no jobs; their primary manager contributes the workflow's one durable job.

Queue claims carry a `lease_owner`, an opaque fencing token and an expiry. While an index pass runs,
the worker renews that exact claim at half its lease interval. Heartbeats and complete/fail/release
all require owner, token **and a live expiry**; a worker that wakes after expiry cannot rescue or
settle its old claim before another worker gets a chance to reclaim it.

Every indexer mutation is fenced under the same unit of work that serializes reclaim: a strict live
check runs immediately before the wiki batch, external-provider write or `markIndexed`, and an
owner/token refresh runs immediately afterward before releasing that unit of work. Only this paired
post-effect refresh may cross the wall-clock expiry, because its successful pre-check already admitted
the effect and the held unit of work made reclaim impossible while it ran. A reclaimed worker is
aborted before its next mutation and cannot mark the run indexed or settle over the new claimant.

An owner worker drains only the store returned for that owner; an expired lease can be reclaimed after
a crash, while orderly shutdown releases the claim and refunds its attempt. A factory with no
`storeFor` deliberately keeps the single shared-store behavior of the local product; multi-owner
hosts supply isolated stores.

Retry policy is per failure phase: a pass that could not be produced at all
(`generate`) gets the full attempt budget, while one that finished without the
pyramid gate ever passing (`validate`) gives up far sooner — it will not close on
the fifth try if it did not on the second. An abort is not a failure at all, and
is decided from the drain's own signal rather than the error's shape, because
every provider surfaces cancellation differently. A workspace with no indexer
model reports its due jobs `blocked` — no attempt consumed, no lease taken — so
the learning is recovered whole the day a model is configured.

## Search, history and health

- **Ranked query** — `queryMemory` / the `query_memories` tool score whole
  documents with BM25 over title, description, tags, path and body, with field
  weighting and length normalization. Distinct from `grep`, which returns literal
  line matches; they answer different questions.
- **Bounded working set** — a ranked query considers at most 1,000 documents,
  reads at most 512 KiB from one document and retains at most 32 MiB of corpus;
  the result names the budget that made it incomplete. The filesystem adapter
  walks directory handles instead of materializing whole directory listings and
  streams `version()` hashing.
- **Revisions** — every automatic overwrite is reversible. `history`,
  `readRevision` and `restore` read and roll back superseded bodies, retained by
  count, age and an absolute floor.
- **Health** — `health()` is deterministic, model-free and read-only: totals plus
  findings ordered by severity, each naming the action that resolves it.

### Storage working set

`MEMORY_STORAGE_LIMITS` is the single hard-limit authority for the built-in
stores. One wiki document and one revision pre-image may be 2 MiB; one journal,
job or revision-metadata record may be 1 MiB. Frontmatter and recording-policy
probes read a 64 KiB prefix. A repository operation visits at most 10,000
directory entries, one recoverable batch retains at most 256 operations, and a
read/reindex/batch working set admits at most 32 MiB in aggregate.

File reads open a descriptor, inspect it before allocating, and read at most the
limit plus one proof byte. A sparse or concurrently growing file therefore
cannot turn its apparent size into an allocation. Direct reads throw the typed
`MemoryStorageLimitError` for oversized persisted data. A document-catalog walk
uses one look-ahead entry and `list` / `grep` / `version` all throw that same
typed error rather than returning a silently incomplete catalog. Content search
remains deliberately bounded by its documented line and wall-clock budgets;
health reports or skips checks it could not complete, and recovery freezes
instead of sweeping an oversized journal or pre-image.
Document, revision and journal writes validate their complete payload before
creating durable state. Batch staging applies the same aggregate bound before
the first revision or journal byte is persisted.

## Observability

The package writes to an injected `Logger` (`@clarvis/capability`) and to nothing else; absent one
it resolves to `NOOP_LOGGER`, so every call site below is unconditional. The kernel supplies
`componentLogger("memory")` to `createMemoryFactory`, which threads it into the per-owner store —
its tree lock, journal recovery and job records — and into every `Memory`, and from there into the
drain and the index pass. There is **no logging key** in the `memory:` block and no per-run
parameter: verbosity is `CLARVIS_LOG_LEVEL` / `CLARVIS_LOG` only
(`specs/cross-cutting/observability.md` §2.6). One threshold is its own knob,
`CLARVIS_MEMORY_LOCK_WARN_MS` (default 5000).

The index queue is durable and drains in the background, which is precisely what makes its failures
invisible: nothing on a run's response path can see a retry, a give-up, or a workspace whose learning
is only waiting for a model.

| Level | `event`                              | Fields                                                                                                             |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| info  | `memory.index.pass`                  | `run_id`, `indexer_run_id`, `pass` (`continuation`/`isolated`), `continuation_blocker`, `written`, `deleted`, `ms` |
| warn  | `memory.index.failed`                | `run_id`, `indexer_run_id`, `phase`, `terminal`, `attempts`, `max_attempts`, `next_state`, `not_before`            |
| error | `memory.index.gave_up`               | `run_id`, `phase`, `attempts`, `history_phases[]`                                                                  |
| info  | `memory.job.blocked`                 | `run_id`, `reason` (`no_indexer`/`lease_lost`/`recovery`/`shutdown`)                                               |
| debug | `memory.job.converged`               | `run_id`, `note`                                                                                                   |
| warn  | `memory.job.record_corrupt`          | `file`, `reason` — sampled, first eight of a shape then powers of two                                              |
| warn  | `memory.recovery.applied`            | `batches`, `rolled_forward`, `rolled_back`, `swept`, `required`, `blocked_batch_id`                                |
| warn  | `memory.lock.held_long`              | `lock_dir`, `held_ms`, `nested`, `threshold_ms`                                                                    |
| debug | `memory.lock.wait`                   | `waited_ms`, `stolen`                                                                                              |
| debug | `memory.prune`                       | `removed`, `kept_failed`                                                                                           |
| info  | `memory.drain.pass`                  | `claimed`, `completed`, `retried`, `failed`, `blocked`                                                             |
| warn  | `memory.drain.failed`                | `cause`                                                                                                            |
| warn  | `memory.settings.unreadable`         | `cause`                                                                                                            |
| warn  | `memory.model.absent`                | — (once per factory)                                                                                               |
| warn  | `memory.provider.undeclared`         | `provider`, `model` (once per factory)                                                                             |
| warn  | `memory.seed.provider_failed`        | `provider`, `cause`                                                                                                |
| info  | `memory.run.enqueued`                | `execution_id`, `state`                                                                                            |
| warn  | `memory.run.enqueue_failed`          | `execution_id`, `cause`                                                                                            |
| debug | `memory.document.skipped`            | `path`, `reason` (`open_frontmatter`/`no_description`)                                                             |
| debug | `memory.workspace_state.unavailable` | `cause`                                                                                                            |

Workspace-state capture runs Git against the explicit workspace directory after removing Git's
repository-local environment. A parent hook's temporary index or repository routing therefore cannot
replace the branch, commit, or dirty state stored in a `RunSnapshot`; transport-neutral process inputs
remain inherited. A missing repository, missing Git executable, timeout, or other probe failure still
degrades to an absent `workspace_state` and the debug event above. The three probes run in parallel,
but every launched child settles before capture returns, including on failure; a sibling therefore
cannot keep the workspace as its current directory while the caller tears that workspace down.

Three of these are worth their own note.

**`continuation_blocker` used to be computed and thrown away.** `planPass` produces it and
`IndexReport` carries it, and no source file read it — so "why did every pass fall back to the
isolated form and pay full price instead of hitting the provider's prefix cache?" had no answer in
production. It is now on `memory.index.pass` **and** on `MemoryDrainReport.jobs[]`. The event is
emitted from `indexRun` after `planPass` has returned, never from inside
`buildIndexerContinuationRequest`, and it reads nothing off the subject's `final_context`: the
continuation's three byte-identical surfaces are the whole point of the hot path.

**`memory.lock.held_long` is the enforcement for a rule nothing else enforces.** "Never start a pass
from inside `store.exclusive`" cannot deadlock, because the store's lock is re-entrant — it would
silently hold the tree lock for a whole inference, blocking the wiki tools, the memory panel and
every concurrent run's seed. A hold past `CLARVIS_MEMORY_LOCK_WARN_MS` says so, and `nested`
distinguishes a re-entrant hold from a slow one.

**`memory.document.skipped` is per document and therefore guarded.** The walk it sits in runs inside
`store.exclusive`, so the bindings object is built only after `levelEnabled(logger, "debug")` has
already said yes — the level check inside a backend would be too late, because the allocation happens
at the call site.

Never logged: a document body, a seed block, a frontmatter value, or any model-authored prose. Every
field above is an id, a count, an enum or a path. Failure text passes through `sanitizeText` /
`sanitizeErrorMessage` exactly as it did before. A pass is a real `executeRun` with its own persisted
trace, so `indexer_run_id` **points at** that trace rather than restating it; `health()`,
`MemoryService.jobs`/`retry` and the `MEMORY_INGEST_EVENT` capability channel remain the product
surfaces and are not duplicated here.

## Tools

`memory.tools` are host-neutral, confined to the tree, and never throw:

- `list_memories` / `read_memory` / `grep_memories` / `query_memories` — navigate
  and search the wiki.
- `write_memory` / `edit_memory` / `delete_memory` — maintain it (each mutation
  triggers a reindex).

The read-only `file` provider accepts at most 64 declared paths, 1 MiB per
document and 8 MiB across one call by default. Oversized inputs are not loaded
and the answer explicitly says it is incomplete. Durable file-backed job scans
visit at most 10,000 directory entries, read at most 1 MiB from a job record and
retain a top page of at most 200 jobs; counts, next-due lookup and claims fold
over the scan without collecting the queue.

The agent may write memory directly during a run; the same tools back an owner's
kernel/MCP editing surface.

`pinned:` and `authority: confirmed` are the owner's alone, and the rule binds
every non-owner caller — the model's tools exactly as much as the autonomous
indexer. Automation may neither grant itself a pin nor take one off (an edit
that drops the `pinned:` line, or that breaks the closing `---` so the document
parses without it, is refused just as a wholesale replacement is), and it may
never raise a document to `confirmed`. Lowering authority is allowed: marking
knowledge `contested` is how automation records that it looks stale. A surgical
`edit` to a pinned document is allowed by design — pinning marks content as the
owner's, not as frozen.

`grep_memories`' `regex` mode honours a bounded dialect: backreferences,
lookaround, a quantifier applied to a group and patterns carrying more than
three of `* + ? { |` are refused and fall back to a keyword search. The scan is
capped in pattern length, in line length, in lines examined and in wall clock,
because neither runtime offers a linear-time engine and a single `RegExp.test`
cannot be interrupted once it has started.

## Entry points

- `@clarvis/memory` — memory API, store, reindex, queue, query, schemas and
  public types.
- `@clarvis/memory/schemas` — Zod schemas for configuration and indexer output.
- `@clarvis/memory/testing` — an in-memory store, its conformance suite, and a
  clock whose time only moves when a test moves it.
- `@clarvis/memory/capability` — the loop adapter: `createMemoryCapability`, the
  per-owner `MemoryFactory`, the post-run index enqueue, the
  `ExecutionRecord` → `RunSnapshot` adapter and the memory toolset.

`@clarvis/memory/settings` carries the `memory:` block and the per-run `memory` param, plus
the capability's name and its ingest event kind. A host registers the spec —
`@clarvis/kernel` does it at module load in `config/capability-registry.ts`,
beside `plans` and `workflows` — and the engine never declares any of it. The
block used to live inside the loop purely so the settings schema could spread it
statically, which forced its zod shape and this capability's name to exist twice
and be pinned equal by a drift test; both now have one owner.

`@clarvis/memory/capability` stays a separate, heavier entry because it reaches the whole
package facade. `@clarvis/memory/settings` deliberately does not, so a host can map an ingest
event without loading the wiki.

A provider may be a built-in wiki/file/MCP backend, a direct executable, or an enabled plugin's
`capabilityExecutables.memory` service. Direct services run from the workspace and plugin services
from the installed plugin directory. Both speak the language-neutral JSON-RPC protocol described in
[`specs/capabilities/provider-executables.md`](../../specs/capabilities/provider-executables.md); Memory receives only a
narrow executable-session port and never imports provider code.

The service declares whether it is writable during initialization. Clarvis continues to own tool
schemas, write authorization, seed wrapping and sanitization, and indexing policy. A plugin offers a
service but cannot select itself; installation, enablement and explicit provider selection authorize
startup.

## Which model gate applies

The capability resolves through `MemoryFactory.forOwnerControlPlane`, **not**
`forOwner`. `forOwner` gates on the indexer model and now has exactly one
consumer, the background worker, which genuinely cannot drain without one.

Under the old gate a workspace with no `default_model` lost the seed block, all
seven wiki tools and the post-run enqueue _together_ — it could not even read
what earlier runs had written. **A missing indexer model costs a run its
learning, never its memory.**

## Test ownership

The suite is classified by the lowest boundary that can observe each behavior:

- `tests/unit/` owns pure policy, parsers, tokenization, request decisions and bounded data transforms.
- `tests/component/` composes memory capabilities, providers, drain/factory/job orchestration and
  runtime tools exactly once over the in-memory store or explicit fakes; those suites do not open a
  filesystem merely to prove collaborator behavior.
- `tests/contract/` has one `MemoryStore` conformance table for document, batch, revision, ledger and
  job-state semantics. The same table is the sole shared-behavior owner for the file and in-memory
  adapters.
- `tests/integration/` keeps real filesystem layout, wiki mutations, journals, recovery, provider
  loading and indexer/loop execution. `capability-loop.test.ts` is the sole owner of the real
  capability→loop seam: seed/tool composition, the awaited durable enqueue and cancelled-run
  learning. File-only job cases are limited to reopen durability and safe run-id encoding; external
  edits, revision bytes, crash recovery and machinery layout stay real.
- `tests/architecture/` protects public barrels, eager-import boundaries and cross-surface identity.

Shared fixtures live in `tests/helpers/`; pure data, filesystem resources, contract-only capability
doubles and the real indexer runtime are separate modules so a lower tier does not load an effect it
does not observe. Run one layer with `test:unit`, `test:component`, `test:contract`,
`test:integration`, or `test:architecture`. The ordinary `test` and `test:coverage` scripts still
discover the complete suite.

Capability gates and surfaces remain in `tests/component/capability.test.ts`; notice translation and
enqueue failure handling live in `tests/component/ingest.test.ts`; settlement lifecycle lives in
`tests/component/job-broker.test.ts` and `tests/component/factory.test.ts`. Higher-level hosts should
retain only composition sentinels rather than repeat those matrices.

## Development

Run commands from the monorepo root:

```bash
bun --filter @clarvis/memory build
bun --filter @clarvis/memory typecheck
bun --filter @clarvis/memory test
bun --filter @clarvis/memory lint
bun --filter @clarvis/memory format:check
```

The package requires Bun 1.4.0 or newer, which is also the version the
monorepo pins.
