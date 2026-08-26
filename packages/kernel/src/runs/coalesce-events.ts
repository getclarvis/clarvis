import type { RunEvent } from "@clarvis/protocol";
import { Buffer } from "node:buffer";
import type { Coalescer } from "../core/event-stream.ts";
import { RUN_EVENT_POLICY } from "./event-policy.ts";

/**
 * Default buffered-event cap for a run's stream, past which the backpressure
 * policy starts discarding droppable events.
 */
export const DEFAULT_RUN_EVENT_BUFFER = 1024;

/** Default retained-byte budget for one run event consumer. */
export const DEFAULT_RUN_EVENT_BUFFER_BYTES = 8 * 1024 * 1024;

/** Serialized byte cost used by local and remote run event buffers. */
export function sizeOfRunEvent(event: RunEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    // A contributed detail that cannot cross the wire must never make a local
    // consumer's buffer unbounded. Treat it as oversized and fail closed.
    return Number.MAX_SAFE_INTEGER;
  }
}

function appendedJsonStringBytes(text: string): number {
  // Strip the two quote bytes. Escaping is additive across concatenated JSON
  // strings; a surrogate pair split between deltas only makes this a safe
  // overestimate, never an underestimate.
  return Math.max(0, Buffer.byteLength(JSON.stringify(text), "utf8") - 2);
}

const COALESCED_TEXT_BLOCK_CHARS = 4 * 1024;
const coalescedText = Symbol("clarvis.coalesced-run-event-text");

interface CoalescedTextState {
  readonly kind: "text" | "tool_output";
  readonly blocks: string[];
  readonly pending: string[];
  pendingChars: number;
  materialized: string | undefined;
  materializations: number;
}

type CoalescedTextEvent = RunEvent & { [coalescedText]?: CoalescedTextState };

function flushPending(state: CoalescedTextState): void {
  if (state.pending.length === 0) return;
  const block = state.pending.length === 1 ? state.pending[0] : state.pending.join("");
  if (block !== undefined) state.blocks.push(block);
  state.pending.length = 0;
  state.pendingChars = 0;
}

function appendText(state: CoalescedTextState, text: string): void {
  if (text.length === 0) return;
  state.materialized = undefined;
  state.pending.push(text);
  state.pendingChars += text.length;
  if (state.pendingChars >= COALESCED_TEXT_BLOCK_CHARS) flushPending(state);
}

function materializeText(state: CoalescedTextState): string {
  if (state.materialized !== undefined) return state.materialized;
  flushPending(state);
  state.materializations += 1;
  const materialized =
    state.blocks.length === 0
      ? ""
      : state.blocks.length === 1
        ? (state.blocks[0] ?? "")
        : state.blocks.join("");
  // Release the smaller source strings after the one required wire value is
  // built. Keeping both would double retained payload until the event dies.
  state.blocks.length = 0;
  if (materialized.length > 0) state.blocks.push(materialized);
  state.materialized = materialized;
  return materialized;
}

function replaceText(state: CoalescedTextState, text: string): void {
  state.blocks.length = 0;
  state.pending.length = 0;
  state.pendingChars = 0;
  if (text.length > 0) state.blocks.push(text);
  state.materialized = text;
}

function chunkedTextDelta(
  previous: Extract<RunEvent, { type: "text_delta" }>,
  incoming: Extract<RunEvent, { type: "text_delta" }>,
): RunEvent {
  const state: CoalescedTextState = {
    kind: "text",
    blocks: [],
    pending: [],
    pendingChars: 0,
    materialized: undefined,
    materializations: 0,
  };
  appendText(state, previous.text);
  appendText(state, incoming.text);
  const event: Extract<RunEvent, { type: "text_delta" }> = {
    ...incoming,
    at: previous.at,
    reset: previous.reset,
  };
  Object.defineProperty(event, "text", {
    configurable: false,
    enumerable: true,
    get: () => materializeText(state),
    set: (text: string) => replaceText(state, text),
  });
  Object.defineProperty(event, coalescedText, { value: state });
  return event;
}

function chunkedToolOutputDelta(
  previous: Extract<RunEvent, { type: "tool_output_delta" }>,
  incoming: Extract<RunEvent, { type: "tool_output_delta" }>,
): RunEvent {
  const state: CoalescedTextState = {
    kind: "tool_output",
    blocks: [],
    pending: [],
    pendingChars: 0,
    materialized: undefined,
    materializations: 0,
  };
  appendText(state, previous.chunk);
  appendText(state, incoming.chunk);
  const event: Extract<RunEvent, { type: "tool_output_delta" }> = {
    ...incoming,
    at: previous.at,
  };
  Object.defineProperty(event, "chunk", {
    configurable: false,
    enumerable: true,
    get: () => materializeText(state),
    set: (text: string) => replaceText(state, text),
  });
  Object.defineProperty(event, coalescedText, { value: state });
  return event;
}

function appendChunkedEvent(
  previous: RunEvent,
  kind: CoalescedTextState["kind"],
  text: string,
): RunEvent | undefined {
  const state = (previous as CoalescedTextEvent)[coalescedText];
  if (state?.kind !== kind) return undefined;
  appendText(state, text);
  return previous;
}

/** Internal structural diagnostics used to keep coalescing regressions allocation-aware. */
export function inspectCoalescedRunEvent(
  event: RunEvent,
): { blocks: number; pending: number; materializations: number } | undefined {
  const state = (event as CoalescedTextEvent)[coalescedText];
  return state === undefined
    ? undefined
    : {
        blocks: state.blocks.length,
        pending: state.pending.length,
        materializations: state.materializations,
      };
}

/** O(1)-in-history byte accounting for adjacent run-event coalescing. */
export function sizeOfCoalescedRunEvent(
  previous: RunEvent,
  incoming: RunEvent,
  _merged: RunEvent,
  previousBytes: number,
  incomingBytes: number,
): number {
  if (previous.type === "text_delta" && incoming.type === "text_delta") {
    return previousBytes + appendedJsonStringBytes(incoming.text);
  }
  if (previous.type === "tool_output_delta" && incoming.type === "tool_output_delta") {
    return previousBytes + appendedJsonStringBytes(incoming.chunk);
  }
  if (previous.type === "tool_input_delta" && incoming.type === "tool_input_delta") {
    const incomingAt = Buffer.byteLength(JSON.stringify(incoming.at), "utf8");
    const previousAt = Buffer.byteLength(JSON.stringify(previous.at), "utf8");
    return incomingBytes - incomingAt + previousAt;
  }
  return sizeOfRunEvent(_merged);
}

/**
 * Whether two streamed events carry the same attribution, so merging them would
 * not fuse two agents' output into one.
 */
function sameAgent(
  prev: { agent: string; subagent_id?: string },
  next: { agent: string; subagent_id?: string },
): boolean {
  return prev.agent === next.agent && prev.subagent_id === next.subagent_id;
}

/**
 * Merge adjacent run events that are slices of one logical stream, so a consumer
 * that falls behind loses event *count* but never characters.
 *
 * @param prev - the event currently at the buffer tail.
 * @param next - the event being pushed.
 * @returns the merged event, or `undefined` when the two must stay separate.
 * @remarks Only `text_delta` (same `iteration` and `channel`),
 *   `tool_output_delta` (same `call_id`) and `tool_input_delta` (same
 *   `call_id`) merge, and only when attribution matches. A `next.reset` of
 *   `true` means "replace, don't append" and never merges into the text it
 *   would replace.
 *
 *   The two content deltas retain bounded chunks and expose their concatenated
 *   wire value lazily. This avoids copying the full prefix for every provider
 *   token while preserving an ordinary enumerable `text`/`chunk` property.
 *   `tool_input_delta` merges by **replacement**, because its `chars` is the
 *   cumulative size of the argument payload rather than a slice of it.
 */
export const coalesceRunEvents: Coalescer<RunEvent> = (prev, next) => {
  if (prev.type !== next.type) return undefined;
  const coalescing = RUN_EVENT_POLICY[next.type].coalesce;
  if (coalescing === "text_delta" && next.type === "text_delta" && prev.type === "text_delta") {
    if (next.reset) return undefined;
    if (!sameAgent(prev, next)) return undefined;
    if (prev.iteration !== next.iteration || prev.channel !== next.channel) return undefined;
    return appendChunkedEvent(prev, "text", next.text) ?? chunkedTextDelta(prev, next);
  }
  if (
    coalescing === "tool_output_delta" &&
    next.type === "tool_output_delta" &&
    prev.type === "tool_output_delta"
  ) {
    if (!sameAgent(prev, next)) return undefined;
    if (prev.call_id !== next.call_id) return undefined;
    return (
      appendChunkedEvent(prev, "tool_output", next.chunk) ?? chunkedToolOutputDelta(prev, next)
    );
  }
  if (
    coalescing === "tool_input_delta" &&
    next.type === "tool_input_delta" &&
    prev.type === "tool_input_delta"
  ) {
    if (!sameAgent(prev, next)) return undefined;
    if (prev.call_id !== next.call_id) return undefined;
    return { ...next, at: prev.at };
  }
  return undefined;
};

/**
 * Whether an event may be discarded when the buffer is full.
 *
 * @param event - the candidate event.
 * @returns `true` only for the two live delta variants, whose authoritative
 *   content arrives regardless — `tool_output_delta` in the closing `tool_call`,
 *   `text_delta` in `iteration_completed.response`. Everything structural
 *   (tool calls, plan events, elicitations, `memory_ingest`, `run_ended`) is
 *   always retained.
 */
export function isDroppableRunEvent(event: RunEvent): boolean {
  return RUN_EVENT_POLICY[event.type].droppable;
}
