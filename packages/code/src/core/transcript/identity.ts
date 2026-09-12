import type { RunEvent } from "@clarvis/protocol";

/** Stable identity of a mounted row; independent of its content revision or status. */
export type TranscriptRowId = string;
/** Stable identity of one execution fact, including its actor and physical attempt. */
export type TranscriptRecordId = string;
/** Session-scoped Lead or execution-scoped child projection identity. */
export type TranscriptProjectionId = string;

/** A canonical tool span. JSON tuple encoding prevents delimiter and actor collisions. */
function toolRecordSpan(actor: string, callId: string, attempt?: string): string {
  return `tool:${JSON.stringify(attempt === undefined ? [actor, callId] : [actor, callId, attempt])}`;
}

/**
 * Resolves live and durable replay identity before admission to the transcript.
 * Uncorrelated no-ID terminals use their ordinal among durable terminals, never output or time.
 * Announcements bind subsequent phases to the physical attempt, including reused provider IDs.
 */
export class TranscriptEventIdentity {
  readonly #calls = new Map<string, string>();
  readonly #retries = new Map<string, number>();
  #terminalPosition = 0;

  resolve(event: RunEvent): string | undefined {
    const actor =
      "agent" in event && event.agent === "subagent"
        ? `subagent:${event.subagent_id ?? "unknown"}`
        : "lead";
    if (event.type === "model_retry") {
      this.#retries.set(actor, event.attempt);
      for (const key of this.#calls.keys())
        if ((JSON.parse(key) as string[])[0] === actor) this.#calls.delete(key);
      return undefined;
    }
    if (event.type === "tool_call") this.#terminalPosition++;
    if (!("call_id" in event) && event.type !== "tool_call") return undefined;
    if (event.call_id === undefined)
      return toolRecordSpan(actor, `uncorrelated-terminal:${this.#terminalPosition}`);
    const lookup = JSON.stringify([actor, event.call_id]);
    if (event.type === "tool_call_announced") {
      const id = toolRecordSpan(actor, event.call_id, `${event.iteration}:${event.attempt}`);
      this.#calls.set(lookup, id);
      return id;
    }
    const prior = this.#calls.get(lookup);
    if (prior !== undefined) return prior;
    const retry = this.#retries.get(actor);
    const id = toolRecordSpan(
      actor,
      event.call_id,
      retry === undefined ? undefined : `retry:${retry}`,
    );
    this.#calls.set(lookup, id);
    return id;
  }

  /** Reconstruct attempt bindings from durable facts on each reconciliation pass. */
  reset(): void {
    this.#calls.clear();
    this.#retries.clear();
    this.#terminalPosition = 0;
  }
}
