import type { ElicitationRelay, ElicitationRelayResult } from "@clarvis/mcp-client";
import { ElicitTimeoutError, type Elicit, type ElicitParams } from "./tools/ask-user-tool.ts";
import { combineSignals } from "./support/signals.ts";
import type { ClockHolder, TracePort } from "@clarvis/capability";

/**
 * Build a serializer that runs queued jobs one at a time in FIFO order, so no
 * two elicitations are ever presented to the user concurrently.
 *
 * @returns a function that chains each `job` after the previous one settles
 *   (regardless of whether it resolved or rejected) and returns that job's own
 *   promise.
 */
export function createElicitSerializer(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * The two elicitation surfaces built from one user-facing `elicit`: the
 * `serializedElicit` the built-in `ask_user` tool calls, and the `relay` that
 * MCP servers use to request elicitation, both funneled through one serializer
 * so they never overlap.
 *
 * @remarks Either field is `undefined` when elicitation is disabled or no
 *   `elicit` was supplied; in that case `serializedElicit` falls back to the raw
 *   `elicit` (possibly `undefined`) and `relay` is `undefined`.
 */
export interface ElicitRelayBundle {
  serializedElicit: Elicit | undefined;
  relay: ElicitationRelay | undefined;
}

/**
 * Wire the run's single user elicitation channel into the two surfaces that
 * consume it, sharing one FIFO serializer so a tool prompt and an MCP prompt are
 * never live at once.
 *
 * @param input.elicit - the underlying user-elicitation function, or `undefined`
 *   when none is available.
 * @param input.signal - the run's cancel signal, combined with the clock holder's
 *   signal and any per-request incoming signal for relayed calls.
 * @param input.clockHolder - source of the live compute clock; a relayed
 *   elicitation pauses compute while waiting on the human and resumes on
 *   completion.
 * @param input.trace - records an `elicitation_requested` entry (`source:
 *   "tool_relay"`) for each relayed request.
 * @param input.enabled - master switch; when false, no relay is built and
 *   `serializedElicit` is the raw `elicit`.
 * @param input.elicitWaitMs - the per-request timeout passed to `elicit`; a
 *   {@link ElicitTimeoutError} from a relayed call is mapped to a `decline`
 *   action rather than propagated.
 * @returns the {@link ElicitRelayBundle}.
 */
export function buildElicitRelay(input: {
  elicit?: Elicit;
  signal?: AbortSignal;
  clockHolder: ClockHolder;
  trace: TracePort;
  enabled: boolean;
  elicitWaitMs: number;
}): ElicitRelayBundle {
  const { elicit, signal, clockHolder, trace, enabled, elicitWaitMs } = input;
  const relayEnabled = enabled && elicit !== undefined;
  const serialize = relayEnabled ? createElicitSerializer() : undefined;
  const serializedElicit: Elicit | undefined =
    serialize && elicit
      ? (params, opts): Promise<Awaited<ReturnType<Elicit>>> =>
          serialize(() => elicit(params, opts))
      : elicit;
  const relay: ElicitationRelay | undefined =
    relayEnabled && serialize && elicit
      ? {
          handle: (params, incomingSignal): Promise<ElicitationRelayResult> =>
            serialize(async () => {
              const clock = clockHolder.clock;
              const releaseCompute = clock?.pauseCompute();
              try {
                const combined = combineSignals(clockHolder.signal ?? signal, incomingSignal);
                const elicitParams = params as unknown as ElicitParams;
                trace.record("elicitation_requested", {
                  source: "tool_relay",
                  question: typeof elicitParams.message === "string" ? elicitParams.message : "",
                });
                const raw = await elicit(elicitParams, {
                  ...(combined ? { signal: combined } : {}),
                  timeoutMs: elicitWaitMs,
                });
                return { action: raw.action, content: raw.content };
              } catch (err) {
                if (err instanceof ElicitTimeoutError) {
                  return { action: "decline" as const };
                }
                throw err;
              } finally {
                releaseCompute?.();
              }
            }),
        }
      : undefined;
  return { serializedElicit, relay };
}
