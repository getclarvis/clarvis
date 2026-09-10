import type { LiveMessage, ToolTransport } from "./api.ts";
import type { TokenCounts } from "./usage.ts";

/**
 * Why a run ended.
 *
 * @remarks `completed` is a normal finish. `budget_exhausted` /
 * `soft_limit_declined` are budget outcomes (hard stop vs. the model declining
 * to continue at a soft limit). `cancelled` is an external stop, `timeout` a
 * wall-clock cutoff, `guard_trip` a command-guard denial, and `error` any other
 * fault. The kernel collapses everything but `completed`/`cancelled` to a failed
 * status on the wire.
 */
export const BUILTIN_RUN_ENDED_REASONS = [
  "completed",
  "budget_exhausted",
  "cancelled",
  "soft_limit_declined",
  "interrupted",
  "timeout",
  "guard_trip",
  "error",
] as const;

/** A terminating condition the engine itself declares. */
export type BuiltinRunEndedReason = (typeof BUILTIN_RUN_ENDED_REASONS)[number];

/**
 * The run's terminating condition.
 *
 * @remarks Deliberately open, for the same reason {@link TraceKind} is: a
 * capability that terminates a run for its own reason must be able to say so
 * without the engine declaring that reason. Narrow with
 * {@link isBuiltinRunEndedReason} wherever the exact set matters.
 */
export type RunEndedReason = BuiltinRunEndedReason | (string & {});

const BUILTIN_RUN_ENDED_REASON_SET: ReadonlySet<string> = new Set(BUILTIN_RUN_ENDED_REASONS);

/**
 * Report whether a bare string names a terminating condition the engine declares.
 *
 * @param reason - the reason to test.
 * @returns `true` for a {@link BuiltinRunEndedReason}.
 */
export function isBuiltinRunEndedReason(reason: string): reason is BuiltinRunEndedReason {
  return BUILTIN_RUN_ENDED_REASON_SET.has(reason);
}

/**
 * Shape of a run's agent topology: `subagent-only` runs a single agent as the
 * entry, `lead-subagent` runs a lead that can delegate to sub-agents.
 */
export type ExecutionMode = "subagent-only" | "lead-subagent";

/**
 * Per-agent usage breakdown, discriminated by `type`.
 *
 * @remarks The `lead` variant reports one lead's tallies plus `iterations` and
 * `subagents_spawned`. The `subagent` variant rolls up one sub-agent profile
 * across every instance, so `iterations` and `instances` are the summed counts
 * (both optional). Token fields carry the same meaning as {@link TokenCounts}.
 */
export type PerAgentUsage =
  | {
      type: "lead";
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cache_write_tokens: number;
      iterations: number;
      subagents_spawned: number;
    }
  | {
      type: "subagent";
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cache_write_tokens: number;
      iterations?: number;
      instances?: number;
    }
  /**
   * The vision pre-pass: one completion on a model that is not any agent's.
   *
   * @remarks A third variant rather than a `subagent` row, because it is not one:
   * counting it as a sub-agent inflated the lead's `subagents_spawned` and
   * reported a child no client could address. It carries no `iterations` for the
   * same reason context compaction contributes none — it is a single call, not a
   * loop.
   */
  | {
      type: "vision";
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      cache_write_tokens: number;
    };

/**
 * Whole-run usage summary returned on every {@link RunResponse}.
 *
 * @remarks `iterations_used` and `elapsed_ms` are the run totals; `by_agent`
 * holds the per-agent breakdown ({@link PerAgentUsage}); `warnings` carries any
 * non-fatal notices accumulated during the run.
 */
export interface Usage {
  iterations_used: number;
  elapsed_ms: number;
  by_agent: PerAgentUsage[];
  warnings?: string[];
}

/** Which MCP resource operation a synthesized tool stands in for. */
export type ResourceToolKind = "resource_list" | "resource_read";

/**
 * The outcome of resolving a wire tool name back to a concrete MCP call.
 *
 * @remarks `connection` is the server to invoke, `toolName` the server-local
 * name, `fullName` the namespaced form; `kind` is set only when the tool is a
 * synthesized resource operation. See {@link NamespacedRegistry.resolve}.
 */
export interface Resolved {
  connection: MCPConnection;
  toolName: string;
  fullName: string;
  inputSchema?: Record<string, unknown>;
  kind?: ResourceToolKind;
}

/**
 * A registry of MCP tools exposed under collision-free wire names.
 *
 * @remarks {@link resolve} maps a wire name back to its {@link Resolved} target
 * (or `null` if unknown); {@link allUnavailable} reports whether every backing
 * connection is currently unusable.
 */
export interface NamespacedRegistry {
  tools: NamespacedTool[];
  resolve(name: string): Resolved | null;
  allUnavailable(): boolean;
}

/**
 * Stable machine-readable error code for a failed run or a rejected request,
 * carried on {@link ErrorBody.code}.
 *
 * @remarks Codes fall into families: request-validation (`messages_empty`,
 * `invalid_*`, `duplicate_*`, `unknown_*`), loop-termination faults (`timeout`,
 * `no_progress`, `stagnation_detected`, plan/pending-task gates), MCP failures
 * (`mcp_*`, `all_tools_unavailable`), provider/context faults, execution-id and
 * continuation faults, and `internal_error` as the catch-all.
 */
export const BUILTIN_ERROR_CODES = [
  "messages_empty",
  "invalid_message_format",
  "invalid_model_format",
  "invalid_provider_config",
  "duplicate_provider_name",
  "unknown_provider",
  "invalid_iteration_limit",
  "invalid_token_limit",
  "invalid_timeout",
  "invalid_server_config",
  "duplicate_server_name",
  "invalid_output_schema",
  "elicitation_not_supported",
  "invalid_on_exceed",
  "invalid_budget_mode",
  "invalid_elicit_wait",
  "invalid_max_escalations",
  "duplicate_profile_name",
  "invalid_profile",
  "unknown_profile",
  "timeout",
  "empty_response",
  "no_progress",
  "tool_failure_loop",
  "stagnation_detected",
  "agents_unfinished",
  "background_children_failing",
  "mcp_connection_failed",
  "mcp_unavailable",
  "all_tools_unavailable",
  "provider_error",
  "context_overflow",
  "provider_quota_exhausted",
  "provider_content_policy",
  "execution_id_conflict",
  "invalid_execution_id",
  "invalid_prompt_cache_key",
  "invalid_prompt_cache_ttl",
  "continuation_unavailable",
  "invalid_pagination",
  "persistence_failure",
  "internal_error",
] as const;

/** An error code the engine itself declares. */
export type BuiltinErrorCode = (typeof BUILTIN_ERROR_CODES)[number];

/**
 * Stable machine-readable error code for a failed run or a rejected request.
 *
 * @remarks Deliberately open. A capability fails a run for reasons the engine
 * cannot enumerate — the plan-review and open-task gates are the original
 * example, and they used to be listed here — so a closed union would mean every
 * new capability edits this file. Narrow with {@link isBuiltinErrorCode}
 * wherever the exact set matters.
 */
export type ErrorCode = BuiltinErrorCode | (string & {});

const BUILTIN_ERROR_CODE_SET: ReadonlySet<string> = new Set(BUILTIN_ERROR_CODES);

/**
 * Report whether a bare string names an error code the engine declares.
 *
 * @param code - the code to test.
 * @returns `true` for a {@link BuiltinErrorCode}.
 */
export function isBuiltinErrorCode(code: string): code is BuiltinErrorCode {
  return BUILTIN_ERROR_CODE_SET.has(code);
}

/**
 * Classification of a provider-side failure that drives retry/escalation policy:
 * `transient` is retryable, `context_overflow` needs compaction, `client` is a
 * non-retryable request fault, `auth` is a credential/permission failure,
 * `quota` is an exhausted allowance, and `content_policy` is a refusal on
 * content grounds.
 *
 * @remarks Only `transient` is retried. `quota` and `content_policy` were both
 * folded into `client` until they were split out: retrying a quota failure
 * spends what little allowance remains, retrying a policy refusal reproduces
 * it, and a user resolves them in entirely different ways - top up an account
 * versus rephrase a request - which a UI cannot advise on while both look like
 * a malformed payload.
 */
export type FailureKind =
  "transient" | "context_overflow" | "client" | "auth" | "quota" | "content_policy";

/**
 * Structured detail about a provider error.
 *
 * @remarks `kind` drives handling ({@link FailureKind}); `status` is the HTTP
 * status when the provider gave one; `retry_after_ms` is the provider's
 * requested backoff, honored by the retry logic when present.
 */
export interface ProviderErrorDetails {
  kind: FailureKind;
  status?: number;
  retry_after_ms?: number;
}

/**
 * The error payload on a failed {@link RunResponse}: a stable {@link ErrorCode},
 * a human-readable `message`, and optional structured `details`.
 */
export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** The validated agent result value; its shape is opaque to the loop (the run's `output_schema` governs it, if any). */
export type StructuredResult = unknown;

/** Alias of {@link StructuredResult}: the result value carried on a successful {@link RunResponse}. */
export type ResultValue = StructuredResult;

/**
 * The outcome of a run, discriminated by `status`.
 *
 * @remarks Every non-`error` variant carries the agent `result` and full
 * {@link Usage}; the `error` variant replaces `result` with an {@link ErrorBody}
 * but still reports usage accumulated before the fault.
 *
 * `interrupted` is the one variant no live run produces: it belongs to a record
 * rebuilt from a journal after the process died, where the usage is what the
 * journal proved was spent and `result` is necessarily absent.
 */
export type RunResponse =
  | { status: "completed"; result: ResultValue; usage: Usage }
  | { status: "budget_exhausted"; result: ResultValue; usage: Usage }
  | { status: "cancelled"; result: ResultValue; usage: Usage }
  | { status: "soft_limit_declined"; result: ResultValue; usage: Usage }
  | { status: "interrupted"; result: ResultValue; usage: Usage }
  | { status: "error"; error: ErrorBody; usage: Usage };

/** A {@link RunResponse} stamped with the run's `execution_id` for transport back to a caller. */
export type WireRunResponse = RunResponse & { execution_id: string };

/**
 * The effective run limits after defaults and per-agent overrides are folded in:
 * the concrete token and wall-clock caps the loop enforces.
 *
 * @remarks It carries no iteration cap. There is one — `entryMax` in the
 * orchestrator, and `resolveIterationCap` per sub-agent — but it is resolved
 * from the agent profile, never from this config, which held a
 * `max_iterations` fixed at `Number.POSITIVE_INFINITY` for every run.
 */
export interface ResolvedConfig {
  max_tokens: number;
  timeout_ms: number;
}

/** A mutable running tally the loop advances during a run: iterations plus a {@link TokenCounts} accumulator. */
export interface MutableUsage {
  iterations: number;
  tokens: TokenCounts;
}

/** Liveness of an MCP connection: `connected`, `lost` (was up, now unreachable), or `unavailable` (never connected). */
export type MCPStatus = "connected" | "lost" | "unavailable";

/**
 * The result of one MCP tool/resource call.
 *
 * @remarks On success `ok` is `true` and `data` holds the payload; on failure
 * `ok` is `false` and `error` classifies it (runtime fault, server unavailable,
 * or timeout).
 */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: {
    code: "mcp_runtime_error" | "mcp_unavailable" | "mcp_timeout";
    message: string;
    /** Operational classification for host adapters that must preserve uncertainty. */
    kind?: "cancelled" | "timeout" | "unavailable" | "operational";
    /** A sent request whose effect cannot be proved must never be retried automatically. */
    outcome?: "unknown";
  };
}

/**
 * A live connection to one MCP server.
 *
 * @remarks {@link callTool} invokes a server-local tool. Resource methods are optional at this
 * cross-host boundary; the production MCP client defines both and exposes model-facing descriptors
 * only when discovery succeeds. Remote operations accept an optional {@link AbortSignal}, and
 * {@link close} tears the connection down.
 */
export interface MCPConnection {
  name: string;
  transport: ToolTransport;
  status: MCPStatus;
  /** Bounded server-provided guidance returned by the MCP initialize handshake. */
  instructions?: string;
  callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>;
  listResources?(signal?: AbortSignal): Promise<ToolResult>;
  readResource?(uri: string, signal?: AbortSignal): Promise<ToolResult>;
  close(): Promise<void>;
}

/**
 * One MCP tool as advertised to the model under collision-free names.
 *
 * @remarks `fullName` is the namespaced identity, `wireName` the name the model
 * actually calls, `mcpName`/`toolName` the originating server and its local tool
 * name; `kind` is set only for synthesized resource operations.
 */
export interface NamespacedTool {
  fullName: string;
  wireName: string;
  mcpName: string;
  toolName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  kind?: ResourceToolKind;
}

/**
 * One entry in a persisted context snapshot used to continue a run.
 *
 * @remarks `evictable` marks a message compaction may drop; `summary` marks a
 * compaction-produced summary; `canonical` marks always-retained context (e.g.
 * plan state); `task_id` associates the entry with a plan task when relevant.
 */
export interface ContextSnapshotEntry {
  message: LiveMessage;
  evictable: boolean;
  summary: boolean;
  canonical: boolean;
  task_id?: string;
  /** Active runtime-note kind. Older publications remain historical and become superseded. */
  note_kind?: string;
  /** The position-holding block identity, when the entry is a stable block. */
  block_kind?: string;
  /** Historical publication eligible for deliberate compaction without a recent-tail reservation. */
  superseded?: boolean;
}

/**
 * Everything needed to resume a prior run: its restorable `context` snapshot and
 * the durable state each capability left behind on the prior record.
 *
 * @remarks `capability_state` is keyed by capability name and its values are
 * opaque to the engine — the capability that wrote a slot is the only thing that
 * knows how to read it. It replaced a typed `plan_ref` field, which made one
 * feature's private bookkeeping part of the resume contract that every other
 * feature had to route around.
 */
export interface RunContinuation {
  context: ContextSnapshotEntry[];
  capability_state?: Record<string, unknown>;
}
