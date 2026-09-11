import { z } from "zod";

/**
 * The four tools the facade exposes.
 *
 * @remarks Underscored and prefixed, not dotted: these names reach LLM clients
 * whose tool-name grammar is `[a-zA-Z0-9_-]{1,64}`, and a bare `run` would
 * collide in a client's flat namespace.
 */
export const TOOL_NAMES = {
  run: "clarvis_run",
  steer: "clarvis_steer",
  cancel: "clarvis_cancel",
  respond: "clarvis_respond",
} as const;

/** A client-chosen run id: bounded and restricted to characters that are safe in
 * a path segment, since it becomes one in the trace store. */
const EXEC_ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "execution_id may contain only [A-Za-z0-9._:-]");

/** A plain-text content part of a {@link messageSchema}. */
const textPart = z.object({ type: z.literal("text"), text: z.string() });
/** An image content part: inline base64 `data`, or a `ref` the kernel resolves. */
const imagePart = z.object({
  type: z.literal("image"),
  mime: z.string().min(1),
  data: z.string().optional(),
  ref: z.string().optional(),
});

/** One chat message: bare text, or a mixed sequence of text/image parts. */
const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([
    z.string(),
    z
      .array(z.union([textPart, imagePart]))
      .min(1)
      .max(64),
  ]),
});

/**
 * `clarvis_run` arguments.
 *
 * @remarks `guard_mode`/`guard_judge` are deliberately absent: a pass-through
 * would let any caller send `guard_mode: "off"` and disable the container
 * operator's command guard. The guard is now on unless the operator's
 * `settings.json` says otherwise, so this omission is the whole protection
 * rather than a formality over an already-open door.
 * Cache keys and their `session_id`/`agent_instance_id` components are host-owned.
 * Accepting arbitrary affinity would allow callers to reuse another conversation
 * identity in a shared kernel. Continuation resolves its persisted identities.
 */
export const runInputShape = {
  prompt: z.string().min(1).max(1_000_000).optional(),
  messages: z.array(messageSchema).min(1).max(200).optional(),
  agent: z.string().min(1).max(128).optional(),
  execution_id: EXEC_ID.optional().describe(
    "Stable id for this execution; duplicate ids are refused, not replayed.",
  ),
  continue_from: EXEC_ID.optional().describe(
    "Prior execution to continue; this starts a new execution, not a retry of that id.",
  ),
  memory: z.enum(["on", "off"]).optional(),
  plans: z.enum(["off", "on", "review"]).optional(),
  skill: z
    .object({ name: z.string().min(1).max(128), task: z.string().max(64_000).optional() })
    .optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  elicitations: z.enum(["auto_decline", "await"]).default("auto_decline"),
  elicitation_wait_ms: z.number().int().min(1_000).max(600_000).optional(),
} as const;

/** The posture block echoed back so a caller sees the constraints it ran under. */
const postureShape = z.object({
  elicitation: z.enum(["relay", "tool", "auto_decline"]),
  guard_confirmations: z.enum(["relayed", "denied"]),
  plans_effective: z.enum(["off", "on", "review"]).optional(),
  downgrades: z.array(z.string()),
  auto_answered: z.number().int().nonnegative(),
});

/** Live-stream fidelity for the run, so a caller can tell coalescing from loss. */
const streamShape = z.object({
  events_sent: z.number().int().nonnegative(),
  deltas_coalesced: z.number().int().nonnegative(),
  events_dropped: z.number().int().nonnegative(),
  wedged: z.boolean(),
});

/**
 * `clarvis_run` result.
 *
 * @remarks `usage` is loose because a run's per-agent breakdown is an open shape;
 * a strict schema would fail the SDK's output validation and turn a *successful*
 * run into a JSON-RPC error.
 */
export const runOutputShape = {
  execution_id: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  result: z.unknown().optional(),
  ended_reason: z.string().optional(),
  usage: z.looseObject({}).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  posture: postureShape,
  stream: streamShape,
} as const;

/** `clarvis_steer` arguments. */
export const steerInputShape = {
  execution_id: EXEC_ID,
  message: z.union([z.string().min(1).max(64_000), messageSchema]),
} as const;

/** `clarvis_cancel` arguments. */
export const cancelInputShape = { execution_id: EXEC_ID } as const;

/** `clarvis_respond` arguments. */
export const respondInputShape = {
  execution_id: EXEC_ID,
  id: z.string().min(1).max(256),
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
} as const;

/**
 * Acknowledgement shape for the control tools.
 *
 * @remarks For `steer`/`cancel`, `accepted` means the live handle acknowledged
 * the control request, not that the requested work completed. `respond` means
 * the facade accepted the answer against its pending-elicitation map.
 */
export const ackOutputShape = {
  execution_id: z.string(),
  accepted: z.boolean(),
  note: z.string().optional(),
} as const;

/** Descriptions the model reads when choosing a tool. */
export const TOOL_DESCRIPTIONS = {
  run:
    "Start a run and block until it finishes, streaming progress. Supply exactly one of prompt " +
    "or messages. Use a stable execution_id to prevent duplicate starts. Control the pending run " +
    "with clarvis_steer/cancel/respond on the same session. The client transport needs a suitable " +
    "timeout or progressToken plus resetTimeoutOnProgress; these are not tool arguments.",
  steer:
    "Deliver a message to a live run on this session and await its steering acknowledgement. " +
    "Acknowledgement does not mean the requested work is complete.",
  cancel: "Cancel a run in flight on this session. Its partial result is still returned.",
  respond:
    "Answer a pending question by its exact id and requested content schema. Requires tool " +
    'elicitation posture (requested with elicitations:"await"); other postures relay through ' +
    "native MCP elicitation or auto-decline. An accepted answer does not complete the run.",
} as const;
