import type { ErrorCode, ExecutionMode, ProviderErrorDetails, RunEndedReason } from "./run.ts";
import type { AgentRole, AssistantMessagePhase, ToolTransport } from "./api.ts";

/**
 * Every trace kind the engine itself records, as a runtime list.
 *
 * @remarks This array is the single source of truth: {@link BuiltinTraceKind} is
 *   derived from it, and {@link isBuiltinTraceEntry} tests against it, so the
 *   type and the runtime guard cannot drift apart.
 */
export const BUILTIN_TRACE_KINDS = [
  "init",
  "lead_iteration",
  "lead_iteration_started",
  "subagent_iteration",
  "subagent_iteration_started",
  "tool_call",
  "tool_call_started",
  "tool_output_delta",
  "tool_input_delta",
  "budget_check",
  "terminate",
  "delegation_created",
  "delegation_completed",
  "delegation_failed",
  "compaction_started",
  "compaction",
  "compaction_skipped",
  "vision_analysis",
  "cancellation",
  "user_question",
  "user_steering",
  "soft_limit_check",
  "run_started",
  "run_ended",
  "delegation_started",
  "model_call_error",
  "model_call_retry",
  "convergence_warning",
  "guard_escalation",
  "elicitation_requested",
  "model_reasoning",
  "model_stream_delta",
  "mcp_degraded",
  "agent_registered",
  "agent_stopped",
  "agent_steered",
  "agent_finish_nudge",
] as const;

/**
 * The complete set of discriminators for a loop event the *engine* records, one
 * per entry in {@link TraceDetailMap}.
 *
 * @remarks `init` and `terminate` are structural markers with no detail payload;
 *   the remainder each pair with a typed `*Detail` interface.
 */
export type BuiltinTraceKind = (typeof BUILTIN_TRACE_KINDS)[number];

/**
 * The discriminator of any recorded loop event, built-in or contributed.
 *
 * @remarks Deliberately open: a capability that lives outside the engine records
 *   its own kinds, and a closed union would mean the engine had to declare them.
 *   Use {@link BuiltinTraceKind} wherever the exact detail type matters — the
 *   `(string & {})` arm keeps editor completion for the built-ins while still
 *   admitting any other string.
 */
export type TraceKind = BuiltinTraceKind | (string & {});

/**
 * One completed lead-agent model iteration: its index, timing, model id, token
 * usage, and the assistant's textual `response`.
 *
 * @remarks `started_at`/`ended_at` are run-relative millisecond offsets (rebased
 *   to absolute time when mapped to a
 *   {@link import("./trace.ts").TraceEvent | TraceEvent}). `input_tokens` is the
 *   full prompt size, inclusive of `cached_tokens` and `cache_write_tokens`;
 *   `cache_read_ratio` is `cached_tokens / input_tokens` (`0` when the prompt
 *   reported no input tokens), the per-iteration cache-health signal.
 */
export interface LeadIterationDetail {
  iteration: number;
  started_at: number;
  ended_at: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cache_read_ratio: number;
  response: string;
  response_phase?: AssistantMessagePhase;
}

/**
 * One completed sub-agent model iteration — the {@link LeadIterationDetail}
 * analogue for a delegated agent, keyed by `subagent_instance_id`.
 */
export interface SubagentIterationDetail {
  subagent_instance_id: string;
  iteration: number;
  started_at: number;
  ended_at: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cache_read_ratio: number;
  response: string;
  response_phase?: AssistantMessagePhase;
}

/**
 * One completed tool invocation: which `agent` (and sub-agent instance) ran it,
 * the iteration it belongs to, timing, the fully-qualified `name`, the
 * `arguments`, the string `result`, an `error` (or `null` on success), and an
 * optional unified `diff` for edits.
 *
 * @remarks `name` is the `mcp.tool` composite that `mapEntry` later splits into
 *   `mcp_name`/`tool_name`; `call_id` correlates this record with the earlier
 *   {@link ToolCallStartedDetail} and any {@link ToolOutputDeltaDetail} chunks.
 */
export interface ToolCallDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  iteration_ref: number;
  call_id?: string;
  started_at: number;
  ended_at: number;
  name: string;
  arguments: unknown;
  result: string;
  error: string | null;
  diff?: string;
  /** Final command-review outcome, present only when the host guard exposes its mode. */
  guard?: CommandGuardReview;
}

/** Persisted final command-review fact attached to its terminal tool call. */
export interface CommandGuardReview {
  mode: "on" | "auto";
  outcome: "allowed" | "denied";
  answerer: "policy" | "human" | "judge" | "session_allowlist" | "unavailable";
}

/**
 * A tool invocation announced at its start, before completion: the same identity
 * fields as {@link ToolCallDetail} plus a required `call_id`, but no result yet.
 *
 * @remarks A live-only progress signal; the terminal {@link ToolCallDetail} with
 *   the matching `call_id` is the authoritative persisted record.
 */
export interface ToolCallStartedDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  iteration_ref: number;
  call_id: string;
  started_at: number;
  name: string;
  arguments: unknown;
}

/**
 * A live, incremental slice of a running tool's output (e.g. bash streaming
 * stdout/stderr), joined to its call via `call_id`. Carried on the live-only
 * channel (`trace.signal`) — never persisted, since the final `tool_call`
 * entry is the authoritative record of the full output.
 */
export interface ToolOutputDeltaDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  call_id: string;
  chunk: string;
}

/**
 * A tool call the model is still *composing*: the provider has named the tool
 * and is streaming its argument payload, but the call does not exist yet.
 * Joined to the eventual {@link ToolCallStartedDetail} by the same `call_id`.
 * The first announcement for each provider attempt is recorded durably; later
 * cumulative progress and completion reports use the live-only channel.
 *
 * @remarks This is the only signal that exists during argument generation, and
 * on a real run that is most of the wall clock: measured over one session's 34
 * lead iterations, 81% of everything the model generated was argument payload,
 * and the four longest calls spent 46-62 seconds each at 94-99% arguments. The
 * provider streams all of it incrementally, so the silence was ours, not the
 * model's — `tool_call_started` cannot cover the window because it is recorded
 * after the model call has fully returned.
 *
 * `chars` is **cumulative**, not a slice, which is what makes a dropped or
 * coalesced event harmless: the next one carries the whole count again. The
 * payload itself is deliberately not carried. A UI wants to know *that* a tool
 * is being composed and roughly how far along it is; the arguments themselves
 * are machinery, they arrive authoritative in {@link ToolCallStartedDetail},
 * and streaming kilobytes of JSON into a transcript would bury the run rather
 * than reveal it.
 */
export interface ToolInputDeltaDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  call_id: string;
  tool_name: string;
  chars: number;
  /** Present only after the provider closed this argument stream. */
  complete?: true;
}

/**
 * A sub-agent iteration announced at its start (index, timing, model) — the
 * live-only lead-in to the completed {@link SubagentIterationDetail}.
 */
export interface SubagentIterationStartedDetail {
  subagent_instance_id: string;
  iteration: number;
  started_at: number;
  model: string;
}

/**
 * A lead iteration announced at its start (index, timing, model) — the live-only
 * lead-in to the completed {@link LeadIterationDetail}.
 */
export interface LeadIterationStartedDetail {
  iteration: number;
  started_at: number;
  model: string;
}

/**
 * A sub-agent delegation as it is created: its `delegation_id`, human `title`,
 * the `task` brief, the granted `tools`, and optionally the `task_id` it
 * advances and the agent `profile` it runs under.
 */
export interface DelegationCreatedDetail {
  delegation_id: string;
  title: string;
  task: string;
  tools: string[];
  task_id?: string;
  profile?: string;
}

/**
 * The outcome of a finished delegation — its `status` and returned `result`,
 * plus the `task_id` it was tied to — shared by both the
 * `delegation_completed` and `delegation_failed` kinds.
 */
export interface DelegationFinishedDetail {
  delegation_id: string;
  task_id?: string;
  status: string;
  result: string;
}

/**
 * A budget checkpoint: how many tokens the run has consumed so far and how many
 * remain against its cap.
 */
export interface BudgetCheckDetail {
  tokens_used: number;
  tokens_remaining: number;
}

/**
 * A cancellation of the lead or a sub-agent, with an optional human-readable
 * `reason`.
 */
export interface CancellationDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  reason?: string;
}

/**
 * The vision pre-pass: a single completion that read the turn's images on behalf
 * of an entry agent whose own model cannot see them.
 *
 * @remarks Deliberately not a `delegation_*` entry. No sub-agent exists — there
 *   is no agent id to poll, steer or stop, and no tool surface — so reporting it
 *   as a delegation would put a child in the trace that a client could never
 *   address. `model` is the model that did the reading, which is by construction
 *   not the agent's own.
 *
 *   `status` is `completed` only when the pass produced text the entry agent
 *   actually received; a blank reading is `failed`, because the run proceeds on
 *   placeholders either way and the distinction that matters to a reader is
 *   whether the images were described, not whether the HTTP call returned.
 */
export interface VisionAnalysisDetail {
  model: string;
  image_count: number;
  status: "completed" | "failed";
  /** The reading handed to the entry agent, or the failure's message. */
  result: string;
}

/**
 * A context-compaction pass that reclaimed room in an agent's window, naming the
 * `operation` (`eviction`, `truncation`, or `summarization`) and, where
 * applicable, how many entries/characters were removed versus kept.
 *
 * @remarks The optional count fields are populated per operation kind — e.g.
 *   `evicted_count` for eviction, the `*_chars` measures for truncation and
 *   summarization; `task_id` scopes the pass to a specific task when relevant.
 */
export interface CompactionDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  operation: "eviction" | "truncation" | "summarization";
  /** Why an attempted summary ended in mechanical eviction instead. */
  fallback_reason?: "summarization_failed" | "summary_not_effective";
  evicted_count?: number;
  freed_chars?: number;
  original_chars?: number;
  kept_chars?: number;
  /** Size in chars of the rolling summary anchor after a `summarization` pass. */
  anchor_chars?: number;
  /** Whether that pass rewrote an existing anchor (`true`) or created it (`false`). */
  anchor_updated?: boolean;
  /**
   * How many contributions were folded into this pass's summarization prompt,
   * when any were; see `CompactionContribution`.
   *
   * @remarks A count rather than the texts. The contribution is already an
   *   instruction the summarizer received, and a second copy in the trace buys
   *   attribution the count mostly gives while doubling what a long-running
   *   session persists.
   */
  contribution_count?: number;
  /** Present when an explicit run-handle request forced this pass. */
  requested?: true;
  /** Number of applied contributions authored by the user request channel. */
  user_contribution_count?: number;
  task_id?: string;
}

/** A live-only compaction pass announcement emitted before hooks or model work begin. */
export interface CompactionStartedDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  mode: "scheduled" | "forced";
}

/** Why an explicit compaction request could not change the context. */
export interface CompactionSkippedDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  reason:
    | "disabled"
    | "nothing_to_compact"
    | "summarization_disabled"
    | "summarization_failed"
    | "summary_not_effective";
}

/**
 * A question the agent put to the user and its resolution: the `question` text,
 * the `outcome` (`accept`, `decline`, or `cancel`), and — when accepted — the
 * `answer` and any `options` offered.
 */
export interface UserQuestionDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  iteration_ref: number;
  question: string;
  outcome: "accept" | "decline" | "cancel";
  answer?: string;
  options?: string[];
}

/**
 * A mid-run steering `message` the user injected into an agent, with an optional
 * `id` correlating it to the delivered instruction.
 */
export interface UserSteeringDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  iteration_ref: number;
  message: string;
  id?: string;
}

/**
 * A soft-limit checkpoint on either the `tokens` or `iterations` `dimension`:
 * the `used`/`limit` at the crossing and the `outcome` of asking whether to keep
 * going (`continued`, `declined`, `no_response`, or `escalations_exhausted`).
 *
 * @remarks `new_checkpoint` is the raised limit set when the user chose to
 *   continue; `escalations` counts how many times the soft limit has been
 *   re-negotiated so far.
 */
export interface SoftLimitCheckDetail {
  agent: AgentRole;
  dimension: "tokens" | "iterations";
  used: number;
  limit: number;
  outcome: "continued" | "declined" | "no_response" | "escalations_exhausted";
  new_checkpoint?: number;
  escalations: number;
}

/**
 * A plan-review gate event: the `outcome` of presenting the plan for approval
 * (`presented`, `approved`, `changes_requested`, `cancelled`,
 * `no_human_fallback`, or `bypass_detected`) and the `revision_index` reviewed.
 *
 * @remarks Declared here but deliberately *absent* from
 * {@link BUILTIN_TRACE_KINDS}: `plan_review` is a kind the planning capability
 * records, not one the engine does. The shape stays published so the capability
 * and any host that renders it agree on one definition rather than two.
 */
export interface PlanReviewDetail {
  outcome:
    | "presented"
    | "approved"
    | "changes_requested"
    | "cancelled"
    | "no_human_fallback"
    | "bypass_detected";
  revision_index: number;
}

/**
 * An open-task finalization nudge: whether the run was `nudged` to finish its
 * still-`pending_task_ids` or `terminated`, the `nudge_index` in the escalation
 * sequence, and whether the previous nudge `progressed` any task.
 *
 * @remarks Contributed rather than built in, exactly like
 * {@link PlanReviewDetail}.
 */
export interface TaskNudgeDetail {
  outcome: "nudged" | "terminated";
  pending_task_ids: string[];
  nudge_index: number;
  progressed: boolean;
}

/**
 * The run's opening parameters: its execution `mode` and the resolved lead/
 * sub-agent models and token/iteration caps, where configured.
 */
export interface RunStartedDetail {
  mode: ExecutionMode;
  lead_model?: string;
  subagent_model?: string;
  max_tokens?: number;
}

/**
 * The run's terminating condition: the {@link RunEndedReason} and, when it ended
 * in error, the machine-readable {@link ErrorCode}.
 */
export interface RunEndedDetail {
  reason: RunEndedReason;
  code?: ErrorCode;
}

/**
 * The moment a created delegation begins executing under its `model` — distinct
 * from {@link DelegationCreatedDetail} (registration) and
 * {@link DelegationFinishedDetail} (outcome).
 */
export interface DelegationStartedDetail {
  delegation_id: string;
  task_id?: string;
  model: string;
}

/**
 * A failed provider call: the {@link ProviderErrorDetails} (kind, HTTP status,
 * retry hint) plus which `agent`/`iteration` and `model` failed and a
 * human-readable `message`.
 */
export interface ModelCallErrorDetail extends ProviderErrorDetails {
  agent: AgentRole;
  subagent_instance_id?: string;
  iteration: number;
  model: string;
  message: string;
  /**
   * Whether the tokens this failed call burned could be determined and charged.
   *
   * @remarks Records the difference between "cost nothing" and "cost unknown",
   * which a bare `0` cannot express. A failed attempt still bills the full
   * prompt, so a reader comparing the ledger against a provider invoice needs
   * to know which failures are accounted for and which are simply invisible.
   */
  usage_attributed?: boolean;
}

/**
 * A provider call that failed transiently and is about to be retried: the
 * {@link ProviderErrorDetails} (kind, HTTP status, retry hint) plus which
 * `agent`/`iteration` and `model` is retrying, the 1-based `attempt`, the
 * `max_retries` cap, and the `delay_ms` backoff about to be slept.
 *
 * @remarks Recorded *before* each backoff, and durably: a turn that took three
 * minutes because the provider was rate-limiting is otherwise
 * indistinguishable from a wedged one, and the only existing signal went to a
 * logger the terminal UI silences. A retry that ultimately succeeds keeps its
 * entries — they are the evidence the slowness was legitimate.
 */
export interface ModelCallRetryDetail extends ProviderErrorDetails {
  agent: AgentRole;
  subagent_instance_id?: string;
  iteration: number;
  model: string;
  message: string;
  attempt: number;
  max_retries: number;
  delay_ms: number;
}

/**
 * A convergence guard crossing its soft tier: the run is close to a limit but
 * has not hit it, and the model has been told so.
 *
 * @remarks The counterpart to a `terminate` with the same `code`. Recorded so a
 * run that later died of that guard shows the warning it gave first — and so a
 * run that recovered after being warned shows the warning worked.
 */
export interface ConvergenceWarningDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  code: "tool_failure_loop" | "stagnation_detected";
  message: string;
}

/**
 * A hard convergence-guard trip put to the user, and what they decided.
 *
 * @remarks Mirrors `soft_limit_check`, and exists for the same reason: when a
 * run continues past a limit it was going to die at, the record has to show who
 * authorized that and how many times.
 */
export interface GuardEscalationDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  code: "tool_failure_loop" | "stagnation_detected";
  outcome: "continued" | "declined" | "no_response" | "escalations_exhausted";
  escalations: number;
}

/**
 * A completed block of the model's reasoning (thinking) `text` for one
 * iteration, distinct from its user-facing response.
 */
export interface ModelReasoningDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  iteration: number;
  model: string;
  text: string;
}

/**
 * A live, incremental slice of the model's output during a single call. Emitted
 * only when streaming is enabled and carried on a live-only channel
 * (`trace.signal`) — never persisted in the trace, since the final
 * `lead_iteration`/`model_reasoning` entries are the authoritative record.
 * `reset` marks the first delta of a channel within a fresh stream, so a
 * retried call re-starts the on-screen buffer instead of appending to it.
 */
export interface ModelStreamDeltaDetail {
  agent: AgentRole;
  subagent_instance_id?: string;
  iteration: number;
  model: string;
  channel: "text" | "reasoning";
  text: string;
  reset: boolean;
}

/**
 * Recorded once at run start when the tool pool came up degraded: one or more
 * declared MCP servers failed to connect, but the run proceeded with the rest
 * (instead of failing outright). Surfaces which servers — and their tools — are
 * missing for this run.
 */
export interface McpDegradedDetail {
  servers: { name: string; transport: ToolTransport; reason: string }[];
}

/**
 * A pending request for user input surfaced mid-run: the `question` and any
 * `options`, tagged by `source` — the agent's own `ask_user` tool or a
 * `tool_relay` forwarding an MCP server's elicitation.
 */
export interface ElicitationRequestedDetail {
  agent?: AgentRole;
  subagent_instance_id?: string;
  iteration_ref?: number;
  source: "ask_user" | "tool_relay";
  question: string;
  options?: string[];
}

/**
 * A child agent registered with the run's supervision registry: the `agent_id`
 * handle a parent addresses it by, the `kind` of child, and the `native_id` it
 * carries in its own id space (a `subagent_instance_id`, or a leader's `run_id`).
 *
 * @remarks `native_id` is recorded rather than hidden precisely so a complaint
 * about a child can still be correlated against the rest of the trace.
 */
export interface AgentRegisteredDetail {
  agent_id: string;
  kind: "subagent" | "leader";
  native_id: string;
  title: string;
  profile?: string;
  background: boolean;
}

/** A parent cancelling one of its own children, with the reason it gave. */
export interface AgentStoppedDetail {
  agent_id: string;
  reason: string;
  /** True when the child had already settled, so nothing was actually cancelled. */
  already_settled: boolean;
}

/** A parent redirecting one of its own children mid-flight. */
export interface AgentSteeredDetail {
  agent_id: string;
  message: string;
  /** False when the child had settled and the steer was refused. */
  delivered: boolean;
}

/**
 * The finish gate ruling on an agent that tried to end with children still
 * running: either a `nudged` round-trip naming them, or the `terminated` outcome
 * once the nudge budget is spent.
 */
export interface AgentFinishNudgeDetail {
  outcome: "nudged" | "terminated";
  live_agent_ids: string[];
  nudge_index: number;
  progressed: boolean;
}

/**
 * The authoritative mapping from each {@link TraceKind} to its detail payload
 * type, used to type {@link TraceEntry} discriminantly.
 *
 * @remarks `init` and `terminate` carry `unknown` (no structured payload);
 *   `delegation_completed` and `delegation_failed` share
 *   {@link DelegationFinishedDetail}. Adding a kind means adding its entry here.
 */
export interface TraceDetailMap {
  init: unknown;
  terminate: unknown;
  lead_iteration: LeadIterationDetail;
  lead_iteration_started: LeadIterationStartedDetail;
  subagent_iteration: SubagentIterationDetail;
  subagent_iteration_started: SubagentIterationStartedDetail;
  tool_call: ToolCallDetail;
  tool_call_started: ToolCallStartedDetail;
  tool_output_delta: ToolOutputDeltaDetail;
  tool_input_delta: ToolInputDeltaDetail;
  budget_check: BudgetCheckDetail;
  delegation_created: DelegationCreatedDetail;
  delegation_completed: DelegationFinishedDetail;
  delegation_failed: DelegationFinishedDetail;
  compaction_started: CompactionStartedDetail;
  compaction: CompactionDetail;
  compaction_skipped: CompactionSkippedDetail;
  vision_analysis: VisionAnalysisDetail;
  cancellation: CancellationDetail;
  user_question: UserQuestionDetail;
  user_steering: UserSteeringDetail;
  soft_limit_check: SoftLimitCheckDetail;
  run_started: RunStartedDetail;
  run_ended: RunEndedDetail;
  delegation_started: DelegationStartedDetail;
  model_call_error: ModelCallErrorDetail;
  model_call_retry: ModelCallRetryDetail;
  convergence_warning: ConvergenceWarningDetail;
  guard_escalation: GuardEscalationDetail;
  elicitation_requested: ElicitationRequestedDetail;
  model_reasoning: ModelReasoningDetail;
  model_stream_delta: ModelStreamDeltaDetail;
  mcp_degraded: McpDegradedDetail;
  agent_registered: AgentRegisteredDetail;
  agent_stopped: AgentStoppedDetail;
  agent_steered: AgentSteeredDetail;
  agent_finish_nudge: AgentFinishNudgeDetail;
}

/**
 * The detail type paired with a given kind: exact for a {@link BuiltinTraceKind},
 * `unknown` for a kind contributed by a capability the engine does not declare.
 */
export type TraceDetailFor<K extends TraceKind> = K extends BuiltinTraceKind
  ? TraceDetailMap[K]
  : unknown;

/**
 * Compile-time drift locks pinning {@link TraceDetailMap}'s keys and
 * {@link BUILTIN_TRACE_KINDS} to exactly the same set.
 *
 * @remarks Kept as two directional checks rather than one, so the compiler names
 *   which side drifted: adding a kind to the array without a
 *   {@link TraceDetailMap} entry fails `_everyKindHasDetail`, and adding a map
 *   entry the array does not list fails `_everyDetailHasKind`. Without these the
 *   two would agree only by hand — the array is what the runtime guard reads and
 *   the map is what types the entry, so a mismatch means an entry the engine
 *   claims to own but cannot type.
 */
const _everyKindHasDetail: [Exclude<BuiltinTraceKind, keyof TraceDetailMap>] extends [never]
  ? true
  : false = true;
const _everyDetailHasKind: [Exclude<keyof TraceDetailMap, BuiltinTraceKind>] extends [never]
  ? true
  : false = true;
void _everyKindHasDetail;
void _everyDetailHasKind;

/**
 * One recorded loop event whose `kind` the engine declares, so its `detail` is
 * exactly typed: an envelope of `at` (a run-relative millisecond offset), the
 * `kind` discriminator, and the matching `detail` from {@link TraceDetailMap}.
 */
export type BuiltinTraceEntry = {
  [K in BuiltinTraceKind]: { at: number; kind: K; detail: TraceDetailMap[K] };
}[BuiltinTraceKind];

/**
 * One recorded loop event as stored internally: either a
 * {@link BuiltinTraceEntry} or an entry contributed by a capability, whose
 * `kind` the engine does not declare and whose `detail` is therefore `unknown`.
 *
 * @remarks This is the recording form; the engine's `mapEntry` projects each
 *   entry to a flat, absolute-time
 *   {@link import("./trace-events.ts").TraceEvent | TraceEvent} for persistence
 *   and the wire. Narrow with {@link isBuiltinTraceEntry} before switching on
 *   `kind`: a bare `switch` would match the open arm in every `case`, since its
 *   `kind` is `string`.
 */
export type TraceEntry = BuiltinTraceEntry | { at: number; kind: string; detail: unknown };

const BUILTIN_TRACE_KIND_SET: ReadonlySet<string> = new Set(BUILTIN_TRACE_KINDS);

/**
 * Narrow a {@link TraceEntry} to the engine-declared {@link BuiltinTraceEntry}.
 *
 * @param entry - any recorded entry.
 * @returns `true` when `entry.kind` is one of {@link BUILTIN_TRACE_KINDS}.
 * @remarks This is what lets an exhaustiveness check over the built-in kinds
 *   survive the open union: narrow first, then `switch`, and the residual in
 *   `default` is still `never`.
 */
export function isBuiltinTraceEntry(entry: TraceEntry): entry is BuiltinTraceEntry {
  return BUILTIN_TRACE_KIND_SET.has(entry.kind);
}

/**
 * Report whether a bare string names a kind the engine declares.
 *
 * @param kind - the discriminator to test.
 * @returns `true` for a {@link BuiltinTraceKind}.
 */
export function isBuiltinTraceKind(kind: string): kind is BuiltinTraceKind {
  return BUILTIN_TRACE_KIND_SET.has(kind);
}

/**
 * The mutable, in-order buffer of {@link TraceEntry} records accumulated while a
 * run executes, before projection to a persisted
 * {@link import("./trace.ts").Trace | Trace}.
 */
export interface RecordingTrace {
  entries: TraceEntry[];
}
