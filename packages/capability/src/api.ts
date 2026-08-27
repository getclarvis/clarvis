/** Author of a {@link Message}: the system prompt, the user, or the assistant. */
export type MessageRole = "system" | "user" | "assistant";

/** A plain-text content part. */
export interface TextPart {
  type: "text";
  text: string;
}

/** An image content part; `image` is the image data (e.g. a data/base64 payload) and `mediaType` its MIME type when known. */
export interface ImagePart {
  type: "image";
  image: string;
  mediaType?: string;
}

/** One part of a multimodal message: {@link TextPart} or {@link ImagePart}. */
export type ContentPart = TextPart | ImagePart;

/** A message body: a bare string, or an array of {@link ContentPart}s for multimodal content. */
export type MessageContent = string | ContentPart[];

/** One input message to the loop: a {@link MessageRole} and its {@link MessageContent}. */
export interface Message {
  role: MessageRole;
  content: MessageContent;
}

/**
 * A mid-run steering message injected into an in-flight run.
 *
 * @remarks `id` lets the source and consumer correlate a steer (e.g. for
 * deduplication or acknowledgment); see {@link SteerSource}.
 */
export interface SteerMessage {
  content: MessageContent;
  id?: string;
}

/**
 * A pull-based source of {@link SteerMessage}s the loop drains between iterations.
 *
 * @remarks {@link drain} returns and clears any queued steers.
 */
export interface SteerSource {
  drain(): SteerMessage[];
  /** Optional signal that the consuming loop has finished and will not drain
   * again. A source may use it to reject further input (e.g. re-route a late
   * steer to a fresh run) instead of enqueuing onto a queue no one will read. */
  close?(): void;
}

/**
 * A user request to compact the entry agent's live context before its next
 * model iteration.
 *
 * @remarks The optional text is an additive instruction for this pass. It is
 * never a conversation message and can never replace the agent profile's base
 * compaction prompt.
 */
export interface CompactionRequest {
  request?: string;
}

/** A pull-based source of queued {@link CompactionRequest}s. */
export interface CompactionSource {
  /** Returns and clears requests queued since the previous drain. */
  drain(): CompactionRequest[];
  /** Optional signal that the entry loop has finished and will not drain again. */
  close?(): void;
}

/** A reference to a model-issued tool call: its provider `id`, the tool `name`, and the raw `arguments`. */
export interface ToolCallRef {
  id: string;
  name: string;
  arguments: unknown;
}

/** An image returned by a tool: `data` (base64/data payload) plus its `mediaType`. */
export interface ToolResultImage {
  data: string;
  mediaType: string;
}

/**
 * One provider-issued reasoning block that must be replayed with its assistant
 * turn on a later model call.
 *
 * @remarks `providerOptions` is opaque, provider-owned continuation state. For
 * example, Anthropic stores a thinking signature there and native OpenAI stores
 * a reasoning item id/encrypted payload. Keeping the envelope provider-neutral
 * lets the matching SDK adapter interpret it without teaching the loop about a
 * provider's wire vocabulary.
 */
export interface AssistantReasoningPart {
  text: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/** The visible lifecycle phase of one assistant text part. */
export type AssistantMessagePhase = "commentary" | "final_answer";

/**
 * One provider-issued assistant text block retained for a later model call.
 *
 * @remarks `phase` is the provider-neutral lifecycle signal consumers may
 * render. `providerOptions` remains opaque replay state, including identifiers
 * a provider requires when manually continuing a response with storage off.
 */
export interface AssistantTextPart {
  text: string;
  phase?: AssistantMessagePhase;
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * A message in the loop's live in-memory conversation.
 *
 * @remarks Beyond a plain {@link Message}, this adds the two runtime-only shapes:
 * an assistant turn carrying `tool_calls`, and a `tool` turn carrying a tool
 * result (with optional `images`) keyed by `tool_call_id`.
 */
export type LiveMessage =
  | Message
  | {
      role: "assistant";
      content: MessageContent;
      reasoning: AssistantReasoningPart[];
      text_parts?: AssistantTextPart[];
    }
  | { role: "assistant"; content: string; text_parts: AssistantTextPart[] }
  | {
      role: "assistant";
      content: string;
      tool_calls: ToolCallRef[];
      reasoning?: AssistantReasoningPart[];
      text_parts?: AssistantTextPart[];
    }
  | { role: "tool"; tool_call_id: string; content: string; images?: ToolResultImage[] };

/** Transport an MCP server speaks: `stdio`, streamable `http`, or `sse`. */
export type ToolTransport = "stdio" | "http" | "sse";

/** Which role an agent plays in the run topology: the `lead` or a `subagent`. */
export type AgentRole = "lead" | "subagent";

/**
 * Configuration for connecting to one MCP server.
 *
 * @remarks `command`/`args`/`env`/`cwd` apply to `stdio`; `url`/`headers` apply
 * to `http`/`sse`. `shared` opts the connection into cross-agent sharing;
 * `resources` enables the server's resource operations (list/read).
 */
export interface McpServerConfig {
  name: string;
  transport: ToolTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  cwd?: string;
  shared?: boolean;
  resources?: boolean;
}

/** Which physical adapter and billing boundary a provider maps to. */
export type ProviderKind =
  "openai-compatible" | "openai" | "anthropic" | "google" | "openai-codex" | "xai-grok";

/**
 * How a model's prompt cache is asked for.
 *
 * @remarks `explicit` means the provider charges to *create* a cache entry, so
 * creation is an act the caller performs and the request must carry cache
 * markers. `implicit` means creation is free and the provider caches on its
 * own, so there is nothing to send and the value is informational. `off`
 * withholds markers on every provider kind.
 *
 * Absent is not `off`: it means nobody has decided, and a host that can consult
 * a pricing catalog is expected to resolve it. A catalog that does not describe
 * a model must leave it absent rather than write `off` — absence of information
 * is not evidence of absence, and two models are known to be mis-described by
 * the published catalog today.
 */
export type PromptCacheMode = "explicit" | "implicit" | "off";

/**
 * Static facts about one model.
 *
 * @remarks `context_window_tokens` is the model's total window (used for
 * compaction thresholds); `max_output_tokens` caps a single response;
 * `capabilities` lists opaque feature tags (e.g. vision) callers may key on;
 * `reasoning_efforts` records the provider-published selectable levels;
 * `prompt_cache` is the {@link PromptCacheMode}. `headers` and `body` override
 * the provider's own, per top-level key — see {@link ProviderConfig}.
 */
export interface ModelConfig {
  context_window_tokens: number;
  max_output_tokens?: number;
  capabilities?: string[];
  reasoning_efforts?: string[];
  prompt_cache?: PromptCacheMode;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

/**
 * Configuration for one model provider.
 *
 * @remarks `kind` selects the SDK adapter; `base_url` overrides the endpoint;
 * `api_key_env` names the environment variable holding the key; `models`
 * describes the models this provider serves ({@link ModelConfig}).
 *
 * `headers` are sent on every request to this provider; values may embed
 * `${VAR}` references resolved from the environment at client construction, and
 * must never be a literal credential — a workspace `settings.json` is authored
 * content a user commits. `body` is merged into the request body and is
 * honoured only by `openai-compatible`, the one kind whose SDK exposes a seam
 * for it; it may not carry a key that *is* the cached prefix (`messages`,
 * `tools`) or that contradicts the resolved call (`model`, `stream`,
 * `tool_choice`, `stream_options`).
 */
export interface ProviderConfig {
  name: string;
  kind: ProviderKind;
  base_url?: string;
  api_key_env?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  models?: Record<string, ModelConfig>;
}

/**
 * What to do when a budget limit is hit: `stop` the run, or `escalate` (ask to
 * continue past a soft limit).
 *
 * @remarks Two members because a limit answers exactly one question — may the
 * run pass it without a human? `stop` says no, and validation then *requires*
 * the bounds (`total_token_limit` and every running profile's
 * `iteration_limit`) and rejects `max_escalations`, because a hard limit that
 * can be extended is not one. `escalate` says yes-if-asked, and the bounds
 * become checkpoints that `advance` pushes out one interval at a time.
 *
 * There is no third member because the only remaining behaviour is "pass it
 * without asking", which is the absence of a budget rather than a mode of one —
 * and that is already expressible by leaving the bounds unset under `escalate`.
 */
export type BudgetMode = "stop" | "escalate";

/**
 * A run's resource budget.
 *
 * @remarks `on_exceed` picks the {@link BudgetMode}; `total_token_limit` and
 * `timeout_ms` set the token and wall-clock caps; `max_escalations` bounds how
 * many times an `escalate` budget may be extended.
 *
 * Which fields are optional here is a floor, not the contract: `enforceBudgetMode`
 * makes `total_token_limit` mandatory under `stop` and refuses `max_escalations`
 * there, and `enforceEnvCeilings` caps each against its `CLARVIS_*_CEILING`. The
 * type stays permissive so one shape serves both modes; the run request is where
 * the combination is judged.
 */
export interface BudgetConfig {
  on_exceed: BudgetMode;
  total_token_limit?: number;
  timeout_ms?: number;
  max_escalations?: number;
}

/** A grant owned by the engine itself. Capabilities declare their own names. */
export type BuiltinGrant = "ask_user" | "read_workspace" | "edit_workspace" | "run_commands";

/**
 * A capability an agent profile is granted.
 *
 * @remarks The type is intentionally open: external capability grant names are
 * registered before request validation rather than added to this union.
 */
export type Grant = BuiltinGrant | (string & {});

/** How much reasoning summary a model should surface: `off`, `auto`, or `detailed`. */
export type ReasoningSummary = "off" | "auto" | "detailed";

/** Reasoning-effort level requested of a model that supports it, from `off` through `max`. */
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Per-agent overrides for context compaction (all optional; unset fields fall
 * back to loop defaults).
 *
 * @remarks `context_fraction` is the window-fill fraction that triggers
 * compaction and `target_fraction` the fraction to compact down to;
 * `max_result_chars` caps retained tool-result size; `preserve_recent_tokens` is
 * the token budget of the newest tool results held back from eviction; `prompt`
 * overrides the built-in summarization prompt and `prompt_mode: "none"` turns
 * summarization off in favour of mechanical eviction. `enabled: false` disables
 * compaction entirely.
 */
export interface CompactionConfigInput {
  enabled?: boolean;
  context_fraction?: number;
  target_fraction?: number;
  max_result_chars?: number;
  preserve_recent_tokens?: number;
  prompt?: string;
  prompt_mode?: "summarize" | "none";
}

/**
 * Per-agent overrides for provider retry policy: `max_retries` caps retry
 * attempts and `max_retry_after_ms` caps how long a provider-requested backoff
 * is honored.
 */
export interface RetryConfigInput {
  max_retries?: number;
  max_retry_after_ms?: number;
}

/**
 * Per-agent orchestration knobs.
 *
 * @remarks `force_tool_on_nudge` forces a tool call on the iteration after any
 * finalize gate nudges this agent — a property of the agent's own loop, applied
 * by the loop rather than by whichever capability raised the nudge.
 *
 * A capability's own nudge budget is that capability's settings block to own,
 * not an agent profile's: a profile must not decide how long a run tolerates
 * work a capability is tracking.
 */
export interface OrchestrationConfigInput {
  force_tool_on_nudge?: boolean;
}

/**
 * The full definition of one agent the loop can run.
 *
 * @remarks `model`, `tools`, and `grants` set the agent's model, tool surface,
 * and {@link Grant}s. Delegation is governed by `can_spawn` (allowed sub-agent
 * profiles) and `default_spawn` (the default target). `iteration_limit`,
 * `stagnation_threshold`, and
 * `call_timeout_ms` bound the agent's execution; `reasoning_*`, `retry`,
 * `compaction`, and `orchestration` supply per-agent overrides. Unset optionals
 * fall back to loop/environment defaults.
 */
export interface AgentProfile {
  name: string;
  description?: string;
  model: string;
  base_prompt?: string;
  tools: string[];
  grants?: Grant[];
  can_spawn?: string[];
  default_spawn?: string;
  iteration_limit?: number;
  stagnation_threshold?: number;
  call_timeout_ms?: number;
  reasoning_summary?: ReasoningSummary;
  reasoning_effort?: ReasoningEffort;
  retry?: RetryConfigInput;
  compaction?: CompactionConfigInput;
  orchestration?: OrchestrationConfigInput;
}

/**
 * The complete input to one loop run.
 *
 * @remarks `messages` is the seed conversation, `profiles` the agent definitions,
 * and `entry` names the profile to start from; `servers`, `providers`, and
 * `budget` supply the MCP servers, model providers, and resource caps. Optional
 * fields tune the run: `execution_id` sets/asserts the run's id (a clash raises
 * `execution_id_conflict`); `continue_from` resumes a prior run's persisted
 * trace; `prompt_cache_key` overrides the prompt-cache key (defaulting to the
 * execution id); `prompt_cache_ttl` sets how long a written cache prefix
 * survives; `output_schema` constrains the agent's result;
 * `elicit_wait_ms` bounds user elicitation; and `agents`, `guard_mode`,
 * `guard_judge` toggle or tune the corresponding capabilities for this run.
 *
 * A capability shipped in its own package takes its per-run param through a
 * registered {@link CapabilitySettingsSpec} instead, read back with
 * `RunCapabilityContext.requestParam` — which is why `memory` and `plans` are
 * not fields here.
 */
/**
 * How long a provider should keep a written prompt-cache prefix alive.
 *
 * @remarks Anthropic bills a `"5m"` write at 1.25x base input and a `"1h"` write
 *   at 2x, while a read costs 0.1x either way. `"1h"` pays off only for a run
 *   that actually parks on a human longer than five minutes — see
 *   `humanParkLikely` in the request schema for how the default is derived.
 *
 *   The union has two members because Anthropic offers two; it is a menu, not a
 *   design. Every other provider Clarvis targets caches on the longest
 *   byte-identical prefix with a TTL of its own choosing and has nothing to
 *   receive here, which is why the field is scoped to the one kind that does.
 */
export type PromptCacheTtl = "5m" | "1h";

export interface RunRequest {
  execution_id?: string;
  continue_from?: string;
  prompt_cache_key?: string;
  prompt_cache_ttl?: PromptCacheTtl;
  messages: Message[];
  servers: McpServerConfig[];
  profiles: AgentProfile[];
  entry: string;
  /**
   * Model used to read the turn's images when the entry agent's own model
   * cannot see them.
   *
   * @remarks Deliberately a model reference rather than a profile name: reading
   * an image is a capability of a model, and the pass that uses it is a single
   * completion with no tools, no workspace and no agent identity.
   */
  vision_model?: string;
  budget: BudgetConfig;
  providers: ProviderConfig[];
  output_schema?: unknown;
  elicit_wait_ms?: number;
  /**
   * Whether a hard convergence-guard trip asks the user before ending the run.
   *
   * @remarks Off by default, and deliberately an explicit opt-in rather than
   * something inferred from the presence of an elicit channel. A headless
   * caller supplies a working channel that auto-declines, so inferring would
   * add a prompt round-trip to every guard trip in exactly the deployments that
   * cannot answer it — while the observable outcome stayed the same.
   */
  guard_escalation?: boolean;
  agents?: AgentsParam;
  guard_mode?: GuardMode;
  guard_judge?: GuardJudgeConfig;
  /**
   * Host-derived context for a user-invoked skill command.
   *
   * @remarks Read only by the hooks capability so an external
   * `UserPromptExpansion` observer fires at the same boundary as the skill
   * expansion that seeded this run. Ordinary prompts and model-initiated
   * `load_skill` calls omit it.
   */
  hook_user_prompt_expansion?: { command_name: string };
}

/**
 * Per-run override of the agent-supervision bounds.
 *
 * @remarks Every field is a ceiling on something the supervising *parent* pays
 * for — its memory (the per-child buffers), its context (the poll page, the
 * notice cap) or its liveness (how many children may run at once). There is no
 * on/off field: whether the surface exists follows from whether the run's entry
 * agent can spawn at all. Omitted fields fall back to the product defaults.
 *
 * The count is closed, not chosen: there is exactly one field per bound
 * `resolveAgentsLimits` folds, so this interface, `AGENTS_DEFAULTS` and
 * `AgentsLimits` are three spellings of one list. A bound with no field here is
 * one no caller can reach; a field with no bound is one nothing reads. Both
 * halves live in `@clarvis/supervision`, which explains where each number came
 * from.
 */
export interface AgentsParam {
  buffer_lines?: number;
  buffer_bytes?: number;
  /** Aggregate retained activity-buffer payload across the whole registry. */
  max_total_buffer_bytes?: number;
  poll_max_bytes?: number;
  await_timeout_ms?: number;
  max_live_children?: number;
  max_retained_children?: number;
  max_notices_per_iteration?: number;
  max_consecutive_failed_children?: number;
  finish_nudges?: number;
}

/** Command-guard policy: `off` (allow all), `on` (ask for approval), or `auto` (an LLM judge decides, configured by {@link GuardJudgeConfig}). */
export type GuardMode = "off" | "on" | "auto";

/** Judge configuration for guard_mode 'auto': the caller supplies the judge's
 * entire system prompt; the host's guard resolver consumes it. */
export interface GuardJudgeConfig {
  prompt: string;
  model?: string;
  on_unsure?: "ask" | "deny";
  timeout_ms?: number;
}

/**
 * The result of handling one tool call.
 *
 * @remarks `text` is the textual result fed back to the model; `progress`
 * reports whether the call advanced the task (used by stagnation detection);
 * `taskId` correlates a plan task; `images` carries any returned images.
 */
export interface HandlerResult {
  text: string;
  progress: boolean;
  taskId?: string;
  images?: ToolResultImage[];
}

/**
 * A lifecycle hook's ruling where the action cannot be rewritten.
 *
 * @remarks
 * `pass` allows it; `deny` blocks it with a message; `advise` allows it while
 * surfacing a message to the model.
 *
 * Three of the four fire points take this narrower type rather than
 * {@link HookVerdict}, so a hook that tries to rewrite at one of them is a
 * compile error rather than a verdict computed and then dropped. The runtime
 * refuses it too, for a hook this compiler never saw.
 */
export type GateVerdict =
  { kind: "pass" } | { kind: "deny"; message: string } | { kind: "advise"; message: string };

/**
 * A lifecycle hook's ruling where the action *can* be rewritten.
 *
 * @remarks
 * {@link GateVerdict} plus `rewrite`, which allows the action with different
 * arguments and an optional message of its own.
 *
 * `rewrite` is meaningful only where the host offers a rewritable action, which
 * today is `beforeToolUse` alone. It is safe there because of where hooks sit in
 * the dispatch: a rewrite happens **upstream** of both the tool's own schema
 * validation and the command guard, so replacement arguments are validated like
 * any others and still meet the guard. A hook cannot use it to get around
 * policy; it can only change what policy is asked about.
 *
 * The replacement is total, not a merge — a partial object would make a hook's
 * effect depend on which keys the model happened to send.
 *
 * A spawn is not an exception to this. `delegate_task` is dispatched through the
 * ordinary tool loop, so a `beforeToolUse` hook matching it already replaces the
 * brief and the profile — upstream of the spawn's own validation, and with the
 * model told what actually ran. Offering `rewrite` a second time at
 * `preDelegateTask` would mean rebuilding that non-silence at a second site.
 */
export type HookVerdict = GateVerdict | { kind: "rewrite"; arguments: unknown; message?: string };

/** Context passed to a `beforeToolUse` hook: the `tool` about to run and its `arguments`. */
export interface BeforeToolUseContext {
  /** Model-facing wire name used to dispatch the call. */
  tool: string;
  /** Stable dotted identity when the wire name is a projection of another tool namespace. */
  toolFullName?: string;
  arguments: unknown;
}

/** Context passed to an `afterToolUse` hook: the `tool`, its `arguments`, and the produced (read-only) {@link HandlerResult}. */
export interface AfterToolUseContext {
  /** Model-facing wire name used to dispatch the call. */
  tool: string;
  /** Stable dotted identity when the wire name is a projection of another tool namespace. */
  toolFullName?: string;
  arguments: unknown;
  result: Readonly<HandlerResult>;
}

/**
 * Context passed to a `preFinalize` hook, just before an agent's result is
 * committed.
 *
 * @remarks `mode` distinguishes a plain-text finish (`text` set) from a
 * structured `submit_result` finish (`value` set, already validated against the
 * run's output schema). `subagentInstanceId` is present when the finalizing
 * agent is a sub-agent.
 */
export interface PreFinalizeContext {
  agent: AgentRole;
  subagentInstanceId?: string;
  mode: "text" | "submit";
  /** Final assistant text (mode === "text"). */
  text?: string;
  /** Validated submit_result payload (mode === "submit"). */
  value?: unknown;
}

/** Context passed to a `preDelegateTask` hook: the delegated task's `title`, `task` body, target `profile`, and optional plan `taskId`. */
export interface PreDelegateTaskContext {
  title: string;
  task: string;
  profile: string;
  taskId?: string;
}

/** Context passed to an `onRunStart` hook: the run `mode`, the `entry` profile, and the resolved lead/sub-agent model ids when known. */
export interface RunStartContext {
  mode: string;
  entry: string;
  leadModel?: string;
  subagentModel?: string;
}

/** Context passed to an `onRunEnd` hook: the final `status`, any `errorCode`, and the run's iteration and elapsed-time totals. */
export interface RunEndContext {
  status: string;
  errorCode?: string;
  iterationsUsed: number;
  elapsedMs: number;
}

/** Context passed to an `onSubagentComplete` hook: the finished sub-agent's instance id, its `status`, and its `result` text. */
export interface SubagentCompleteContext {
  subagentInstanceId: string;
  status: string;
  result: string;
}

/** Context passed to an `onPreCompact` hook: which `agent` is about to compact and the `estimatedTokens` in its context. */
export interface PreCompactContext {
  agent: AgentRole;
  subagentInstanceId?: string;
  estimatedTokens: number;
}

/**
 * One party's request that a compaction preserve something in particular.
 *
 * @remarks
 * A contribution is **added** to the summarization prompt the agent's profile
 * resolved; it can never replace it. That is enforced by shape rather than by
 * convention: the type carries text and a label, and there is no field with
 * which "instead of" could be expressed. The base prompt reaches
 * `runCompaction` as its own separate argument, so no code path can assign a
 * contribution to it.
 *
 * The profile's prompt answers "what should always be preserved". A contribution
 * answers "what should be preserved given what happened in *this* run" — the
 * question a value chosen before the run started cannot answer.
 */
export interface CompactionContribution {
  /**
   * Who asked. Recorded for attribution; never shown to the summarizer.
   *
   * @remarks Coarse on purpose. Workspace hooks all report `hook`: the settings
   *   merge orders operator hooks before plugin ones but does not tag which is
   *   which, and inventing that provenance here would mean threading an origin
   *   through a config shape that has no business carrying one.
   */
  source: string;
  /** The request itself. Clamped by the consumer, not by the producer. */
  text: string;
}

/** Context passed to an `onModelCallError` hook: the failing `agent`, `iteration`, `model`, and the error `message`. */
export interface ModelCallErrorContext {
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  model: string;
  message: string;
}

/** Context passed to an `onBudgetExhausted` hook: the `agent`, whether the budget was `exhausted` or the model `declined` to continue, and the token/iteration totals. */
export interface BudgetExhaustedContext {
  agent: AgentRole;
  reason: "exhausted" | "declined";
  tokensUsed: number;
  iterationsUsed: number;
}

/** Context passed to an `onUserSteer` hook: the `agent` and `iteration` receiving the steer, plus the steer `message` and its optional `id`. */
export interface UserSteerContext {
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  message: string;
  id?: string;
}

/**
 * A set of lifecycle callbacks a host registers to observe and gate a run.
 *
 * @remarks The `beforeToolUse`/`afterToolUse`/`preFinalize`/`preDelegateTask`
 * gates return a {@link HookVerdict} and can block or advise an action; the
 * `on*` observers return `void` and only react. All hooks are optional.
 */
export interface LifecycleHook {
  beforeToolUse?: (context: BeforeToolUseContext) => Promise<HookVerdict>;
  afterToolUse?: (context: AfterToolUseContext) => Promise<GateVerdict>;
  preFinalize?: (context: PreFinalizeContext) => Promise<GateVerdict>;
  preDelegateTask?: (context: PreDelegateTaskContext) => Promise<GateVerdict>;

  onRunStart?: (context: RunStartContext) => Promise<void>;
  onRunEnd?: (context: RunEndContext) => Promise<void>;
  onSubagentComplete?: (context: SubagentCompleteContext) => Promise<void>;
  /**
   * Fires immediately before an agent compacts, and may return
   * {@link CompactionContribution}s folded into that pass's summarization
   * prompt.
   *
   * @remarks Returning nothing is legal and is what a purely observing hook
   *   does. A throw is swallowed by the caller: compaction fires because the
   *   context is over budget, so a hook that could prevent it would turn a
   *   recoverable state into a hard failure at the next model call.
   */
  onPreCompact?: (context: PreCompactContext) => Promise<CompactionContribution[] | void>;
  onModelCallError?: (context: ModelCallErrorContext) => Promise<void>;
  onBudgetExhausted?: (context: BudgetExhaustedContext) => Promise<void>;
  onUserSteer?: (context: UserSteerContext) => Promise<void>;
}
