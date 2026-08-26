import type { ExecutionRecord } from "@clarvis/capability";

/**
 * A minimal completed {@link ExecutionRecord}, overridable field by field.
 *
 * @remarks A contract-only copy of the loop's integration fixture: a package the
 * loop depends on cannot import the loop's test helpers, and the store only ever
 * reads a record's shape.
 */
export function makeExecutionRecord(
  over: Partial<ExecutionRecord> & { id: string; owner_key_name: string },
): ExecutionRecord {
  return {
    status: "completed",
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_000_500,
    elapsed_ms: 500,
    request: {
      messages: [{ role: "user", content: "x" }],
      servers: [],
      entry: "solo",
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 1 }],
      providers: [{ name: "anthropic", kind: "anthropic" }],
      budget: { on_exceed: "stop", total_token_limit: 1 },
    },
    response: {
      status: "completed",
      result: "r",
      usage: { iterations_used: 1, elapsed_ms: 500, by_agent: [] },
    },
    trace: { events: [] },
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cached_tokens: 0,
    total_cache_write_tokens: 0,
    ...over,
  };
}
