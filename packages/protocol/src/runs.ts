/**
 * RunService — start, steer, cancel, and stream loop runs.
 *
 * The heart of the contract: derived from what a UI historically called on the MCP
 * client (`run` / `steer` / `get_run` / `list_runs` / `delete_run`).
 */

import type { JsonSchema, Pagination, Page, Timestamp } from "./common.ts";
import type { PlanRef, PlanRetention, PlanStatus, PlanTaskDto } from "./plans.ts";
import type { MemoryIngestDetail } from "./memory.ts";
import type { ActiveTaskBindingDto, ActiveTaskRequestDto } from "./tasks.ts";
import type { ExtensionProfileRunRef } from "./extension-profiles.ts";

/** Speaker role on a message. */
export type Role = "user" | "assistant";

/** Plain-text content part. */
export interface TextPart {
  type: "text";
  text: string;
}

/** Image content part (inline bytes or a workspace-relative ref). */
export interface ImagePart {
  type: "image";
  mime: string;
  /** Base64 bytes, or omitted when `ref` is used. */
  data?: string;
  /** Workspace-relative ref the kernel resolves. */
  ref?: string;
}

/** One typed piece of a multi-part message body. */
export type ContentPart = TextPart | ImagePart;

/** A message's payload: bare text or a mixed sequence of parts. */
export type MessageContent = string | ContentPart[];

/** One chat message exchanged with a run. */
export interface Message {
  role: Role;
  content: MessageContent;
}

/** Guard mode for a run. */
export type GuardMode = "off" | "on" | "auto";

/** Caller-owned judge configuration for guard confirmations. */
export interface GuardJudge {
  /** Caller-owned judge system prompt; the kernel relays it verbatim. */
  prompt: string;
  /** Model id the judge runs on; omitted defers to the kernel's default. */
  model?: string;
  /** Fallback verdict when the judge is not confident: prompt the user or deny. */
  on_unsure?: "ask" | "deny";
  /** Milliseconds to wait for the judge before falling back. */
  timeout_ms?: number;
}

/** Whether memory is engaged for a run. */
export type MemoryMode = "on" | "off";

/**
 * Planning engagement for a run: `off` disables it, `on` lets the agent plan
 * freely, and `review` additionally gates the plan behind a human approval.
 */
export type PlansMode = "off" | "on" | "review";

/** Parameters for {@link RunService.start}. */
export interface StartRunParams {
  /** Client-chosen id for idempotency + continuation; the kernel echoes it. */
  execution_id?: string;
  /** Ephemeral owner-scoped identity for configuration consent in the currently open session.
   * Generate a fresh value when opening or resuming a session. Never persist or derive it from
   * a stored session id, continuation or provider cache hint. Omission requires consent per run. */
  configuration_session_id?: string;
  messages: Message[];
  /**
   * Agent to run as (the entry agent).
   *
   * The vocabulary here is "agent"; the kernel translates it to the engine's
   * profile/entry concept. Agent listing lives on `ConfigService.listAgents`.
   */
  agent?: string;
  /** Continue a prior run (resume / steer-after-end). */
  continue_from?: string;
  /** Persisted conversation identity used for provider affinity. */
  session_id?: string;
  /** Persisted entry-agent instance; hosted turns obtain it from the session. */
  agent_instance_id?: string;
  /**
   * How long a written prompt-cache prefix survives.
   *
   * @remarks Omit to let the kernel derive it: `"1h"` for a run that can park on
   *   a human (an `ask_user` grant, a plan-review gate, or a guard mode that
   *   routes bash confirmations to a person), `"5m"` otherwise. The longer
   *   lifetime costs more to write, so it is worth it only when a pause would
   *   otherwise expire the entry.
   */
  prompt_cache_ttl?: "5m" | "1h";
  guard_mode?: GuardMode;
  guard_judge?: GuardJudge;
  memory?: MemoryMode;
  plans?: PlansMode;
  /** Bind this run to one external task in the kernel's current workspace. */
  task?: ActiveTaskRequestDto;
  /**
   * Start this run from a skill: the kernel loads it by `name` and seeds the run
   * with the skill's instructions, applied to the optional `task` (the `/skill`
   * flow).
   *
   * @remarks
   * A skill that names an agent for itself (frontmatter `agent: "<name>"`)
   * overrides `agent` — the run is the skill's own, with that agent's profile
   * graph, tools and budget. A skill naming no agent does not start a run at all;
   * a UI renders it into the current turn through the skills service's `getPrompt`.
   */
  skill?: { name: string; task?: string };
  /** Structured-output schema for the final result. */
  output_schema?: JsonSchema;
}

/** Terminal / in-flight status of a run. */
export type RunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Per-agent token + model breakdown on a run's final usage.
 *
 * Lets a UI attribute cost per model. Engine-independent projection of the engine's
 * per-agent split (drops lead/subagent-only internals such as spawn counts).
 */
export interface PerAgentUsage {
  /**
   * Which producer these tokens belong to.
   *
   * @remarks `"vision"` is not an agent: it is the engine's image-reading
   * pre-pass, one completion on a model no agent runs on.
   */
  role: AgentRole | "vision";
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** Input tokens served from the provider's prompt cache (read hits). */
  cached_tokens: number;
  /** Input tokens written into the provider's prompt cache. */
  cache_write_tokens: number;
  /** Loop iterations this agent ran, when the engine attributes them. */
  iterations?: number;
}

/** Aggregate usage reported for a run. */
export interface RunUsage {
  iterations: number;
  elapsed_ms: number;
  /**
   * Flat token totals are present on a stored run (`get`). A live run's final
   * result may report per-agent detail (`by_agent`) instead, so these are optional.
   */
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  /** Per-agent/model breakdown — the basis for cost attribution. */
  by_agent?: PerAgentUsage[];
  warnings?: string[];
}

/** A stage handoff is independent of execution status and final output. */
export type RunFinalization =
  | { disposition?: "final"; checkpoint?: never }
  | {
      disposition: "checkpoint";
      /** Bounded stage handoff; separate from a validated final result and continuation authority. */
      checkpoint: { summary: string; next_step: string };
    };

/** Final outcome of a finished run. */
export type RunResult = RunFinalization & {
  execution_id: string;
  status: RunStatus;
  /** Final text or structured value. */
  result?: unknown;
  /** Human-readable reason the loop stopped (e.g. a budget or limit hit). */
  ended_reason?: string;
  usage?: RunUsage;
  /** Present only on a `failed` run: a stable code plus a message. */
  error?: { code: string; message: string };
};

/** Result of requesting compaction through the runs service. */
export type RunCompactionResult =
  | { status: "queued"; execution_id: string }
  | {
      status: "compacted";
      execution_id: string;
      freed_chars: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cached_tokens: number;
        cache_write_tokens: number;
      };
    }
  | {
      status: "skipped";
      execution_id: string;
      reason:
        | "disabled"
        | "no_context"
        | "cannot_fit"
        | "nothing_to_compact"
        | "summarization_disabled"
        | "summarization_failed"
        | "summary_not_effective";
    };

/** Compact list row for a run. */
export interface RunSummary {
  execution_id: string;
  /**
   * The owner this run is filed under.
   *
   * @remarks Optional because a client bound to one owner has no use for it; an
   * operator-facing cross-owner listing populates it.
   */
  owner?: string;
  status: RunStatus;
  created_at: Timestamp;
  ended_at?: Timestamp;
}

/**
 * How much of a run's persisted record was lost or reconstructed when crash
 * recovery rebuilt it from a damaged journal.
 *
 * @remarks Present on a {@link RunDetail} only when something was actually lost
 * or synthesized, so its absence means the record is intact. Counts only: the
 * skipped lines themselves never cross the wire.
 */
export interface RunRecovery {
  /** Journal lines discarded as unparseable, so what they recorded is missing. */
  skipped_lines: number;
  /**
   * `tool_call` events synthesized to settle calls whose real result never
   * arrived; their result text is a placeholder, not the tool's output.
   */
  synthesized_tool_calls: number;
}

/** Full record for `get` — the projected trace the UI renders. */
export interface RunDetail extends RunSummary {
  messages: Message[];
  events: RunEvent[];
  result?: RunResult;
  /**
   * Parent run this one continued from (resume / steer-after-end).
   *
   * Drives history rehydration: a continued run's `messages` are the delta since
   * the parent, not the full conversation, so a resumer appends rather than replaces.
   */
  continue_from?: string;
  plan_ref?: PlanRef;
  /** Task identity recovered from the task capability's minimal persisted run state. */
  active_task?: ActiveTaskBindingDto;
  /** Extension Profile snapshot under which this run started. */
  extension_profile?: ExtensionProfileRunRef;
  /**
   * Present only when this run was rebuilt from a damaged crash journal, saying
   * the record below is incomplete.
   */
  recovery?: RunRecovery;
}

/** Whether an attributed event came from the lead agent or a sub-agent. */
export type AgentRole = "lead" | "subagent";

/**
 * Compact plan snapshot carried on plan-related {@link RunEvent}s.
 *
 * The subset of a plan document a run view needs to render the plan block: its
 * identity ({@link PlanProjection.id | id}), title, current {@link PlanStatus}
 * and {@link PlanRetention}, the CAS revision pair, and the flat task list. The
 * full document is fetched separately through `PlansService.read`.
 */
export interface PlanProjection {
  /** The plan's stable identity across events. */
  id: string;
  /**
   * Optional backend locator. **Opaque to the client and presentational only** —
   * plans are addressed by `id`.
   */
  path?: string;
  title: string;
  status: PlanStatus;
  retention: PlanRetention;
  /** Monotonic counter bumped on every write (the CAS baseline). */
  revision: number;
  /** Counter bumped only when the plan's substance changes; approval binds to it. */
  spec_revision: number;
  tasks: PlanTaskDto[];
}

/**
 * What kind of change a `plan_updated` event reports.
 *
 * `content` = objective/context/tasks body edit, `task` = a task marker/detail
 * change, `status` = the plan's status changed, `recovery` = state restored on
 * continuation.
 *
 * @remarks These are exactly the four `@clarvis/plan`'s capability emits. A
 * member no producer sets reads as a contract a client may switch on and never
 * see, so the union stays the set of changes that actually reach the wire.
 */
export type PlanUpdateChange = "content" | "task" | "status" | "recovery";

/**
 * Common attribution fields on agent-scoped streamed events.
 *
 * @internal
 */
interface Attributed {
  at: Timestamp;
  agent: AgentRole;
  /** Present when `agent === "subagent"`. */
  subagent_id?: string;
}

/** Durable final decision made by the command guard for one tool call. */
export interface CommandGuardReview {
  mode: "on" | "auto";
  outcome: "allowed" | "denied";
  answerer: "policy" | "human" | "judge" | "session_allowlist" | "unavailable";
}

/**
 * Streamed run events — UI-facing, engine-independent projection.
 *
 * A clean protocol-owned vocabulary a UI renders from. Lead and sub-agent
 * variants the engine keeps separate are unified here with an `agent` field
 * (plus `subagent_id` when `agent === "subagent"`). Carries everything the run
 * view needs — iterations, tools, reasoning/output, plan, sub-agents, limits —
 * without exposing the engine's internal trace shape.
 */
export type RunEvent =
  | { type: "run_started"; at: Timestamp; lead_model?: string; subagent_model?: string }
  | {
      type: "run_ended";
      at: Timestamp;
      status: RunStatus;
      reason?: string;
      /** Successful stage disposition, preserved by live and restored transcripts. */
      disposition?: "final" | "checkpoint";
      /**
       * The failure's code, when the run ended on one.
       *
       * @remarks Already recorded on the engine's own `run_ended` entry and, until
       * now, dropped on the way to a client. A resumed session is rebuilt from the
       * persisted trace alone, so without this a run that failed came back saying
       * only that it had failed, and the transcript never named the cause — the
       * message the live path shows comes from the run envelope, which is not
       * persisted at all.
       */
      code?: string;
    }
  | (Attributed & { type: "iteration_started"; iteration: number; model?: string })
  | (Attributed & {
      type: "iteration_completed";
      iteration: number;
      model?: string;
      /** Authoritative final assistant text for the iteration. */
      response: string;
      /** Provider-declared lifecycle phase for the authoritative assistant text. */
      response_phase?: "commentary" | "final_answer";
      input_tokens: number;
      output_tokens: number;
      /**
       * How many of `input_tokens` the provider served from its prefix cache.
       *
       * @remarks `input_tokens` is the gross prompt, cache hits included, which
       * is what pricing needs. A client showing "how much did this turn read"
       * wants the two apart, and the engine has always recorded the split on the
       * iteration's trace entry — it was simply dropped on the way to a client,
       * so the live run strip could only ever state the gross figure while the
       * session totals stated the net one. Optional because a provider may not
       * report it, and because runs traced before this field existed replay
       * without it.
       */
      cached_tokens?: number;
    })
  | (Attributed & {
      type: "tool_call_started";
      call_id: string;
      tool: string;
      server: string;
      arguments?: Record<string, unknown>;
    })
  | (Attributed & {
      type: "tool_call";
      call_id?: string;
      tool: string;
      server: string;
      arguments?: Record<string, unknown>;
      ok: boolean;
      result?: string;
      error?: string;
      diff?: string;
      /** Final command-review fact, persisted with the shell call for replay. */
      guard?: CommandGuardReview;
    })
  /**
   * Live, incremental slice of a running tool's output (streamed only — never
   * part of a stored run's `events`). The client appends per `call_id` and
   * renders a tail; the closing `tool_call` carries the authoritative output.
   */
  | (Attributed & {
      type: "tool_output_delta";
      call_id: string;
      chunk: string;
    })
  /**
   * A tool call the model is still composing: the provider has named the tool
   * and is streaming its arguments, but the call has not started (streamed only
   * — never part of a stored run's `events`).
   *
   * On a real run this is most of the wall clock, and until it existed a client
   * had nothing at all to show for it: the first event a tool call otherwise
   * produces is `tool_call_started`, which cannot be emitted until the whole
   * model call has returned. A client should treat the first event for a
   * `call_id` as "this call now exists" and reconcile it with the later
   * `tool_call_started` under the same id.
   *
   * `chars` is the cumulative size of the argument payload so far, not a slice,
   * so an event dropped under backpressure costs nothing. The payload itself is
   * not carried; the authoritative arguments arrive with `tool_call_started`.
   */
  | (Attributed & {
      type: "tool_input_delta";
      call_id: string;
      tool: string;
      chars: number;
      /** Cumulative characters observed across the physical provider stream. */
      stream_chars?: number;
      /** Present only after the provider closed this argument stream. */
      complete?: true;
    })
  | (Attributed & { type: "reasoning"; iteration: number; text: string })
  | (Attributed & {
      type: "text_delta";
      iteration: number;
      channel: "text" | "reasoning";
      text: string;
      /**
       * First delta of a fresh stream (e.g. after a retry): replace, don't append.
       */
      reset: boolean;
    })
  | (Attributed & { type: "model_error"; iteration: number; kind: string; message: string })
  /**
   * A transient provider failure that is about to be retried, reported before
   * the backoff sleep.
   *
   * @remarks Not an error: the run is healthy and waiting on purpose. A client
   * should show it as a transient state of the current turn — "retrying in 4s
   * (2/3)" — rather than as a transcript entry, since a retry is something the
   * turn is enduring, not something it did. Without it a rate-limited call is
   * indistinguishable from a wedged one for as long as the backoff lasts.
   */
  | (Attributed & {
      type: "model_retry";
      iteration: number;
      kind: string;
      attempt: number;
      max_retries: number;
      delay_ms: number;
      status?: number;
      retry_after_ms?: number;
    })
  | {
      type: "delegation_created";
      at: Timestamp;
      delegation_id: string;
      task_id?: string;
      title: string;
      task: string;
      profile?: string;
      tools?: string[];
    }
  | {
      type: "delegation_started";
      at: Timestamp;
      delegation_id: string;
      task_id?: string;
      model?: string;
    }
  | {
      type: "delegation_completed" | "delegation_failed";
      at: Timestamp;
      delegation_id: string;
      task_id?: string;
      status: string;
      /** Bounded terminal summary for rosters; the full result stays in the run trace. */
      summary?: string;
    }
  | {
      type: "workflow_run_started";
      at: Timestamp;
      run_id: string;
      parent_run_id: string;
      profile?: string;
      title: string;
      task: string;
      round_id?: string;
      pass?: number;
      item_index?: number;
      replica?: number;
      replica_count?: number;
    }
  | {
      /** Live-only replacement for the provisional workflow-manager title. */
      type: "workflow_title_updated";
      at: Timestamp;
      run_id: string;
      title: string;
    }
  | {
      /** Live projection of the latest Admiral-controlled round checkpoint. */
      type: "workflow_sequence_state";
      at: Timestamp;
      run_id: string;
      session_id: string;
      status:
        "running_round" | "awaiting_manager" | "completed" | "stopped" | "failed" | "cancelled";
      revision: number;
      round_id?: string;
      pass?: number;
      next_round_id?: string;
      next_pass?: number;
      leaders_started: number;
      max_total_leaders: number;
      reason?: string;
    }
  | {
      /**
       * Live per-leader progress for the workflow tree: cumulative iteration count
       * and token usage summed across the leader's own run (its lead loop plus any
       * sub-agents it delegated). Emitted repeatedly as a leader advances, so a UI
       * can show tokens/iterations ticking up per leader. Live-only — NOT written to
       * the manager's trace, so it does not rehydrate (mirrors sub-agent activity).
       */
      type: "workflow_run_progress";
      at: Timestamp;
      run_id: string;
      parent_run_id: string;
      iterations: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens?: number;
    }
  | {
      type: "workflow_run_completed";
      at: Timestamp;
      run_id: string;
      parent_run_id: string;
      status: RunStatus;
    }
  | {
      type: "workflow_run_failed";
      at: Timestamp;
      run_id: string;
      parent_run_id: string;
      status: RunStatus;
      error?: { code: string; message: string };
    }
  | ({ type: "plan_created"; at: Timestamp } & PlanProjection)
  | ({ type: "plan_updated"; at: Timestamp; change: PlanUpdateChange } & PlanProjection)
  | ({
      type: "plan_removed";
      at: Timestamp;
      id: string;
      path?: string;
      revision: number;
      spec_revision: number;
    } & Partial<Pick<PlanProjection, "title" | "status" | "retention" | "tasks">>)
  | ({ type: "plan_review_requested"; at: Timestamp } & PlanProjection)
  | ({
      type: "plan_review_resolved";
      at: Timestamp;
      outcome: "approved" | "changes_requested" | "cancelled";
    } & PlanProjection)
  | {
      type: "soft_limit_check";
      at: Timestamp;
      dimension: "tokens" | "iterations";
      used: number;
      limit: number;
      outcome: string;
    }
  | (Attributed & {
      type: "compaction_started";
      mode: "scheduled" | "forced";
    })
  | (Attributed & {
      type: "compaction";
      operation: string;
      fallback_reason?: "summarization_failed" | "summary_not_effective";
      freed_chars?: number;
      contribution_count?: number;
      requested?: true;
      user_contribution_count?: number;
    })
  /**
   * The vision pre-pass: one completion read the turn's images for an agent
   * whose own model cannot see them.
   *
   * @remarks Not a delegation event. No sub-agent exists, so there is no agent
   * id a client could poll, steer or stop.
   */
  | {
      type: "vision_analysis";
      at: Timestamp;
      model: string;
      image_count: number;
      status: "completed" | "failed";
      result: string;
    }
  | (Attributed & {
      type: "compaction_skipped";
      reason:
        | "disabled"
        | "nothing_to_compact"
        | "summarization_disabled"
        | "summarization_failed"
        | "summary_not_effective";
    })
  | {
      type: "elicitation_requested";
      at: Timestamp;
      agent?: AgentRole;
      subagent_id?: string;
      question: string;
      options?: string[];
    }
  /** Settled elicitation answer (for resume reconstruction; not shown live). */
  | {
      type: "elicitation_resolved";
      at: Timestamp;
      agent?: AgentRole;
      subagent_id?: string;
      question: string;
      outcome: "accept" | "decline" | "cancel";
      answer?: string;
      options?: string[];
    }
  | (Attributed & { type: "steering_applied"; message: string })
  | { type: "memory_ingest"; at: Timestamp; detail: MemoryIngestDetail }
  /**
   * Sanitized, bounded projection emitted by a capability whose event vocabulary
   * is not part of this protocol version.
   *
   * @remarks Capability event names are deliberately open at the capability
   * boundary, while this discriminated union is deliberately closed for clients.
   * Keeping the open name in `projection` instead of using it as `type` preserves
   * both contracts: clients have one stable fallback to render and an extension
   * cannot make an exhaustive protocol switch crash at runtime.
   */
  | {
      type: "capability_event";
      at: Timestamp;
      capability: string;
      kind: string;
      projection: string;
      detail?: unknown;
      /** True when the original JSON projection exceeded the wire detail cap. */
      truncated: boolean;
    }
  /**
   * Live-stream events the kernel discarded because the consumer fell behind
   * (streamed only — never part of a stored run's `events`). Emitted at most
   * once, as the last event before the stream ends; `dropped` counts what was
   * discarded up to that point. Only incremental variants are ever dropped, and
   * their authoritative content still arrives — a `tool_call` carries its tool's
   * full output and `iteration_completed.response` the final assistant text — so
   * this reports fidelity of the *live* view, not data loss.
   */
  | { type: "events_dropped"; at: Timestamp; dropped: number }
  /** Persisted run telemetry for MCPs omitted from an otherwise runnable pool; presentation is client-owned. */
  | { type: "mcp_degraded"; at: Timestamp; servers: { name: string; reason: string }[] };

/** Structured command context on a `guard_confirm` elicitation. */
export interface ElicitationCommandDetail {
  /** The literal command awaiting approval, exactly as the agent wants to run it. */
  command: string;
  /** Absolute directory the command would run in. */
  cwd: string;
  /** Why the guard is asking — clients must show it alongside the command. */
  reason: string;
  /** Analyzer caveat the approver must see (e.g. undecidable expansions). */
  warning?: string;
}

/** Server → client question raised during a run. */
export interface ElicitationRequest {
  id: string;
  execution_id: string;
  /**
   * Why the run is asking: `ask_user` (a free question), `guard_confirm` (a
   * command awaiting approval), `plan_review` (a proposed plan awaiting
   * approval), or `workflow_review` (an installed workflow preflight).
   * Open-ended (`string & {}`) so a kernel may add kinds without a
   * protocol bump.
   */
  kind: "ask_user" | "guard_confirm" | "plan_review" | "workflow_review" | (string & {});
  prompt: string;
  schema?: JsonSchema;
  /**
   * Structured command context for guard confirmations — clients render this
   * directly (e.g. as highlighted code) and never parse `prompt`, which stays
   * the human-readable fallback.
   */
  detail?: ElicitationCommandDetail;
}

/** Client answer to a pending {@link ElicitationRequest}. */
export interface ElicitationResponse {
  /** Id of the {@link ElicitationRequest} being answered. */
  id: string;
  /** The user's disposition: approve, refuse, or abort the run. */
  action: "accept" | "decline" | "cancel";
  /** Answer payload when `action === "accept"` (shape follows the request's schema). */
  content?: unknown;
}

/**
 * Live handle to one run.
 *
 * Transport-agnostic: `events` is fed by whatever transport the client was built on
 * (stdio notifications, SSE frames, …).
 */
export interface RunHandle {
  readonly execution_id: string;
  /**
   * Ordered stream of progress events until its independent stream-end signal.
   * It may remain open briefly after {@link RunHandle.done} while bounded
   * post-run notices drain.
   */
  readonly events: AsyncIterable<RunEvent>;

  /**
   * Inject a steering message into the in-flight run.
   *
   * @param message - Free text or a full {@link Message}.
   */
  steer(message: Message | string): Promise<void>;

  /**
   * Queue an entry-agent context compaction for the next iteration preamble.
   *
   * @param request - Optional additive instruction describing what to preserve.
   */
  compact(request?: string): Promise<void>;

  /** Request cancellation of the in-flight run. */
  cancel(): Promise<void>;

  /**
   * Answer a pending elicitation.
   *
   * @param response - Accept / decline / cancel payload.
   */
  respond(response: ElicitationResponse): Promise<void>;

  /**
   * Register an elicitation handler (alternative to scanning `events`).
   *
   * @param handler - Called when the kernel asks the user a question.
   */
  onElicit(handler: (req: ElicitationRequest) => void): void | (() => void);

  /** Observe a question's response or expiry without retaining stale prompts on reconnect. */
  onElicitSettled?(handler: (id: string) => void): () => void;

  /** Resolves when execution ends; it does not imply that `events` has closed. */
  readonly done: Promise<RunResult>;

  /** Optional local queue counters for bounded host diagnostics. */
  readonly buffered?: () => {
    buffered_items: number;
    buffered_bytes: number;
    dropped: number;
  };

  /**
   * Resolves after execution and bounded post-run event delivery both finish.
   * Hosts use this for lifecycle leases without becoming a second consumer of
   * the single-consumer {@link RunHandle.events} stream.
   */
  readonly closed: Promise<void>;
}

/** Start, inspect, list, and delete runs. */
export interface RunService {
  /**
   * Start a new run (or continue one) and return a live handle.
   *
   * @param params - Messages, agent/skill, guard, and continuation options.
   */
  start(params: StartRunParams): Promise<RunHandle>;

  /** Queue compaction on a live run, or compact a settled run's continuation in place. */
  compact(
    execution_id: string,
    request?: string,
    options?: { mechanical_target_tokens?: number },
  ): Promise<RunCompactionResult>;

  /** Inspect the restorable context size without returning its private contents. */
  context(
    execution_id: string,
    target_window_tokens?: number,
  ): Promise<{
    execution_id: string;
    estimated_tokens: number;
    has_context: boolean;
    high_water_tokens?: number;
    requires_compaction?: boolean;
  }>;

  /**
   * Load the full projected record for a run.
   *
   * @param execution_id - Run id.
   */
  get(execution_id: string): Promise<RunDetail>;

  /**
   * Page through run summaries.
   *
   * @param page - Optional pagination.
   */
  list(page?: Pagination): Promise<Page<RunSummary>>;

  /**
   * Delete a stored run.
   *
   * @param execution_id - Run id.
   */
  delete(execution_id: string): Promise<void>;
}
