import type { TraceEvent } from "@clarvis/capability";

import { makeExecutionRecord } from "./execution-record.ts";

export const JOURNAL_OWNER = "owner-a";
export const JOURNAL_STARTED_AT = 1_700_000_000_000;

const request = makeExecutionRecord({ id: "fixture", owner_key_name: JOURNAL_OWNER }).request;

export function journalHeader(id: string, startedAt = JOURNAL_STARTED_AT) {
  return { id, owner_key_name: JOURNAL_OWNER, started_at: startedAt, request };
}

export function leadIteration(iteration: number, input: number, output: number): TraceEvent {
  return {
    type: "lead_iteration",
    iteration,
    started_at: JOURNAL_STARTED_AT + iteration * 10,
    ended_at: JOURNAL_STARTED_AT + iteration * 10 + 5,
    model: "anthropic/x",
    input_tokens: input,
    output_tokens: output,
    cached_tokens: 0,
    cache_write_tokens: 0,
    cache_read_ratio: 0,
    response: "ok",
  };
}

export function subagentIteration(
  instance: string,
  iteration: number,
  input: number,
  output: number,
  model = "anthropic/small",
): TraceEvent {
  return {
    type: "subagent_iteration",
    subagent_instance_id: instance,
    iteration,
    started_at: JOURNAL_STARTED_AT + iteration * 10,
    ended_at: JOURNAL_STARTED_AT + iteration * 10 + 5,
    model,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: 1,
    cache_write_tokens: 2,
    cache_read_ratio: 0,
    response: "ok",
  };
}
