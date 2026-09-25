import type {
  ExecutionStatus,
  PerAgentUsage,
  RunResponse,
  StoredExecution,
  StoredSummary,
  Usage,
} from "@clarvis/loop";
import type {
  PerAgentUsage as ProtoPerAgentUsage,
  ProviderFailureKind,
  RunDetail,
  RunEvent,
  RunResult,
  RunFinalization,
  RunStatus,
  RunSummary,
  RunUsage,
} from "@clarvis/protocol";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import { engineMessagesToProto } from "./map-message.ts";
import { engineEventToProto } from "./map-events.ts";
import { RUN_EVENT_POLICY } from "./event-policy.ts";
import { planRefFromCapabilityState } from "./plan-ref.ts";
import type { KernelException } from "../core/errors.ts";

/** Validate the Extension Profile identity carried in opaque host metadata. */
function extensionProfileFromHostMetadata(
  metadata: Record<string, unknown> | undefined,
): RunDetail["extension_profile"] {
  const value = metadata?.extension_profile;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const extensionProfile = value as Record<string, unknown>;
  if (
    typeof extensionProfile.id !== "string" ||
    !/^(?:builtin|global|workspace):(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/.test(extensionProfile.id) ||
    typeof extensionProfile.fingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(extensionProfile.fingerprint)
  ) {
    return undefined;
  }
  return { id: extensionProfile.id, fingerprint: extensionProfile.fingerprint };
}

/** Maps a stored {@link ExecutionStatus} onto a protocol {@link RunStatus}; any
 * status other than `completed`/`cancelled` collapses to `failed`. */
function execStatusToRun(status: ExecutionStatus): RunStatus {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

/** Projects one agent's engine usage onto the protocol shape, renaming `type` to
 * `role` and including `iterations` only when the engine recorded it. */
function mapPerAgent(a: PerAgentUsage): ProtoPerAgentUsage {
  return {
    role: a.type,
    model: a.model,
    input_tokens: a.input_tokens,
    output_tokens: a.output_tokens,
    cached_tokens: a.cached_tokens,
    cache_write_tokens: a.cache_write_tokens,
    ...(a.iterations !== undefined ? { iterations: a.iterations } : {}),
  };
}

/** Projects the engine's run-level {@link Usage} onto protocol {@link RunUsage}
 * (iterations, elapsed, per-agent breakdown, and warnings when present). Token
 * totals are filled separately from a stored execution in {@link storedToDetail}. */
function liveUsage(usage: Usage): RunUsage {
  return {
    iterations: usage.iterations_used,
    elapsed_ms: usage.elapsed_ms,
    by_agent: usage.by_agent.map(mapPerAgent),
    ...(usage.warnings !== undefined ? { warnings: usage.warnings } : {}),
  };
}

/** The provider classifications this projection keeps; anything else is dropped. */
const PROVIDER_FAILURE_KINDS: ReadonlySet<string> = new Set<ProviderFailureKind>([
  "transient",
  "context_overflow",
  "client",
  "auth",
  "quota",
  "content_policy",
]);

/**
 * Project the engine's bounded provider classification onto the wire error, if any.
 *
 * @param details - the engine error's opaque details, or nothing.
 * @returns the classification and the provider-requested backoff, each only when it
 *   is a value this vocabulary admits.
 * @remarks `provider_error` is what every provider kind reports unless it earns its
 *   own code, so a consumer that has to distinguish a retryable fault from a
 *   credential or request fault cannot read it out of the code. Only the two bounded
 *   fields cross; the rest of the engine's detail object stays host-private.
 */
function providerFailureFields(details: unknown): {
  kind?: ProviderFailureKind;
  retry_after_ms?: number;
} {
  if (typeof details !== "object" || details === null) return {};
  const record = details as Record<string, unknown>;
  const kind =
    typeof record.kind === "string" && PROVIDER_FAILURE_KINDS.has(record.kind)
      ? (record.kind as ProviderFailureKind)
      : undefined;
  const retry = record.retry_after_ms;
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(typeof retry === "number" && Number.isFinite(retry) && retry >= 0
      ? { retry_after_ms: Math.floor(retry) }
      : {}),
  };
}

/**
 * Maps a live engine {@link RunResponse} to a protocol {@link RunResult} for `executionId`.
 *
 * @param executionId - the run whose result this is.
 * @param response - the engine outcome (success, cancellation, or error).
 * @returns a {@link RunResult}: an `error` result (with a defensively coerced
 *   `code`/`message`) when the engine reports `error`, otherwise a status result
 *   carrying `result` and, for a non-`completed` outcome, the `ended_reason`.
 */
export function engineResultToProto(executionId: string, response: RunResponse): RunResult {
  const usage = liveUsage(response.usage);
  const finalization: RunFinalization =
    response.disposition === "checkpoint"
      ? {
          disposition: "checkpoint" as const,
          checkpoint: {
            summary: response.checkpoint.summary,
            next_step: response.checkpoint.next_step,
          },
        }
      : {};
  if (response.status === "error") {
    const e = response.error as { code?: unknown; message?: unknown; details?: unknown };
    return {
      execution_id: executionId,
      status: "failed",
      ...finalization,
      error: {
        code: typeof e.code === "string" ? e.code : "error",
        message: typeof e.message === "string" ? e.message : "run failed",
        ...providerFailureFields(e.details),
      },
      usage,
    };
  }
  const status: RunStatus =
    response.status === "completed"
      ? "completed"
      : response.status === "cancelled"
        ? "cancelled"
        : "failed";
  return {
    execution_id: executionId,
    status,
    ...finalization,
    result: response.result,
    ...(response.status !== "completed" ? { ended_reason: response.status } : {}),
    usage,
  };
}

/** Builds a failed {@link RunResult} from a {@link KernelException} with empty usage. */
export function failedResult(executionId: string, err: KernelException): RunResult {
  return {
    execution_id: executionId,
    status: "failed",
    error: { code: err.code, message: err.message },
    usage: { iterations: 0, elapsed_ms: 0 },
  };
}

/** Maps a stored run summary row to the protocol list item shape. */
export function summaryToProto(s: StoredSummary): RunSummary {
  return {
    execution_id: s.id,
    owner: s.owner,
    status: execStatusToRun(s.status),
    created_at: s.started_at,
    ended_at: s.started_at + s.elapsed_ms,
  };
}

/**
 * Hydrates a full protocol {@link RunDetail} from a stored execution (messages, events, usage totals).
 *
 * @param s - the persisted execution row.
 * @returns the detail with the request messages projected to the wire, the
 *   persisted trace mapped through {@link engineEventToProto} (events with no
 *   wire projection dropped), and usage whose token totals come from the stored
 *   row while the rest is derived by {@link engineResultToProto} / {@link liveUsage}.
 * @remarks `continue_from` and `plan_ref` are included only when the stored row
 *   carries them; `plan_ref` is read out of the opaque `capability_state` via
 *   {@link planRefFromCapabilityState}, since the engine and the trace store
 *   have no typed notion of a plan — only the kernel and the protocol do.
 *
 *   `recovery` is forwarded verbatim when the stored row carries it: it is the
 *   record half of the observability crossing rule, and a client that never sees
 *   it would render a partially recovered run as an ordinary interrupted one.
 */
export function storedToDetail(s: StoredExecution, logger: Logger = NOOP_LOGGER): RunDetail {
  const result = engineResultToProto(s.id, s.response);
  const baseUsage = result.usage ?? liveUsage(s.response.usage);
  result.usage = {
    ...baseUsage,
    input_tokens: s.total_input_tokens,
    output_tokens: s.total_output_tokens,
    cached_tokens: s.total_cached_tokens,
  };
  const planRef = planRefFromCapabilityState(s.capability_state);
  const extensionProfile = extensionProfileFromHostMetadata(s.host_metadata);
  return {
    execution_id: s.id,
    status: execStatusToRun(s.status),
    created_at: s.started_at,
    ended_at: s.ended_at,
    ...(s.request.continue_from !== undefined ? { continue_from: s.request.continue_from } : {}),
    ...(planRef !== undefined ? { plan_ref: planRef } : {}),
    ...(extensionProfile !== undefined ? { extension_profile: extensionProfile } : {}),
    ...(s.recovery !== undefined ? { recovery: s.recovery } : {}),
    messages: engineMessagesToProto(s.request.messages),
    events: rehydrateEvents(s, logger),
    result,
  };
}

/**
 * Project a stored trace to the wire, reporting how much of it survived.
 *
 * @param s - the persisted execution row.
 * @param logger - the runs component's logger.
 * @returns every event that has a protocol projection, in order.
 * @remarks The aggregate half of the §4 rule whose per-artifact half is
 *   `runs.event.unmapped`: an operator sees that a restored session is missing
 *   lines without having to read which, and raises `CLARVIS_LOG=runs=debug` to
 *   get the kinds.
 */
function rehydrateEvents(s: StoredExecution, logger: Logger): RunEvent[] {
  const mapped = s.trace.events
    .map((event) => engineEventToProto(event, logger))
    .filter(
      (event): event is NonNullable<typeof event> =>
        event !== null && RUN_EVENT_POLICY[event.type].durability === "persisted",
    );
  logger.debug(
    {
      event: "runs.rehydrated",
      execution_id: s.id,
      events_total: s.trace.events.length,
      events_mapped: mapped.length,
      events_dropped: s.trace.events.length - mapped.length,
    },
    "a persisted run was projected for a client; any dropped event is absent from the restored session",
  );
  return mapped;
}
