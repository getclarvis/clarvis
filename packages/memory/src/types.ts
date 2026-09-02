/**
 * Public types for @clarvis/memory.
 *
 * Memory is a navigable markdown wiki, workspace-local, that the model reads and
 * edits directly: a root `PROFILE.md` compiles workspace-wide knowledge,
 * `<topic>/TOPIC.md` compiles a domain, and `<topic>/<sub>/MEMORY.md` keeps the
 * full detail. Each layer also links downward. The knowledge tree is Markdown;
 * durable queue and recovery machinery live beside it. Small run/job contracts
 * are split into dependency-light modules so persistence code does not import
 * this aggregate host-facing surface back through a type cycle.
 */
import type { ProviderConfig } from "@clarvis/capability";
import type { ExecuteRunArgs, ExecuteRunDeps, ExecuteRunOutcome } from "@clarvis/loop";
import type { MemoryBatchCommit, MemoryRecoveryReport } from "./journal.ts";
import type {
  MemoryIndexJob,
  MemoryJobFailure,
  MemoryJobLease,
  MemoryJobState,
  MemoryJobTransition,
} from "./job-contract.ts";
import type { MemoryRevision, MemoryRevisionSource } from "./revisions.ts";

import type { RunSnapshot } from "./run-contract.ts";
export type { RunSnapshot, ToolCallEvent, WorkspaceState } from "./run-contract.ts";

/**
 * Everything one indexer pass needs from the host to run as a real agent run.
 *
 * @remarks An indexer pass is an `executeRun`, so it needs the shared engine
 * deps — but also the owner it is scoped and persisted under, and the model plus
 * provider instances its request must declare (the request schema requires at
 * least one provider, and every profile's model token has to match one).
 * `deps.capabilities` is replaced wholesale by the pass; nothing else is used
 * from it beyond what any run needs.
 */
export interface IndexerRuntime {
  owner: string;
  deps: ExecuteRunDeps;
  modelRef: string;
  providers: readonly ProviderConfig[];
  /** Host-owned execution boundary for lifecycle and Extension Profile admission around every pass. */
  executeRun?: (args: ExecuteRunArgs) => Promise<ExecuteRunOutcome>;
  /** Same memory provider selected for the run being learned from. */
  memoryProvider?: MemoryProvider;
  /** Stable identity used to prevent a queued run from crossing provider changes. */
  memoryProviderKey?: string;
  /**
   * The deps a pass uses when it continues the run it indexes, when the host
   * built them.
   *
   * @remarks Distinct from {@link IndexerRuntime.deps} in exactly two ways, both
   * assembled by the host because the host is what owns capability composition:
   * the workspace hooks capability is **absent**, and the memory capability
   * carries `enqueueOnRunEnd: false`.
   *
   * Absent — not merely inactive — is the load-bearing word. A registered
   * capability that declines to emit its seed block leaves its marker out of the
   * live set, and `buildEntrySeed` then drops the block the continuation
   * carried, deleting an entry from the middle of the transcript and re-billing
   * everything behind it. A capability the run never registers is not
   * recognised at all, so its carried block reads as ordinary history and
   * survives in place. Removing hooks therefore keeps the prefix intact *and*
   * keeps a user's `PreToolUse` hooks from firing on the pass's own writes.
   *
   * When undefined the pass has no continuation path available and runs
   * isolated, which is always correct and merely more expensive.
   */
  passDeps?: ExecuteRunDeps;
  /**
   * The operator's recording policy, already composed and bounded.
   *
   * @remarks Appended to whichever instruction the pass is given — the isolated
   * pass's base prompt, or the continuation's trailing message. Both are safe
   * for the prompt cache: the first is the pass's own prefix, and the second is
   * the tail. It must never reach the capability's `systemSection`, which sits
   * in every ordinary run's system head, where editing the file would invalidate
   * the cached prefix of every run in the workspace.
   */
  policy?: string;
}

/**
 * Resolves the {@link IndexerRuntime} for a pass, or `undefined` when indexing
 * cannot proceed.
 *
 * @remarks Called per pass rather than captured once, so a settings edit or a
 * model configured later takes effect on the next drain tick. `undefined` is not
 * a failure: the drain reports such a job `blocked`, consuming no attempt and
 * taking no lease, so the day a model appears every earlier run's learning is
 * recovered.
 */
export type IndexerRuntimeResolver = () =>
  IndexerRuntime | undefined | Promise<IndexerRuntime | undefined>;

/** What a file is, derived from its basename. */
export type DocKind = "profile" | "topic" | "memory";

/**
 * How far a document's content is trusted.
 *
 * @remarks Absent means `"observed"`. Automation may create `"observed"`
 * content freely, but may never raise a document to `"confirmed"` — that is an
 * explicit owner act. `"contested"` keeps a document readable while recording
 * that it is disputed or believed stale.
 */
export type MemoryAuthority = "observed" | "confirmed" | "contested";

/** Parsed frontmatter common to every wiki document. Tolerant: a hand-edited
 * file with missing fields still loads (fields default). */
export interface DocFrontmatter {
  /** One-liner used by the deterministic reindex to build parent link lists. */
  description: string;
  tags: string[];
  /** Trust level; absent means {@link MemoryAuthority | `"observed"`}. */
  authority?: MemoryAuthority;
  /**
   * Owner-owned content: blocks automatic deletion and automatic full
   * replacement. Automation may never set it.
   */
  pinned?: boolean;
  /**
   * Frontmatter lines the parser did not recognize, kept verbatim and in order.
   *
   * @remarks A `string[]` rather than a key/value map on purpose: it round-trips
   * block scalars, nested maps and duplicate keys that a map would silently
   * destroy, and nothing needs to *set* an unknown key programmatically.
   */
  extra?: string[];
}

/** A document in the tree, as returned by listing. `path` is relative to the
 * memory root, POSIX-separated (e.g. `infra/bun/MEMORY.md`). */
export interface MemoryDoc {
  path: string;
  kind: DocKind;
  description: string;
  tags: string[];
  updated_at: number;
}

/**
 * The result of a {@link MemoryToolDef.execute} call: the text the model sees,
 * and whether it represents a failure.
 *
 * @remarks `isError` is `true` for invalid arguments or lookup failures — the
 * tool never throws, it reports the error through this shape instead.
 */
export interface MemoryToolResult {
  text: string;
  isError: boolean;
}

/**
 * Host-agnostic tool. The host adapts this to its own tool-definition shape;
 * `parameters` is a plain JSON-Schema object. `execute` never throws — invalid
 * arguments and lookup failures come back as `{isError: true}` results.
 */
export interface MemoryToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<MemoryToolResult>;
}

/** A substitutable source of execution memory behind Clarvis's fixed tools. */
export interface MemoryProvider {
  readonly kind: string;
  readonly readTools: readonly MemoryToolDef[];
  readonly writeTools?: readonly MemoryToolDef[];
  seed(task?: string): Promise<string | null>;
}

/**
 * Size limits governing the memory subsystem's LLM interactions. Merged over
 * {@link DEFAULT_BUDGETS} by {@link CreateMemoryOptions.budgets}.
 */
export interface MemoryBudgets {
  /** Cap on the PROFILE block the seed injects at run start. */
  seed_chars: number;
  /** Approximate token cap for the run digest sent to the indexer. */
  digest_tokens: number;
  /** Max write/delete ops the indexer may apply per run; 1-50. */
  max_index_ops: number;
}

/** One line-level match from {@link MemoryStore.grep}. */
export interface GrepHit {
  path: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matching line, trimmed and length-capped. */
  text: string;
}

/**
 * The read/write surface over the memory tree, available both on a
 * {@link MemoryStore} and on the handle {@link MemoryStore.exclusive} passes in.
 *
 * @remarks All paths are relative to the tree root and normalized by
 * `normalizeMemoryPath`, so a key is identical whichever backend stores it.
 * Scans tolerate unreadable entries. Direct reads distinguish an oversized
 * hand-edited document from absence with a typed storage-limit error.
 */
export interface MemoryTx {
  /**
   * Read one document's raw markdown, or null if absent.
   *
   * @throws MemoryStorageLimitError when an on-disk document exceeds the hard
   * storage limit. Oversized is deliberately not reported as absent: a caller
   * that intends to replace/delete must never mistake protected bytes for a
   * missing document.
   */
  read(relPath: string): Promise<string | null>;
  /** Read at most `maxBytes`, returning a truncation marker without materializing the remainder. */
  readBounded?(
    relPath: string,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean } | null>;
  /** Create or replace a document, refusing content above the storage limit. */
  write(relPath: string, content: string): Promise<void>;
  /** Hard-delete a document. Returns whether it existed. */
  delete(relPath: string): Promise<boolean>;
  /** Every document in the tree, ordered by path with {@link compareMemoryPaths}.
   * @throws MemoryStorageLimitError when a complete catalog traversal would
   * exceed the repository entry or aggregate read limit. */
  list(): Promise<MemoryDoc[]>;
  /** Keyword/regex search across document bodies. Regex support is best-effort:
   * a pattern the backend cannot honour degrades to a keyword scan, and one
   * whose worst-case match cost cannot be bounded counts as unhonourable — the
   * content scan is capped in lines and in wall clock. Directory traversal is
   * different: entry and aggregate read limits throw MemoryStorageLimitError
   * instead of silently searching only a prefix of the catalog. */
  grep(query: string, opts?: { limit?: number; regex?: boolean }): Promise<GrepHit[]>;
  /** Idempotency probe for the per-run indexer: has this run been folded in? */
  wasIndexed(runId: string): Promise<boolean>;
  /** Idempotency commit: record that `runId` has been folded in. */
  markIndexed(runId: string): Promise<void>;
  /**
   * A token that changes whenever any document in the tree changes.
   *
   * @returns an opaque token. Two reads yielding the same token guarantee no
   *   intervening write; a differing token guarantees nothing about *what*
   *   changed.
   * @throws MemoryStorageLimitError when hashing a complete tree would exceed
   *   the repository entry or aggregate read limit.
   */
  version(): Promise<string>;
}

/**
 * The staging surface inside {@link MemoryUnitOfWork.batch}.
 *
 * @remarks Writes and deletes only record intent; nothing reaches the tree
 * until the batch commits. Reads see the batch's own staged state layered over
 * the tree, so a multi-document rewrite can read back what it just staged.
 */
export interface MemoryBatch {
  /** This batch's id, as it appears in revisions and recovery reports. */
  readonly id: string;
  /** Read a document, including this batch's staged changes. */
  read(relPath: string): Promise<string | null>;
  /** List documents, including this batch's staged creations and deletions. */
  list(): Promise<MemoryDoc[]>;
  /**
   * Stage a create-or-replace.
   *
   * @param relPath - the document to write.
   * @param content - its full new markdown.
   * @param opts.derived - mark the write as mechanically derived from other
   *   documents in the same batch. Derived writes are still journaled, so they
   *   are recovered like any other, but record no revision: the deterministic
   *   navigation restitch would otherwise bury real history under link-block
   *   churn.
   */
  write(relPath: string, content: string, opts?: { derived?: boolean }): Promise<void>;
  /** Stage a deletion. Returns whether the document currently exists. */
  delete(relPath: string): Promise<boolean>;
}

/** What a batch is for, and what it must finish once its writes land. */
export interface MemoryBatchInput {
  /** Provenance recorded on every revision the batch creates. */
  source: MemoryRevisionSource;
  /**
   * Follow-up work declared up front so recovery can replay it idempotently
   * after a crash, without knowing what created the batch.
   */
  commit?: MemoryBatchCommit;
}

/** Lock-free, tolerant revision queries. */
export interface MemoryRevisionReader {
  /**
   * Every recorded revision of one document, newest first.
   *
   * @param relPath - the document to inspect.
   * @returns its revisions; empty when it has no recorded history.
   */
  list(relPath: string): Promise<MemoryRevision[]>;
  /**
   * The body a revision captured — the content restoring it would install.
   *
   * @returns the stored pre-image, or null when the revision is unknown or
   *   captured nothing (the document did not exist before that change).
   */
  read(relPath: string, revisionId: string): Promise<string | null>;
}

/** Revision surface available inside a unit of work. */
export type MemoryRevisionTx = MemoryRevisionReader;

/** Lock-free, tolerant job queries, for health views and the worker's scheduling peek. */
export interface MemoryJobReader {
  /** One job by the run it learns from, or null when there is none. */
  get(runId: string): Promise<MemoryIndexJob | null>;
  /** Jobs matching a filter, newest first. */
  list(query?: {
    state?: MemoryJobState | readonly MemoryJobState[];
    limit?: number;
  }): Promise<MemoryIndexJob[]>;
  /** How many jobs sit in each state. */
  counts(): Promise<Record<MemoryJobState, number>>;
  /**
   * The earliest time any waiting job becomes claimable.
   *
   * @returns that timestamp, or undefined when nothing is waiting.
   * @remarks Lets the worker schedule its next wake precisely instead of
   *   polling on a fixed interval.
   */
  nextDueAt(): Promise<number | undefined>;
}

/** Job mutations, reachable only inside a unit of work. */
export interface MemoryJobTx extends MemoryJobReader {
  /**
   * Record the intent to learn from a run.
   *
   * @returns the job — the existing one, untouched, when this run already has
   *   one in any state. Enqueueing is therefore safe to repeat.
   */
  enqueue(input: {
    run_id: string;
    snapshot: RunSnapshot;
    at: number;
    provider_key?: string;
  }): Promise<MemoryIndexJob>;
  /**
   * Take the next job that is due, stamping a lease and consuming an attempt.
   *
   * @param now - current epoch ms.
   * @param lease - how long the claim holds, who holds it, and optionally the
   *   caller-minted fence. When `token` is supplied the claimed record must
   *   preserve that exact value as `lease_token`.
   * @returns the claimed job, or null when nothing is due. Due means
   *   `pending`, `retry_wait` past its `not_before`, or `running` whose lease
   *   has expired — the last being how a crashed worker's job is reclaimed.
   */
  claim(
    now: number,
    lease: { ms: number; owner: string; token?: string },
  ): Promise<MemoryIndexJob | null>;
  /** Extend a live claim. Returns false when its fence is stale or expired. */
  renew(runId: string, at: number, lease: MemoryJobLease, ms: number): Promise<boolean>;
  /**
   * Refresh owner/token after a protected effect that began with a successful
   * {@link renew} in this same unit of work.
   *
   * @returns False when the job is no longer running or owner/token changed.
   * @remarks This deliberately ignores wall-clock expiry: the enclosing
   *   {@link MemoryStore.exclusive} prevented reclaim between the strict
   *   pre-fence and this post-effect refresh. It must never be used as a
   *   heartbeat, settlement check, or standalone late renewal.
   */
  refreshOwnedAfterFence(
    runId: string,
    at: number,
    lease: MemoryJobLease,
    ms: number,
  ): Promise<boolean>;
  /** Mark a job done, dropping its payload. A supplied lease fences the write. */
  complete(runId: string, at: number, note?: string, lease?: MemoryJobLease): Promise<boolean>;
  /** Record a failure and apply the decided transition. */
  fail(
    runId: string,
    at: number,
    failure: MemoryJobFailure,
    next: MemoryJobTransition,
    lease?: MemoryJobLease,
  ): Promise<boolean>;
  /**
   * Give a claim back without consuming it.
   *
   * @remarks For shutdown and for conditions that are nobody's fault — the
   *   attempt is refunded, so an interrupted worker costs the job nothing.
   */
  release(runId: string, at: number, note?: string, lease?: MemoryJobLease): Promise<boolean>;
  /** Operator action: move a `failed` job back to `pending` with a fresh budget. */
  retry(runId: string, at: number): Promise<MemoryIndexJob | null>;
  /**
   * Drop jobs that are no longer worth keeping.
   *
   * @param opts - the age bounds and the failure-evidence floor.
   * @returns how many job records were removed.
   */
  prune(opts: MemoryJobPruneOptions): Promise<number>;
}

/** Bounds governing {@link MemoryJobStore.prune}. */
export interface MemoryJobPruneOptions {
  /** Drop terminal jobs (`completed`/`failed`) last updated before this. */
  terminalBefore: number;
  /** Most recent failures kept whatever their age, as evidence. */
  keepFailed: number;
  /**
   * Drop *un*terminal jobs (`pending`/`retry_wait`) last updated before this.
   *
   * @remarks Omit to keep them forever, which was the only behaviour before a
   * run in a workspace with no indexer model began enqueueing anyway. That
   * enqueue is what lets a workspace recover its whole learning history the day
   * a model is configured — but a workspace that never configures one would
   * otherwise accumulate a snapshot per run without bound.
   */
  pendingBefore?: number;
}

/**
 * The handle {@link MemoryStore.exclusive} passes in: the tree surface, plus
 * the surfaces whose mutations must be ordered with tree mutation.
 *
 * @remarks Recoverable mutation is reachable only from here, so "a batch and
 * the reindex that follows it share one exclusive handle" is enforced by the
 * type system rather than by convention.
 */
export interface MemoryUnitOfWork extends MemoryTx {
  /** Read revisions recorded by earlier batches. */
  readonly revisions: MemoryRevisionTx;
  /** The durable index-job queue. */
  readonly jobs: MemoryJobTx;
  /**
   * Run a recoverable batch: stage operations, capture the bodies they
   * replace as revisions, journal the intent, apply, then commit.
   *
   * @typeParam T - the batch body's result type.
   * @param input - provenance and declared commit work.
   * @param fn - stages the batch's operations against {@link MemoryBatch}.
   * @returns whatever `fn` returns.
   * @throws {@link MemoryRecoveryRequiredError} when an earlier batch is
   *   awaiting an operator decision — mutation is frozen until it is resolved.
   * @remarks A throw inside `fn` leaves the tree byte-identical; a crash inside
   *   is repaired on the next open.
   */
  batch<T>(input: MemoryBatchInput, fn: (bx: MemoryBatch) => Promise<T>): Promise<T>;
}

/**
 * Prove that an indexing worker still owns its queue claim while a mutation's
 * unit of work is held.
 *
 * @param tx - the exact unit of work that also serializes the protected write.
 * @returns `true` while the worker's owner/token is still current; `false`
 *   after a reclaim has replaced it.
 * @remarks Callers invoke the same fence immediately before and after the
 * protected mutation. The check belongs inside the existing unit of work: a
 * separate lease read followed by a tree write would leave a reclaim window.
 */
export interface MemoryMutationFence {
  /** Strict live-lease check immediately before the protected effect. */
  before(tx: MemoryUnitOfWork): Promise<boolean>;
  /**
   * Owner/token refresh immediately after that effect, before releasing the
   * same unit of work. May span expiry because reclaim was excluded meanwhile.
   */
  after(tx: MemoryUnitOfWork): Promise<boolean>;
}

/**
 * The injected persistence port for a workspace's memory tree. One instance per
 * tree; the host constructs it and hands it to {@link createMemory}.
 */
export interface MemoryStore extends MemoryTx {
  /**
   * Run `fn` with exclusive access to the tree, passing the handle every
   * operation inside the unit of work must use.
   *
   * @typeParam T - the operation's result type.
   * @param fn - the critical section; it receives the {@link MemoryUnitOfWork}
   *   handle.
   * @returns whatever `fn` returns.
   * @remarks Exclusion only at this level: a throw part-way through leaves
   *   earlier bare `write`/`delete` calls applied. Use
   *   {@link MemoryUnitOfWork.batch} for all-or-nothing mutation. Nesting
   *   `exclusive` is not part of the contract: thread the handle through
   *   instead.
   */
  exclusive<T>(fn: (tx: MemoryUnitOfWork) => Promise<T>): Promise<T>;
  /** Lock-free revision queries, for history views and restore previews. */
  readonly revisions: MemoryRevisionReader;
  /** Lock-free job queries, for health views and the worker's scheduling peek. */
  readonly jobs: MemoryJobReader;
  /**
   * Repair any batch left behind by an interrupted process.
   *
   * @returns what was done with each interrupted batch.
   * @remarks Idempotent, and run under the tree lock. A backend with no
   *   cross-process durability reports an empty pass.
   */
  recover(): Promise<MemoryRecoveryReport>;
}
