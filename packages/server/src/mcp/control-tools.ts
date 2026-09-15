import type { Message } from "@clarvis/protocol";
import type { LiveRunTable } from "../host/live-runs.ts";
import { errorResultFrom, toolResult, type ToolResult } from "./results.ts";

/**
 * Handle `clarvis_steer`: deliver a message to a run in flight on this session.
 *
 * @remarks Waits for the live handle's acknowledgement. This is a control
 * acknowledgement, not evidence that the newly requested work is complete.
 */
export async function handleSteerTool(
  args: {
    execution_id: string;
    message: string | { role: "user" | "assistant"; content: unknown };
  },
  runs: LiveRunTable,
): Promise<ToolResult> {
  try {
    const live = runs.require(args.execution_id);
    await live.handle.steer(args.message as string | Message);
    return toolResult({
      execution_id: args.execution_id,
      accepted: true,
      note: "steering acknowledged by the run; requested work is not yet confirmed complete",
    });
  } catch (err) {
    return errorResultFrom(err);
  }
}

/**
 * Handle `clarvis_cancel`: abort a run in flight on this session.
 *
 * @remarks The pending `clarvis_run` call still answers, with the run's partial
 * result and a `cancelled` status — cancelling does not orphan it.
 */
export async function handleCancelTool(
  args: { execution_id: string },
  runs: LiveRunTable,
): Promise<ToolResult> {
  try {
    const live = runs.require(args.execution_id);
    live.cancelledBy ??= "client";
    await live.handle.cancel();
    return toolResult({
      execution_id: args.execution_id,
      accepted: true,
      note: "cancelling; the pending clarvis_run call will return the partial result",
    });
  } catch (err) {
    return errorResultFrom(err);
  }
}

/**
 * Handle `clarvis_respond`: answer a question a run asked.
 *
 * @remarks Only meaningful for a run started with `elicitations: "await"`; any
 * other posture answers its own questions, and this reports `accepted: false`
 * with the reason rather than silently doing nothing.
 */
export function handleRespondTool(
  args: {
    execution_id: string;
    id: string;
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  },
  runs: LiveRunTable,
): ToolResult {
  try {
    const live = runs.require(args.execution_id);
    const outcome = live.elicit.respond({
      id: args.id,
      action: args.action,
      ...(args.content !== undefined ? { content: args.content } : {}),
    });
    return toolResult({
      execution_id: args.execution_id,
      accepted: outcome.accepted,
      ...(outcome.note !== undefined ? { note: outcome.note } : {}),
    });
  } catch (err) {
    return errorResultFrom(err);
  }
}
