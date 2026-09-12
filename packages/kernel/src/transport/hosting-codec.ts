import type {
  ElicitationRequest,
  HostedRunAttachment,
  HostedRunFrame,
  RunResult,
} from "@clarvis/protocol";
import { decodeRunEvent } from "./run-event-codec.ts";

/** Wire projection of an attachment; executable handles remain on their respective processes. */
export interface HostedAttachmentReply extends Omit<HostedRunAttachment, "handle"> {
  subscription_id: string;
}

/** All observation channels share the connection's bounded ordered notification writer. */
export type HostedObservationNote = { subscription_id: string } & (
  | { kind: "event"; frame: HostedRunFrame }
  | { kind: "elicitation"; request: ElicitationRequest }
  | { kind: "settled"; elicitation_id: string }
  | { kind: "result"; result: RunResult }
  | { kind: "end" | "closed" }
  | { kind: "error"; message: string }
);

/** Closed wire envelopes are validated before a field reaches a subscriber or control handler. */
export function wireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Control identities are bounded scalars, never endpoint paths or serialized authorities. */
export function wireId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/\s/u.test(value) &&
    [...value].every((character) => character.charCodeAt(0) > 32)
  );
}

function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Reuse the canonical event codec for both immutable snapshot items and live tail frames. */
export function decodeHostedFrame(value: unknown): HostedRunFrame | null {
  if (!wireRecord(value) || !only(value, ["first_sequence", "last_sequence", "event"])) return null;
  const event = decodeRunEvent(value.event);
  return natural(value.first_sequence) &&
    value.first_sequence > 0 &&
    natural(value.last_sequence) &&
    value.last_sequence >= value.first_sequence &&
    event !== null
    ? { first_sequence: value.first_sequence, last_sequence: value.last_sequence, event }
    : null;
}

/** Guard prompts must preserve the exact structured command shown to the operator. */
function validHostedQuestion(value: unknown): value is ElicitationRequest {
  if (
    !wireRecord(value) ||
    !wireId(value.id) ||
    !wireId(value.execution_id) ||
    typeof value.kind !== "string" ||
    typeof value.prompt !== "string"
  )
    return false;
  const detail = value.detail;
  if (detail === undefined) return value.kind !== "guard_confirm";
  return elicitationCommandDetailSchema.safeParse(detail).success;
}

/** Reject malformed notification discriminants before allocating per-observation history. */
export function decodeHostedNote(value: unknown): HostedObservationNote | null {
  if (!wireRecord(value) || !wireId(value.subscription_id)) return null;
  const base = ["subscription_id", "kind"];
  switch (value.kind) {
    case "event": {
      const frame = decodeHostedFrame(value.frame);
      return only(value, [...base, "frame"]) && frame !== null
        ? { subscription_id: value.subscription_id, kind: "event", frame }
        : null;
    }
    case "elicitation":
      if (!only(value, [...base, "request"]) || !validHostedQuestion(value.request)) return null;
      break;
    case "settled":
      if (!only(value, [...base, "elicitation_id"]) || !wireId(value.elicitation_id)) return null;
      break;
    case "result":
      if (
        !only(value, [...base, "result"]) ||
        !wireRecord(value.result) ||
        !wireId(value.result.execution_id) ||
        !["completed", "failed", "cancelled"].includes(String(value.result.status))
      )
        return null;
      break;
    case "end":
    case "closed":
      if (!only(value, base)) return null;
      break;
    case "error":
      if (!only(value, [...base, "message"]) || typeof value.message !== "string") return null;
      break;
    default:
      return null;
  }
  return value as unknown as HostedObservationNote;
}

/** Bind an attachment to the requested generation and execution before accepting early notifications. */
export function validHostedAttachment(
  value: unknown,
  expected: {
    subscriptionId: string;
    generation: string;
    workspaceId: string;
    executionId: string;
  },
): value is HostedAttachmentReply {
  if (
    !wireRecord(value) ||
    !only(value, [
      "subscription_id",
      "run",
      "observation_id",
      "snapshot",
      "pending_elicitations",
    ]) ||
    value.subscription_id !== expected.subscriptionId ||
    !wireId(value.observation_id) ||
    !wireRecord(value.run) ||
    !wireRecord(value.snapshot) ||
    !wireRecord(value.snapshot.cursor)
  )
    return false;
  const { run, snapshot } = value;
  const cursor = snapshot.cursor as Record<string, unknown>;
  return (
    run.execution_id === expected.executionId &&
    run.host_generation === expected.generation &&
    run.workspace_id === expected.workspaceId &&
    wireId(run.session_id) &&
    typeof run.title === "string" &&
    natural(run.revision) &&
    natural(run.control_epoch) &&
    natural(run.created_at) &&
    natural(run.updated_at) &&
    ["cancel", "continue"].includes(String(run.disconnect_policy)) &&
    ["starting", "running", "finishing", "closed", "unknown"].includes(
      String(run.execution_state),
    ) &&
    ["none", "waiting_user"].includes(String(run.attention)) &&
    ["available", "self", "other"].includes(String(run.control)) &&
    wireRecord(run.config) &&
    typeof run.config.agent === "string" &&
    wireId(snapshot.snapshot_id) &&
    natural(snapshot.bytes) &&
    snapshot.bytes <= 64 * 1024 * 1024 &&
    natural(cursor.sequence) &&
    cursor.host_generation === expected.generation &&
    cursor.execution_id === expected.executionId &&
    Array.isArray(value.pending_elicitations) &&
    value.pending_elicitations.length <= 64 &&
    value.pending_elicitations.every(
      (item) => validHostedQuestion(item) && item.execution_id === expected.executionId,
    )
  );
}
import { elicitationCommandDetailSchema } from "../guard/review-detail-schema.ts";
