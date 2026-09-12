import type { OperatorAuthorityState } from "@clarvis/capability";
import type { RunRequest } from "@clarvis/capability";
import type { ContextSnapshotEntry, RunResponse } from "@clarvis/capability";
import type { ExecutionRecord, Trace } from "@clarvis/capability";

/** The inputs {@link buildRecord} folds into a persistable {@link ExecutionRecord}. */
export interface BuildRecordInput {
  /** Final host-owned authority state, separate from capability slots and transcript. */
  operatorAuthorityState?: OperatorAuthorityState;
  /** The execution id this record is keyed by. */
  id: string;
  /** The owner key name the record is filed under. */
  owner: string;
  /** The originating run request. */
  request: RunRequest;
  /** The completed run response, including per-agent usage and final status. */
  response: RunResponse;
  /** The mapped trace of run events. */
  trace: Trace;
  /** Absolute wall-clock start time (ms) the record's timestamps are anchored to. */
  wallStartedAt: number;
  /** The final context snapshot, when continuation state was captured. */
  finalContext?: ContextSnapshotEntry[];
  /** Durable per-capability state, keyed by capability name, when any. */
  capabilityState?: Record<string, unknown>;
  /** Opaque host snapshot captured at run start. */
  hostMetadata?: Record<string, unknown>;
}

/**
 * Assemble an {@link ExecutionRecord} from a finished run, summing per-agent
 * token usage into the record's roll-up totals.
 *
 * @param input - the run's id, owner, request/response, trace and timing; see
 *   {@link BuildRecordInput}.
 * @returns the record ready to hand to {@link TraceStore.insert}. `ended_at` is
 *   derived as `wallStartedAt + elapsed_ms`; the four `total_*_tokens` fields sum
 *   {@link RunResponse}'s per-agent usage; `final_context` and `capability_state`
 *   are included only when supplied.
 */
export function buildRecord(input: BuildRecordInput): ExecutionRecord {
  const { usage } = input.response;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalCacheWrite = 0;
  for (const agent of usage.by_agent) {
    totalInput += agent.input_tokens;
    totalOutput += agent.output_tokens;
    totalCached += agent.cached_tokens;
    totalCacheWrite += agent.cache_write_tokens;
  }
  const elapsedMs = usage.elapsed_ms;
  return {
    id: input.id,
    owner_key_name: input.owner,
    status: input.response.status,
    started_at: input.wallStartedAt,
    ended_at: input.wallStartedAt + elapsedMs,
    elapsed_ms: elapsedMs,
    request: input.request,
    response: input.response,
    trace: input.trace,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cached_tokens: totalCached,
    total_cache_write_tokens: totalCacheWrite,
    ...(input.finalContext !== undefined ? { final_context: input.finalContext } : {}),
    ...(input.capabilityState !== undefined ? { capability_state: input.capabilityState } : {}),
    ...(input.hostMetadata !== undefined ? { host_metadata: input.hostMetadata } : {}),
    ...(input.operatorAuthorityState === undefined
      ? {}
      : { operator_authority_state: input.operatorAuthorityState }),
  };
}
