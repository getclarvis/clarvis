import type { AgentRole, TracePort } from "@clarvis/capability";

/**
 * Extract a human-readable cancellation reason from an abort signal.
 *
 * @param signal - the signal to inspect; may be undefined.
 * @returns the reason as a string, or `undefined` when the signal is absent or
 *   not aborted. A `reason` object carrying a string `source` field yields that
 *   source; a plain non-empty string reason is returned verbatim; any other
 *   aborted state falls back to the literal `"cancelled"`.
 */
export function cancellationReason(signal?: AbortSignal): string | undefined {
  if (!signal?.aborted) return undefined;
  const r: unknown = signal.reason;
  if (r && typeof r === "object" && "source" in r) {
    const source = (r as { source?: unknown }).source;
    if (typeof source === "string") return source;
  }
  if (typeof r === "string" && r.length > 0) return r;
  return "cancelled";
}

/**
 * Emit a `cancellation` trace event for an aborted agent, tagging it with the
 * agent role, optional subagent instance, and the resolved reason.
 *
 * @param args.trace - the trace to record onto.
 * @param args.agent - which agent ({@link AgentRole}) was cancelled.
 * @param args.subagentInstanceId - the subagent instance, omitted for the lead.
 * @param args.signal - the aborted signal, read for its reason via
 *   {@link cancellationReason}.
 */
export function recordCancellation(args: {
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  signal: AbortSignal;
}): void {
  const { trace, agent, subagentInstanceId, signal } = args;
  const reason = cancellationReason(signal);
  trace.record("cancellation", {
    agent,
    ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
    ...(reason ? { reason } : {}),
  });
}

/**
 * Test whether an agent has been cancelled and, if so, record the event as a
 * side effect.
 *
 * @param args.signal - the signal to check; a missing or un-aborted signal is
 *   never a cancellation.
 * @param args.trace - the trace onto which a cancellation is recorded.
 * @param args.agent - which agent ({@link AgentRole}) is being checked.
 * @param args.subagentInstanceId - the subagent instance, omitted for the lead.
 * @returns `true` when the signal is aborted (having recorded the cancellation
 *   via {@link recordCancellation}), `false` otherwise.
 */
export function checkCancelled(args: {
  signal?: AbortSignal;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
}): boolean {
  if (!args.signal?.aborted) return false;
  recordCancellation({
    trace: args.trace,
    agent: args.agent,
    ...(args.subagentInstanceId !== undefined
      ? { subagentInstanceId: args.subagentInstanceId }
      : {}),
    signal: args.signal,
  });
  return true;
}
