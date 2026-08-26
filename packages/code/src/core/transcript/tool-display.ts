import type { TranscriptToolNode } from "./types.ts";
import { TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS } from "./presenters.ts";

/** Maximum live-render characters retained for each independent tool payload field. */
export const TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS = 64 * 1024;

/** Honest recovery route when a persisted tool body is larger than the live renderer admits. */
export const TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE =
  "Tool display shortened to keep the terminal responsive. Use /export to inspect the persisted transcript.";

const ARGUMENT_VALUE_CHARS_BUDGET = 40 * 1024;
const ARGUMENT_NODE_BUDGET = 512;
const ARGUMENT_DEPTH_BUDGET = 16;
const ARGUMENT_KEY_CHARS_MAX = 512;
const INLINE_SHORTENED_NOTICE = "... [shortened]";
const OMITTED_VALUE = "[... omitted from live display ...]";
/** Parentheses plus the bounded one-line tool signature mounted above a body. */
const TOOL_SIGNATURE_TEXT_MAX_CHARS = 74;

interface ArgumentProjectionState {
  remainingChars: number;
  nodes: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

/** Bounded, renderer-safe projection of one transcript tool call. */
export interface TranscriptToolDisplayProjection {
  arguments: Record<string, unknown>;
  argumentsText: string;
  hasArguments: boolean;
  result: string;
  diff?: string;
  error: string | null;
  /** Conservative text mounted by the resolved renderer, including curated argument-derived output. */
  mountedTextChars: number;
  truncated: boolean;
}

interface CachedProjection {
  args: Record<string, unknown> | undefined;
  result: string | undefined;
  diff: string | undefined;
  error: string | null | undefined;
  projection: TranscriptToolDisplayProjection;
}

const projectionCache = new WeakMap<object, CachedProjection>();

function capDisplayField(value: string): { text: string; truncated: boolean } {
  const truncated = value.length > TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS;
  return {
    text: truncated ? value.slice(0, TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS) : value,
    truncated,
  };
}

function projectString(value: string, state: ArgumentProjectionState): string {
  if (value.length <= state.remainingChars) {
    state.remainingChars -= value.length;
    return value;
  }
  state.truncated = true;
  const prefixChars = Math.max(0, state.remainingChars - INLINE_SHORTENED_NOTICE.length);
  const projected = value.slice(0, prefixChars) + INLINE_SHORTENED_NOTICE;
  state.remainingChars = 0;
  return projected;
}

function uniqueProjectedKey(target: Record<string, unknown>, source: string): string {
  const base =
    source.length <= ARGUMENT_KEY_CHARS_MAX
      ? source
      : source.slice(0, ARGUMENT_KEY_CHARS_MAX - INLINE_SHORTENED_NOTICE.length) +
        INLINE_SHORTENED_NOTICE;
  if (!Object.hasOwn(target, base)) return base;
  let suffix = 2;
  while (Object.hasOwn(target, `${base}#${suffix}`)) suffix += 1;
  return `${base}#${suffix}`;
}

/**
 * Project one argument value into the bounded shape the transcript renders.
 *
 * @remarks `state.seen` tracks the current *path*, not every object visited, so
 * it is unwound on the way back out. Left un-unwound it flagged an ordinary
 * shared reference — the same options object named by two keys — as
 * `[circular value omitted]` and raised the "display shortened" banner on a call
 * that was nothing of the sort.
 */
function projectArgumentValue(
  value: unknown,
  state: ArgumentProjectionState,
  depth: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > ARGUMENT_NODE_BUDGET || depth > ARGUMENT_DEPTH_BUDGET) {
    state.truncated = true;
    return OMITTED_VALUE;
  }
  if (typeof value === "string") return projectString(value, state);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return projectString(String(value), state);
  if (typeof value !== "object") return null;
  if (state.seen.has(value)) {
    state.truncated = true;
    return "[circular value omitted]";
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.nodes >= ARGUMENT_NODE_BUDGET || state.remainingChars === 0) {
        state.truncated = true;
        projected.push(OMITTED_VALUE);
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      projected.push(
        descriptor !== undefined && "value" in descriptor
          ? projectArgumentValue(descriptor.value, state, depth + 1)
          : null,
      );
    }
    state.seen.delete(value);
    return projected;
  }

  const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const sourceKey in value) {
    if (!Object.prototype.hasOwnProperty.call(value, sourceKey)) continue;
    if (state.nodes >= ARGUMENT_NODE_BUDGET || state.remainingChars === 0) {
      state.truncated = true;
      projected[OMITTED_VALUE] = OMITTED_VALUE;
      break;
    }
    const key = uniqueProjectedKey(projected, sourceKey);
    if (key !== sourceKey) state.truncated = true;
    state.remainingChars = Math.max(0, state.remainingChars - key.length);
    const descriptor = Object.getOwnPropertyDescriptor(value, sourceKey);
    projected[key] =
      descriptor !== undefined && "value" in descriptor
        ? projectArgumentValue(descriptor.value, state, depth + 1)
        : "[accessor omitted]";
    if (descriptor === undefined || !("value" in descriptor)) state.truncated = true;
  }
  state.seen.delete(value);
  return projected;
}

function projectArguments(args: Record<string, unknown> | undefined): {
  value: Record<string, unknown>;
  text: string;
  hasArguments: boolean;
  truncated: boolean;
} {
  if (args === undefined) return { value: {}, text: "", hasArguments: false, truncated: false };
  let hasArguments = false;
  for (const key in args) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      hasArguments = true;
      break;
    }
  }
  if (!hasArguments) return { value: {}, text: "", hasArguments: false, truncated: false };

  const state: ArgumentProjectionState = {
    remainingChars: ARGUMENT_VALUE_CHARS_BUDGET,
    nodes: 0,
    truncated: false,
    seen: new WeakSet<object>(),
  };
  const value = projectArgumentValue(args, state, 0);
  const projected =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  const serialized = JSON.stringify(projected, null, 2);
  const capped = capDisplayField(serialized);
  return {
    value: projected,
    text: capped.text,
    hasArguments: true,
    truncated: state.truncated || capped.truncated,
  };
}

function projectField(value: string | undefined | null): { text: string; truncated: boolean } {
  if (value === undefined || value === null) return { text: "", truncated: false };
  return capDisplayField(value);
}

/**
 * Project a hydrated tool call into the only payload shape live renderers may inspect.
 *
 * The persisted node remains complete for export. Each independent string is capped,
 * argument traversal is bounded before serialization, and the result is cached by
 * the node's payload identities so transcript paging and block rendering share it.
 */
export function projectTranscriptToolDisplay(
  node: TranscriptToolNode,
  sourceArguments: Record<string, unknown> | undefined = node.args,
): TranscriptToolDisplayProjection {
  const cached = projectionCache.get(node);
  if (
    cached !== undefined &&
    cached.args === sourceArguments &&
    cached.result === node.result &&
    cached.diff === node.diff &&
    cached.error === node.error
  ) {
    return cached.projection;
  }

  const args = projectArguments(sourceArguments);
  const result = projectField(node.result);
  const diff = projectField(node.diff);
  const error = projectField(node.error);
  const mountedTextChars = Math.min(
    TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS,
    args.text.length +
      Math.min(args.text.length, TOOL_SIGNATURE_TEXT_MAX_CHARS) +
      result.text.length +
      diff.text.length +
      error.text.length +
      (args.truncated || result.truncated || diff.truncated || error.truncated
        ? TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE.length
        : 0),
  );
  const projection: TranscriptToolDisplayProjection = {
    arguments: args.value,
    argumentsText: args.text,
    hasArguments: args.hasArguments,
    result: result.text,
    ...(node.diff === undefined ? {} : { diff: diff.text }),
    error: node.error === undefined || node.error === null ? null : error.text,
    mountedTextChars,
    truncated: args.truncated || result.truncated || diff.truncated || error.truncated,
  };
  projectionCache.set(node, {
    args: sourceArguments,
    result: node.result,
    diff: node.diff,
    error: node.error,
    projection,
  });
  return projection;
}

/** Text the tool block can mount, including its bounded running tail and hydration notice. */
export function transcriptToolMountedTextChars(
  node: TranscriptToolNode,
  sourceArguments: Record<string, unknown> | undefined = node.args,
): number {
  const projection = projectTranscriptToolDisplay(node, sourceArguments);
  return Math.min(
    TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS,
    projection.mountedTextChars +
      (node.liveOutput?.length ?? 0) +
      (node.hydrationNotice?.length ?? 0),
  );
}
