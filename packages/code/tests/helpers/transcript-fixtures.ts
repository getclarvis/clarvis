import type { TranscriptNode } from "../../src/adapters/store.ts";
import type { RunEvent } from "@clarvis/protocol";

/** Synthetic, public-data-only tool lifecycle shared by renderer and replay tests. */
export function transcriptToolEvents(
  callId: string,
  tool = "read_file",
  actor?: string,
): RunEvent[] {
  const attribution =
    actor === undefined
      ? { agent: "lead" as const }
      : { agent: "subagent" as const, subagent_id: actor };
  return [
    { type: "tool_input_delta", at: 1, ...attribution, call_id: callId, tool, chars: 0 },
    { type: "tool_input_delta", at: 2, ...attribution, call_id: callId, tool, chars: 100_000 },
    {
      type: "tool_input_delta",
      at: 3,
      ...attribution,
      call_id: callId,
      tool,
      chars: 100_000,
      complete: true,
    },
    {
      type: "tool_call_started",
      at: 4,
      ...attribution,
      call_id: callId,
      tool,
      server: "builtin",
      arguments: { path: `fixture/${callId}.ts` },
    },
    {
      type: "tool_output_delta",
      at: 5,
      ...attribution,
      call_id: callId,
      chunk: "INCREMENTAL_ONLY\n",
    },
    {
      type: "tool_call",
      at: 6,
      ...attribution,
      call_id: callId,
      tool,
      server: "builtin",
      arguments: { path: `fixture/${callId}.ts` },
      ok: true,
      result: "AUTHORITATIVE_RESULT",
    },
  ];
}

/** Completion order deliberately differs from first admission, without timers. */
export function transcriptExplorationEvents(count = 500): RunEvent[] {
  const calls = Array.from({ length: count }, (_, index) =>
    transcriptToolEvents(`read-${index}`, index % 2 === 0 ? "read_file" : "grep"),
  );
  return [
    ...calls.flatMap((call) => call.slice(0, -1)),
    ...calls.toReversed().map((call) => call.at(-1)!),
  ];
}

/** Test-owned fold defaults are passed explicitly to presenters, never stored on production records. */
export type FoldFixtureNode = TranscriptNode & { collapsed?: boolean };
export type FoldFixtureToolNode = Extract<TranscriptNode, { kind: "tool_call" }> & {
  collapsed?: boolean;
};
