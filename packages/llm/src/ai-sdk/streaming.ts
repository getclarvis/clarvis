import type { LLMCallParams } from "@clarvis/capability";
import { streamMetrics } from "../stream-metrics.ts";

type StreamDeltaSink = NonNullable<LLMCallParams["onStreamDelta"]>;
type DeltaChannel = "text" | "reasoning";

/**
 * How hard the batcher squeezes the provider's token stream before the UI sees
 * it. Flush rate is roughly `max(charsPerSecond / maxChars, 1000 / maxMs)`, so
 * these two numbers are the only lever on how often the terminal re-lays-out a
 * streaming block — and re-laying out a Markdown block mid-token is what reads
 * as flicker.
 *
 * `maxMs` alone caps the rate at ~15/s; `maxChars` keeps a very fast stream
 * (~6000 chars/s) from beating that cap. Together they hold the UI under the
 * ~20 updates/s target without making the text arrive in visibly late chunks.
 * Raising them further buys nothing and costs perceived latency.
 */
const DELTA_BATCH = { maxChars: 384, maxMs: 64 };

/**
 * Coalesces raw provider deltas into batches before handing them to the UI
 * sink. Flushes when the buffer reaches `maxChars`, when `maxMs` have elapsed
 * since the last flush, or when `maxMs` pass with no further delta at all — so
 * a fast stream batches into ~one frame per flush while a slow stream still
 * surfaces each token promptly. A channel switch forces a flush so text and
 * reasoning never bleed together. `reset` is set on the first batch of each
 * channel, marking a fresh stream.
 *
 * @remarks The idle timer is the difference between a time *threshold* and a
 * time *deadline*. Both thresholds used to be evaluated only inside `push`,
 * which makes them a stale-check performed by the next delta: with no next
 * delta they are never evaluated at all. That is not hypothetical — the
 * provider stops sending text the moment it starts emitting tool-call
 * arguments, and generating those takes tens of seconds, so the tail of the
 * last sentence sat in `buf` until the whole stream drained. At the ~95 chars/s
 * a real run streams at, a 64 ms window holds about six characters, which is
 * why the symptom was an assistant message frozen mid-word rather than a
 * visibly missing paragraph.
 *
 * The timer is `unref`'d where the runtime supports it: it must never be the
 * reason a process stays alive, and it never needs to be — the caller's final
 * `flush()` is what guarantees delivery.
 */
export function makeDeltaBatcher(
  sink: StreamDeltaSink,
  { maxChars, maxMs }: { maxChars: number; maxMs: number } = DELTA_BATCH,
): {
  push: (channel: DeltaChannel, text: string) => void;
  flush: () => void;
  dispose: () => void;
  emitted: () => boolean;
} {
  let buf = "";
  let channel: DeltaChannel | undefined;
  let lastFlush = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let sinkError: unknown;
  const started = new Set<DeltaChannel>();
  const metrics = streamMetrics();
  const disarm = (): void => {
    if (idle === undefined) return;
    clearTimeout(idle);
    idle = undefined;
  };
  const flush = (): void => {
    disarm();
    if (sinkError !== undefined) {
      throw sinkError instanceof Error
        ? sinkError
        : new Error("Stream delta sink failed.", { cause: sinkError });
    }
    if (buf.length === 0 || channel === undefined) return;
    const reset = !started.has(channel);
    started.add(channel);
    metrics.count(`batcher_flush_${channel}`);
    const text = buf;
    buf = "";
    lastFlush = Date.now();
    try {
      sink({ channel, text, reset });
    } catch (error) {
      sinkError = error;
      throw error;
    }
  };
  const arm = (): void => {
    if (idle !== undefined) return;
    idle = setTimeout(() => {
      try {
        flush();
      } catch (error) {
        sinkError ??= error;
      }
    }, maxMs);
    (idle as { unref?: () => void }).unref?.();
  };
  const push = (ch: DeltaChannel, text: string): void => {
    if (text.length === 0) return;
    metrics.count("provider_delta");
    metrics.count("provider_chars", text.length);
    if (channel !== undefined && ch !== channel) flush();
    channel = ch;
    buf += text;
    if (buf.length >= maxChars || Date.now() - lastFlush >= maxMs) flush();
    else arm();
  };
  return { push, flush, dispose: disarm, emitted: (): boolean => started.size > 0 };
}

/**
 * How often a single in-flight tool call reports its growing argument size.
 *
 * @remarks Deliberately several times slower than {@link DELTA_BATCH}'s `maxMs`,
 * which this was first (wrongly) matched to. Prose deltas *append* — nothing
 * already drawn changes, so 64 ms reads as smooth. A size counter *rewrites the
 * same cell*, and at 64 ms it rewrote it ~15 times a second, out of phase with
 * the terminal UI's own 200 ms repaint clock; the result was a visible shimmer
 * on a line that never moved. Nobody reads a growing number faster than a few
 * times a second, so the extra reports bought nothing and cost a repaint each.
 *
 * It is a throttle rather than a batcher: `chars` is cumulative, so a skipped
 * report costs nothing and the next one is complete on its own. Without it a
 * real call reports ~3000 times — one per provider delta at the ~1 ms
 * inter-arrival measured on the wire.
 */
export const TOOL_INPUT_REPORT_MS = 250;

/**
 * Tracks tool calls the provider is streaming the arguments of, and reports
 * their progress to `sink` at a bounded rate.
 *
 * @param sink - the host's tool-input observer.
 * @param maxMs - minimum gap between two reports *for the same call*.
 * @returns handles for the three provider events that bound a tool call's
 *   argument stream.
 *
 * @remarks Keyed by `call_id` because a single completion may compose several
 * tool calls and their deltas interleave; a shared buffer of the kind
 * {@link makeDeltaBatcher} keeps would make them indistinguishable.
 *
 * No idle timer is needed here, unlike in {@link makeDeltaBatcher}: `end`
 * always reports the final size, and because `chars` is cumulative there is no
 * such thing as a stranded tail — the next report supersedes every one before
 * it. A `delta` for an unknown call is ignored rather than inferred, since
 * without its `tool-input-start` there is no tool name to report and naming the
 * call is the whole point of the first event.
 */
export function makeToolInputReporter(
  sink: NonNullable<LLMCallParams["onToolInputDelta"]>,
  maxMs: number = TOOL_INPUT_REPORT_MS,
): {
  start: (callId: string, toolName: string) => void;
  delta: (callId: string, text: string) => void;
  end: (callId: string) => void;
} {
  const open = new Map<string, { toolName: string; chars: number; reportedAt: number }>();
  return {
    start: (callId, toolName): void => {
      open.set(callId, { toolName, chars: 0, reportedAt: Date.now() });
      sink({ call_id: callId, tool_name: toolName, chars: 0 });
    },
    delta: (callId, text): void => {
      const state = open.get(callId);
      if (state === undefined) return;
      state.chars += text.length;
      const now = Date.now();
      if (now - state.reportedAt < maxMs) return;
      state.reportedAt = now;
      sink({ call_id: callId, tool_name: state.toolName, chars: state.chars });
    },
    end: (callId): void => {
      const state = open.get(callId);
      if (state === undefined) return;
      open.delete(callId);
      sink({ call_id: callId, tool_name: state.toolName, chars: state.chars });
    },
  };
}
