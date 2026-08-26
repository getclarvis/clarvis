/** Pure data fixtures shared by memory tests. */
import type { ExecutionRecord } from "@clarvis/capability";

import type { RunSnapshot, ToolCallEvent } from "../../src/types.ts";

let clock = 1_700_000_000_000;
function tick(): number {
  return (clock += 1000);
}

export function toolCall(partial: Partial<ToolCallEvent> = {}): ToolCallEvent {
  const started = tick();
  return {
    tool_name: "bash",
    arguments: { command: "bun test" },
    result_excerpt: "ok",
    error: null,
    started_at: started,
    ended_at: started + 100,
    ...partial,
  };
}

export function run(partial: Partial<RunSnapshot> = {}): RunSnapshot {
  const started = tick();
  return {
    run_id: `run_${started}`,
    workspace: "/ws",
    status: "completed",
    started_at: started,
    ended_at: started + 5000,
    task: "Fix the build",
    tool_calls: [toolCall()],
    ...partial,
  };
}
/** A minimal completed {@link ExecutionRecord}, enough for the ingest paths. */
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
  } as ExecutionRecord;
}
/** Markdown with the frontmatter every document needs. */
export function doc(description: string, body: string): string {
  return `---\ndescription: ${description}\n---\n\n${body}\n`;
}
