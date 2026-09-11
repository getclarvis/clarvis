import type { Logger } from "@clarvis/capability";
import type { ErrorCode, ExecutionMode, ResolvedConfig, RunResponse } from "@clarvis/capability";
import type { RunEndedDetail, RunStartedDetail, TraceEntry } from "@clarvis/capability";
import type { TraceEvent } from "@clarvis/capability";
import type { Capability, PersistedTraceProjectorRegistry } from "@clarvis/capability";
import { composePersistedTraceProjectors } from "@clarvis/capability";
import { mapEntry } from "@clarvis/trace";
import { sanitizeErrorMessage } from "@clarvis/capability";
import type { ClockHolder } from "@clarvis/capability";
import type { RunShape } from "./run-shape.ts";

/**
 * The detail recorded on the run's `init` trace entry: the resolved config, the
 * model provider name, and the {@link ExecutionMode}.
 */
export interface InitDetail {
  config: ResolvedConfig;
  modelProvider: string;
  mode: ExecutionMode;
}

/**
 * The {@link ErrorCode}s that {@link deriveRunEndedDetail} classifies as a
 * convergence/guard trip (`reason: "guard_trip"`) rather than a plain error.
 */
const GUARD_TRIP_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "no_progress",
  "tool_failure_loop",
  "stagnation_detected",
  "agents_unfinished",
  "background_children_failing",
  "all_tools_unavailable",
  "empty_response",
]);

/** Compose the immutable host/run projector snapshot used by every trace sink. */
export function createRunTraceProjectors(
  capabilities: readonly Capability[],
  host?: PersistedTraceProjectorRegistry,
): PersistedTraceProjectorRegistry {
  return composePersistedTraceProjectors(
    host,
    capabilities.flatMap((capability) => capability.persistedTraceProjectors ?? []),
  );
}

/**
 * Bundle the run's resolved config, model provider, and mode into an
 * {@link InitDetail} for the `init` trace entry.
 */
export function deriveInitDetail(
  config: ResolvedConfig,
  modelProvider: string,
  mode: ExecutionMode,
): InitDetail {
  return { config, modelProvider, mode };
}

/**
 * Derive the `run_started` trace detail from the run shape and config.
 *
 * @param shape - the run shape; a lead run adds `lead_model` from the entry
 *   profile.
 * @param config - the resolved config; a finite `max_tokens` cap is included, a
 *   non-finite (unbounded) one omitted.
 * @param mode - the execution mode.
 * @returns the started detail, always naming the `subagent_model`.
 */
export function deriveRunStartedDetail(
  shape: RunShape,
  config: ResolvedConfig,
  mode: ExecutionMode,
): RunStartedDetail {
  return {
    mode,
    ...(shape.isLead ? { lead_model: shape.entryProfile.model } : {}),
    subagent_model: shape.primarySubagentModel,
    ...(Number.isFinite(config.max_tokens) ? { max_tokens: config.max_tokens } : {}),
  };
}

/**
 * Classify a finished {@link RunResponse} into a `run_ended` trace detail.
 *
 * @param response - the run's outcome.
 * @returns a detail whose `reason` is the non-error status verbatim; for an
 *   error response, `"timeout"`, `"guard_trip"` (when the code is in
 *   {@link GUARD_TRIP_CODES}), or `"error"` otherwise, each carrying the
 *   originating error `code`.
 * @remarks Only a completed run carries its accepted finalization disposition;
 *   cancellation, budget termination and failures never advertise a saved checkpoint.
 */
export function deriveRunEndedDetail(
  response: RunResponse,
  capabilityGuardTripCodes?: ReadonlySet<string>,
): RunEndedDetail {
  if (response.status !== "error") {
    return {
      reason: response.status,
      ...(response.status === "completed" && response.disposition !== undefined
        ? { disposition: response.disposition }
        : {}),
    };
  }
  const code = response.error.code;
  if (code === "timeout") return { reason: "timeout", code };
  if (GUARD_TRIP_CODES.has(code) || capabilityGuardTripCodes?.has(code) === true)
    return { reason: "guard_trip", code };
  return { reason: "error", code };
}

/**
 * Build the sink that every {@link TraceEntry} the run records flows through: it
 * pokes the compute clock (proving liveness against the stall timeout) and, when
 * an `emitEvent` callback is wired, maps the entry to a wire {@link TraceEvent}
 * and forwards it.
 *
 * @param p.clockHolder - holds the live {@link ComputeClock} poked on every
 *   entry.
 * @param p.wallStartedAt - the wall-clock origin used to stamp emitted events.
 * @param p.emitEvent - optional consumer of mapped events; when absent, the
 *   bridge only pokes the clock.
 * @param p.ingest - optional second consumer, taking the raw entry. The agent
 *   registry taps this to route a sub-agent's activity to its own buffer.
 * @param p.journal - optional durable sink, taking the mapped event. Only
 *   entries recorded through {@link TraceHandle.record} reach it; live-only
 *   signals do not.
 * @param p.logger - optional logger; a throwing `emitEvent` is caught, logged,
 *   and the event dropped rather than propagated.
 * @returns the per-entry sink to hand to the tracer.
 * @remarks Entries that {@link mapEntry} maps to `null` (not wire-visible) are
 *   silently skipped after the clock poke. `ingest` runs *before* the
 *   `emitEvent` guard on purpose: a run with no host event consumer — which is
 *   every loop integration test — must still feed the registry, and it takes
 *   the unmapped entry because `mapEntry` sanitizes every entry deeply and the
 *   registry has no use for a second pass of that.
 *
 *   `mapEntry` is called at most once per entry and its result shared by
 *   `journal` and `emitEvent`, so adding a journal costs no extra
 *   sanitize/truncate pass. The guard below therefore tests **both** sinks: a
 *   headless run has no `emitEvent` but may well have a journal, and returning
 *   early on `emitEvent` alone would leave exactly those runs — the ones with
 *   no UI watching them — with nothing on disk.
 */
export function traceBridge(p: {
  clockHolder: ClockHolder;
  wallStartedAt: number;
  emitEvent?: (event: TraceEvent) => void;
  ingest?: (entry: TraceEntry) => void;
  journal?: (event: TraceEvent) => void;
  logger?: Logger;
  projectors?: PersistedTraceProjectorRegistry;
}): (entry: TraceEntry, durable: boolean) => void {
  return (entry, durable) => {
    p.clockHolder.clock?.poke();
    if (p.ingest !== undefined) {
      try {
        p.ingest(entry);
      } catch (err) {
        p.logger?.warn(
          {
            event: "trace.ingest_failed",
            err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          },
          "agents registry ingest threw; entry dropped",
        );
      }
    }
    const journal = durable ? p.journal : undefined;
    if (p.emitEvent === undefined && journal === undefined) return;
    const event = mapEntry(entry, p.wallStartedAt, p.projectors);
    if (event === null) return;
    journal?.(event);
    if (p.emitEvent === undefined) return;
    try {
      p.emitEvent(event);
    } catch (err) {
      p.logger?.warn(
        {
          event: "trace.emit_failed",
          err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
        },
        "onEvent callback threw; event dropped",
      );
    }
  };
}
