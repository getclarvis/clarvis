/**
 * The `memory-indexer` agent: its system prompt, its profile, and the run
 * request one pass is driven by.
 *
 * @remarks There is no registry of built-in agent profiles anywhere in the
 * stack — a profile reaches the loop only through `RunRequest.profiles[]` — so
 * the indexer's profile is a constant here, assembled into the request the pass
 * hands to `executeRun`. That is the same shape a workflow leader's request has:
 * built from a template by the host, never discovered from the workspace.
 *
 * The profile carries **no grants and no `can_spawn`**, which is what bounds it
 * structurally rather than by a list of exclusions: with no grants the agent
 * tools capability ceilings its toolset to nothing, and with no `can_spawn` the
 * run derives the solo shape and `delegate_task` is never contributed. The only
 * tools it is offered are the ones the indexer's own memory capability supplies.
 */
import type { AgentProfile, ProviderConfig, RunRequest } from "@clarvis/capability";
import type { StoredExecution } from "@clarvis/loop";

/** Profile name and `entry` of every indexer run. */
export const MEMORY_INDEXER_AGENT = "memory-indexer";

/**
 * Iterations one pass may spend.
 *
 * @remarks Derived from the work, not from `max_index_ops` — the two are
 * independent because a single iteration may carry several tool calls, so a
 * 16-op write budget does not imply 16 iterations. The build-up: two to orient
 * (`query_memories`, `read_memory`), five to write a two-topic pyramid (two
 * leaves, their two `TOPIC.md` ancestors, `PROFILE.md`), one to finish — eight
 * for the shape this pass is sized around. The remaining four are headroom, for
 * a gate nudge and for a run that turns out to touch more than two topics. A
 * pass that needs more than this is not converging, and the job-level retry is
 * the right place for it to be caught.
 */
export const INDEXER_ITERATION_LIMIT = 12;

/**
 * Total tokens one pass may spend before the budget stops it.
 *
 * @remarks Sized for a large `PROFILE.md` plus several `read_memory` calls. It
 * exists so a pass that goes wrong costs a bounded amount rather than an
 * unbounded one; `on_exceed: "stop"` makes exceeding it end the run instead of
 * asking anyone.
 *
 * That last point is why it errs high rather than tight. This is not the bound
 * that catches a non-converging pass — {@link INDEXER_ITERATION_LIMIT} is, and
 * it trips first on any pass that is looping. Reaching *this* one instead means
 * a few iterations each read something enormous, so the failure it describes is
 * an unexpectedly large tree rather than a runaway model. Setting it near the
 * expected spend would convert those into lost learning; setting it here still
 * bounds the bill.
 */
export const INDEXER_TOKEN_LIMIT = 200_000;

/**
 * The system prompt governing an indexer pass.
 *
 * @remarks It no longer describes a JSON grammar: the model edits the tree
 * through the ordinary memory tools, so what it needs is the editorial standard,
 * the pyramid, and the closure rule the finalize gate enforces. Two instructions
 * are load-bearing rather than stylistic. **Read before you write**, because the
 * tree may already carry this run's knowledge — a previous pass can have died
 * after landing some of its edits, and the job is retried. **Leaf first, then
 * ancestors, then PROFILE**, because writes land as they are made: ordering that
 * way means the worst state a crash can leave is a leaf whose compiled ancestors
 * have not caught up, which is exactly what a single hand-written `write_memory`
 * already produces and the deterministic reindex already tolerates.
 */
export const INDEXER_SYSTEM = `You maintain a coding agent's long-term memory: a small wiki of markdown documents
about THIS workspace. You are given a finished run (its task and an execution digest).
Decide what — if anything — is worth remembering for future runs, and edit the wiki.

Record ONLY what is (a) likely to recur and (b) non-obvious from the codebase itself:
stable environment facts, how a recurring task is actually done (with exact commands),
pitfalls and their fixes, and explicit owner directives. Do NOT record one-off details,
things already in the tree (unless the run contradicts them), or restatements of the code.

Most runs deserve NO change at all — quality over quantity. When that is your judgement,
say so and finish without calling any write tool.

The wiki is a semantic pyramid, not merely a directory index:
- PROFILE.md is a concise, workspace-wide compilation. It must contain the most
  important operational facts a model should know before choosing a topic.
- <topic>/TOPIC.md is a denser compilation of that domain. It must contain enough
  knowledge to answer common questions without opening every leaf.
- <topic>/<subtopic>/MEMORY.md is the detailed source: exact commands, procedures,
  examples, explanations, pitfalls, and exceptions.
Information may intentionally appear at all three levels, progressively compressed.
Links alone are NOT a useful PROFILE or TOPIC.

READ BEFORE YOU WRITE. Use query_memories, list_memories and read_memory to see what
the tree already says. The tree may ALREADY reflect this run: a previous pass can have
been interrupted after some of its edits landed. Recording something twice, or
contradicting what is already there, is worse than recording nothing.

PREFER edit_memory OVER write_memory. edit_memory replaces one unique passage and
leaves the rest of the document untouched; write_memory replaces the whole file, and
rewriting a document from scratch is how facts get silently dropped. Use write_memory
to create a document, or when a rewrite is genuinely what you mean.

Every document must carry frontmatter:
  ---
  description: <one line, <=120 chars, used to build the navigation index>
  tags: [kebab, case]
  ---
Never write a "## Contents" section; navigation is regenerated deterministically.
Group detailed knowledge under stable paths (e.g. infra/bun/MEMORY.md).

CLOSURE RULE — this is checked mechanically when you try to finish, and you will be
sent back until it holds:
  If you change ANY <topic>/<subtopic>/MEMORY.md (write, edit OR delete), you must also
  update every ancestor <topic>/TOPIC.md of that leaf, and PROFILE.md.
  Updating an ancestor means edit_memory or write_memory on it — compiled and compressed
  upward from the leaf. Never copy a leaf verbatim into its ancestor.
  Changing only compiled layers, with no leaf, is also rejected.
  Changing nothing at all is always valid.

DO IT IN THIS ORDER: the leaf first, then each ancestor TOPIC.md, then PROFILE.md.
Your edits land as you make them, so this order keeps the tree sensible even if the
pass is interrupted.`;

/**
 * The instruction a pass appends to the run it continues.
 *
 * @remarks Carries the same editorial standard as {@link INDEXER_SYSTEM}, minus
 * everything the continued transcript already supplies: there is no "you are
 * given a finished run and its digest", because the run *is* the context. It
 * rides as a trailing user message rather than a base prompt because the base
 * prompt is the continued run's own, byte for byte — replacing it would move the
 * first differing byte to the very start of the request and cost the entire
 * prefix.
 *
 * That placement is also this design's main risk to *quality*, not cost: an
 * instruction at the end of a long transcript is in a weaker position than one
 * in the system block. The pyramid gate is the mechanical backstop, but
 * "most runs deserve no change" has no backstop and is exactly the kind of
 * judgement that erodes there. It is why the rollout is measured.
 */
export const INDEXER_CONTINUATION_INSTRUCTION = `The work above is finished. This is the dedicated memory pass your instructions told you
to wait for: you are now explicitly authorised — and asked — to use write_memory,
edit_memory and delete_memory. Update this workspace's memory wiki with what — if
anything — is worth remembering for future runs.

Record ONLY what is (a) likely to recur and (b) non-obvious from the codebase itself:
stable environment facts, how a recurring task is actually done (with exact commands),
pitfalls and their fixes, and explicit owner directives. Do NOT record one-off details,
things already in the tree (unless this run contradicts them), or restatements of code.

Most runs deserve NO change at all — quality over quantity. When that is your judgement,
say so and finish without calling any write tool.

The wiki is a semantic pyramid, not merely a directory index:
- PROFILE.md is a concise, workspace-wide compilation of the most important operational facts.
- <topic>/TOPIC.md is a denser compilation of that domain.
- <topic>/<subtopic>/MEMORY.md is the detailed source: exact commands, procedures, pitfalls.
Information may intentionally appear at all three levels, progressively compressed.
Links alone are NOT a useful PROFILE or TOPIC.

READ BEFORE YOU WRITE. Use query_memories, list_memories and read_memory to see what the
tree already says. Recording something twice, or contradicting what is there, is worse
than recording nothing.

PREFER edit_memory OVER write_memory. edit_memory replaces one unique passage; write_memory
replaces the whole file, and rewriting from scratch is how facts get silently dropped.

Every document must carry frontmatter:
  ---
  description: <one line, <=120 chars>
  tags: [kebab, case]
  ---
Never write a "## Contents" section; navigation is regenerated deterministically.

CLOSURE RULE — checked mechanically when you try to finish, and you will be sent back
until it holds:
  If you change ANY <topic>/<subtopic>/MEMORY.md, you must also update every ancestor
  <topic>/TOPIC.md of that leaf, and PROFILE.md — compiled and compressed upward, never
  copied verbatim. Changing only compiled layers, with no leaf, is also rejected.
  Changing nothing at all is always valid.

DO IT IN THIS ORDER: the leaf first, then each ancestor TOPIC.md, then PROFILE.md. Your
edits land as you make them, so this order keeps the tree sensible if you are interrupted.

Only the memory tools work here; everything else is refused. Call submit_result when done.`;

/** What {@link buildIndexerRequest} needs to assemble one pass. */
export interface IndexerRequestArgs {
  /** The run id of the indexer pass itself. */
  executionId: string;
  /** The rendered run digest — what this pass is being asked to learn from. */
  task: string;
  /** `provider/model` for the indexer, from `memory.model` or `default_model`. */
  modelRef: string;
  /** Provider instances the request declares; must carry `modelRef`'s token. */
  providers: readonly ProviderConfig[];
  /** The operator's composed recording policy, appended to the base prompt. */
  policy?: string | undefined;
}

/**
 * Assemble the run request for one indexer pass.
 *
 * @param args - see {@link IndexerRequestArgs}.
 * @returns a {@link RunRequest} whose entry agent is {@link MEMORY_INDEXER_AGENT}.
 * @remarks Declares no MCP servers, so the pass never builds a connection pool.
 *   `budget.on_exceed` is `"stop"`, which the request schema only accepts
 *   alongside a `total_token_limit` — both are set. `orchestration` is
 *   deliberately absent: it is lead-only (valid only for a profile with a
 *   non-empty `can_spawn`), and the finalize gate's nudge still forces a tool on
 *   the next iteration because `CLARVIS_DEFAULT_FORCE_TOOL_ON_NUDGE` defaults on.
 *   Transport retries are disabled on this profile because the durable index
 *   job already owns retry, backoff and give-up; nesting both policies would
 *   multiply one provider outage into repeated calls inside every job attempt.
 */
export function buildIndexerRequest(args: IndexerRequestArgs): RunRequest {
  return {
    execution_id: args.executionId,
    messages: [{ role: "user", content: args.task }],
    servers: [],
    providers: [...args.providers],
    profiles: [
      {
        name: MEMORY_INDEXER_AGENT,
        model: args.modelRef,
        base_prompt: withPolicy(INDEXER_SYSTEM, args.policy),
        tools: [],
        iteration_limit: INDEXER_ITERATION_LIMIT,
        retry: { max_retries: 0 },
      },
    ],
    entry: MEMORY_INDEXER_AGENT,
    budget: { on_exceed: "stop", total_token_limit: INDEXER_TOKEN_LIMIT },
  };
}

/**
 * Why a pass cannot be run as a continuation of the run it indexes.
 *
 * @remarks Each value is a condition under which the provider would *not* serve
 * the request from its prefix cache, so continuing would pay full price for the
 * whole transcript instead of a fraction of it — strictly worse than the digest.
 */
export type ContinuationBlocker =
  | "no-stored-run"
  | "no-final-context"
  | "no-entry-profile"
  | "mcp-servers-declared"
  | "undeclared-profile-grant"
  | "model-differs"
  | "no-cache-observed";

/**
 * Input a run must have consumed before a zero cache count is evidence.
 *
 * @remarks A prefix cache only pays from some minimum length, and the very first
 * call of a run has nothing to hit, so a small run reporting nothing proves
 * nothing. Past this much input a caching provider has always reported
 * *something* — measured across this workspace's traces, runs on a reporting
 * provider land between 57% and 98%, and the ones at the bottom of that range
 * are all under 15k tokens.
 */
const CACHE_EVIDENCE_MIN_INPUT = 100_000;

/**
 * Decide whether a pass may continue the run it indexes.
 *
 * @param subject - the indexed run as persisted, or `null` when it is gone.
 * @param modelRef - the model the pass would run on.
 * @param knownGrants - grant names the pass deps can validate; omitted by
 *   callers that are evaluating only transcript and model eligibility.
 * @returns the blocking condition, or `null` when the continuation is viable.
 * @remarks `mcp-servers-declared` is the non-obvious one. MCP tools are part of
 *   the advertised array, so a pass that declared no servers against a run that
 *   did would present a shorter array and break the prefix at the first tool —
 *   and declaring the *same* servers would make a background indexing pass dial
 *   out to every one of them. Neither is acceptable, so such a run indexes
 *   through the isolated path instead.
 *
 *   `model-differs` follows from a cache belonging to a model: an operator who
 *   configures `memory.model` to something cheaper is choosing the cold path,
 *   and that is a legitimate choice rather than a misconfiguration.
 */
export function continuationBlocker(
  subject: StoredExecution | null,
  modelRef: string,
  knownGrants?: ReadonlySet<string>,
): ContinuationBlocker | null {
  if (subject === null) return "no-stored-run";
  if (subject.final_context === undefined || subject.final_context.length === 0) {
    return "no-final-context";
  }
  if ((subject.request.servers ?? []).length > 0) return "mcp-servers-declared";
  if (
    (subject.total_input_tokens ?? 0) >= CACHE_EVIDENCE_MIN_INPUT &&
    (subject.total_cached_tokens ?? 0) === 0
  ) {
    return "no-cache-observed";
  }
  const entry = entryProfileOf(subject);
  if (entry === undefined) return "no-entry-profile";
  if (
    knownGrants !== undefined &&
    subject.request.profiles.some((profile) =>
      (profile.grants ?? []).some((grant) => !knownGrants.has(grant)),
    )
  ) {
    return "undeclared-profile-grant";
  }
  if (entry.model !== modelRef) return "model-differs";
  return null;
}

/** The profile the indexed run entered on. */
function entryProfileOf(subject: StoredExecution): AgentProfile | undefined {
  return subject.request.profiles.find((p) => p.name === subject.request.entry);
}

/**
 * Append the operator's recording policy to an instruction.
 *
 * @param instruction - the built-in guidance.
 * @param policy - the composed policy, or undefined for none.
 * @returns the instruction, with the policy after it.
 * @remarks Always *after*, so the operator's words are the last thing read on
 *   what to record, and always in a position that costs no prompt cache: the
 *   isolated pass's base prompt is that pass's own prefix, and the
 *   continuation's is the trailing message.
 */
function withPolicy(instruction: string, policy: string | undefined): string {
  return policy === undefined ? instruction : `${instruction}\n\n${policy}`;
}

/** What {@link buildIndexerContinuationRequest} needs. */
export interface ContinuationRequestArgs {
  /** The run id of the indexer pass itself. */
  executionId: string;
  /** The indexed run, as persisted. */
  subject: StoredExecution;
  /**
   * Provider instances the pass declares, resolved from **live settings**.
   *
   * @remarks Never taken from `subject.request`. The trace persists
   * `sanitizeDeep(record.request)`, and that redaction matches any JSON key
   * *containing* `api_key` — which `api_key_env` does, even though it holds an
   * environment variable *name* and never a secret. A provider block read back
   * from disk therefore arrives as `api_key_env: "[redacted]"`, and the request
   * schema rejects it against `^[A-Za-z_][A-Za-z0-9_]*$`. Deterministically, on
   * every attempt, before any model is called.
   *
   * Substituting the live value is not merely a workaround: providers are host
   * routing configuration and contribute nothing to the prompt the provider
   * hashes, so unlike `profiles` and `entry` they carry no obligation to match
   * what the indexed run used.
   */
  providers: readonly ProviderConfig[];
  /** The operator's composed recording policy, appended to the instruction. */
  policy?: string | undefined;
}

/**
 * Assemble a pass that continues the run it indexes.
 *
 * @param args - see {@link ContinuationRequestArgs}.
 * @returns a {@link RunRequest} resuming `subject` with the indexing
 *   instruction appended.
 * @remarks Everything the provider hashes is carried over verbatim — the same
 *   `profiles`, the same `entry`, the same `providers`, the same (empty)
 *   `servers` — because the cache hit is the length of the longest
 *   byte-identical prefix and all of it sits ahead of the appended message. The
 *   Profile-local fields that do change are invisible on the provider wire:
 *   `iteration_limit` is lowered to the pass's own bound so a continued coder
 *   profile cannot spend its much larger budget here, and `retry.max_retries`
 *   is set to zero because the durable job owns recovery across passes. The
 *   request `budget` stops the pass rather than asking anyone. Cached tokens are
 *   already discounted by the engine's ledger
 *   (`max(0, input - cached) + output`), so a large continued transcript does
 *   not consume the pass's allowance merely by being re-sent each iteration.
 *
 *   The source session is retained, while the indexing instance has its own
 *   persisted agent identity. Queue recovery supplies the same instance again.
 *   Cache-key composition is centralized in the provider decorator and never
 *   truncates identifiers.
 */
export function buildIndexerContinuationRequest(args: ContinuationRequestArgs): RunRequest {
  const { executionId, subject } = args;
  const request = subject.request;
  return {
    execution_id: executionId,
    continue_from: subject.id,
    session_id: request.session_id ?? subject.id,
    agent_instance_id: executionId,
    messages: [
      { role: "user", content: withPolicy(INDEXER_CONTINUATION_INSTRUCTION, args.policy) },
    ],
    servers: [...(request.servers ?? [])],
    providers: [...args.providers],
    profiles: request.profiles.map((p) =>
      p.name === request.entry
        ? {
            ...p,
            iteration_limit: INDEXER_ITERATION_LIMIT,
            retry: { ...p.retry, max_retries: 0 },
          }
        : p,
    ),
    entry: request.entry,
    budget: { on_exceed: "stop", total_token_limit: continuationTokenLimit(subject) },
  };
}

/**
 * The token allowance one continuation may spend.
 *
 * @remarks {@link INDEXER_TOKEN_LIMIT} alone is wrong here, and shipping it was
 * a real defect: it is sized for the *isolated* pass, whose whole prompt is a
 * short system block plus a digest. A continuation re-sends the indexed run's
 * entire transcript on every iteration, and the engine's ledger discounts only
 * what the provider actually **reports** as cached (`max(0, input - cached)`).
 * Against a provider that reports nothing, a 130k transcript charges 130k per
 * iteration and exhausts a flat 200k in two — which is exactly how a pass came
 * back `budget_exhausted` twice and lost its run's learning.
 *
 * So the allowance is derived from what the indexed run itself was charged: its
 * own uncached input per iteration, extended over this pass's iteration limit,
 * on top of the base allowance for the pass's own new tokens and output. That
 * uses only recorded fact rather than a guess about the provider, and it scales
 * with the transcript instead of assuming its size.
 *
 * {@link continuationBlocker} still refuses outright when the run reported *no*
 * cache at all over meaningful input, because there the digest path is simply
 * cheaper. This bounds the partially-cached middle.
 */
function continuationTokenLimit(subject: StoredExecution): number {
  const input = subject.total_input_tokens ?? 0;
  const uncached = Math.max(0, input - (subject.total_cached_tokens ?? 0));
  const iterations = Math.max(1, subject.response?.usage?.iterations_used ?? 1);
  return Math.ceil(INDEXER_TOKEN_LIMIT + (uncached / iterations) * INDEXER_ITERATION_LIMIT);
}
