import type { ToolPhase } from "./types.ts";

/** Minimal live lifecycle; argument and result payloads have independent bounded ownership. */
interface ToolLifecycle {
  toolPhase?: ToolPhase;
  inputChars?: number;
  inputStreamChars?: number;
  inputComplete?: true;
}

type ToolTransition =
  | { type: "announce" }
  | { type: "input"; chars: number; streamChars?: number; complete?: true }
  | { type: "start" }
  | { type: "terminal"; phase: "completed" | "failed" | "cancelled" | "interrupted" };

/** Idempotent phase reduction: cumulative counters never regress and terminals never reopen. */
export function reduceToolLifecycle(previous: ToolLifecycle, event: ToolTransition): ToolLifecycle {
  if (
    previous.toolPhase !== undefined &&
    !["composing", "pending", "running"].includes(previous.toolPhase)
  )
    return previous;
  if (event.type === "terminal" || event.type === "start")
    return {
      toolPhase: event.type === "start" ? "running" : event.phase,
      inputChars: undefined,
      inputStreamChars: undefined,
      inputComplete: undefined,
    };
  if (previous.toolPhase === "running") return previous;
  if (event.type === "announce")
    return previous.toolPhase === undefined
      ? { ...previous, toolPhase: "composing", inputChars: previous.inputChars ?? 0 }
      : previous;
  return {
    toolPhase: previous.inputComplete || event.complete ? "pending" : "composing",
    inputChars: Math.max(previous.inputChars ?? 0, event.chars),
    inputStreamChars:
      event.streamChars === undefined
        ? previous.inputStreamChars
        : Math.max(previous.inputStreamChars ?? 0, event.streamChars),
    inputComplete: previous.inputComplete || event.complete,
  };
}
